import { withTransaction } from "../../../database/connection.js";
import type { AuthUser } from "../../../types/auth.types.js";
import { AppError } from "../../../utils/app-error.js";
import { decryptSecret } from "../../../utils/crypto.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../utils/logger.js";
import { requireClientAccess } from "../../access/client-access.js";
import { recordAudit } from "../../audit/audit.service.js";
import type { RequestContext } from "../../audit/journl-read-audit.js";
import type { ClientContext } from "../../client-portal/client-portal.types.js";
import { auditedBizpoleRead } from "./bizpole.audit.js";
import { BizpoleApiError, bizpoleConfigured, getJson, revokeGrant } from "./bizpole.client.js";
import * as repo from "./bizpole.repository.js";
import { accessTokenFor, appErrorFrom, exchangeCode, sealTokens } from "./bizpole.token.service.js";
import {
  BIZPOLE_RESOURCES,
  type BizpoleCompany,
  type BizpoleConnectionRow,
  type BizpoleConnectionView,
  type BizpolePage,
  type BizpoleResource,
  type CompanyChoice,
} from "./bizpole.types.js";
import type { ConnectInput, SelectCompanyInput, StaffQuery } from "./bizpole.validation.js";

/**
 * Bizpole Books partner connection (read-only). The client owner pastes a connection code from Bizpole; Accountanz
 * exchanges it server-side, lists the companies the owner shared and links exactly one to this client. Staff on the
 * client read its books through Accountanz, never directly. Separate from the JournL connection, which is unchanged.
 */

const NOT_SET_UP = "Bizpole Books isn't set up on this server yet.";
/** Paged reads stop after this many pages rather than return a partial list. */
export const MAX_PAGES = 20;

const ownerOnly = (ctx: ClientContext, what: string) => {
  if (ctx.role !== "owner") throw AppError.forbidden(`Only the company owner can ${what} Bizpole Books`);
};

const norm = (g: string | null | undefined) => (g ?? "").trim().toUpperCase() || null;

/** Block when both GSTINs exist and differ; warn when only one side has one. */
export function gstinRule(clientGstin: string | null, companyGstin: string | null): { block: string | null; warning: string | null } {
  const a = norm(clientGstin);
  const b = norm(companyGstin);
  if (a && b && a !== b) {
    return { block: `This Bizpole Books company's GSTIN (${b}) doesn't match this business's GSTIN in Accountanz (${a}). Choose the right company, or ask your team to correct the GSTIN.`, warning: null };
  }
  if (a && !b) return { block: null, warning: `The Bizpole Books company has no GSTIN; this business's GSTIN in Accountanz is ${a}.` };
  if (!a && b) return { block: null, warning: `This business has no GSTIN in Accountanz; the Bizpole Books company's GSTIN is ${b}.` };
  return { block: null, warning: null };
}

const choicesOf = (row: Pick<BizpoleConnectionRow, "available_companies">): CompanyChoice[] => {
  const v = row.available_companies;
  if (!v) return [];
  try {
    const list = typeof v === "string" ? (JSON.parse(v) as CompanyChoice[]) : v;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

/** The owner's view: status and company details only. Never tokens or the grant id. */
export async function view(clientId: number): Promise<BizpoleConnectionView> {
  const row = await repo.findByClient(clientId);
  if (!row) return { available: bizpoleConfigured(), connection: null };
  const warning = row.status === "connected" ? gstinRule(await repo.clientGstin(clientId), row.external_gstin).warning : null;
  return {
    available: bizpoleConfigured(),
    connection: {
      status: row.status,
      company_id: row.external_org_id,
      company_name: row.external_org_name,
      gstin: row.external_gstin,
      connected_at: row.authorized_at,
      last_checked_at: row.last_health_check,
      last_error: row.status === "connected" ? null : row.last_error,
      companies: row.status === "pending" ? choicesOf(row) : [],
      gstin_warning: warning,
    },
  };
}

/** The stored refresh token in clear, or null when there is none or it can't be read. */
function openRefreshToken(row: Pick<BizpoleConnectionRow, "refresh_token_enc">): string | null {
  if (!row.refresh_token_enc || !env.BIZPOLE_TOKEN_KEY) return null;
  try {
    return decryptSecret(row.refresh_token_enc, env.BIZPOLE_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Best-effort revoke of a grant Accountanz obtained but won't keep (so it doesn't linger in Bizpole). */
async function discardGrant(refreshToken: string) {
  if (!(await revokeGrant(refreshToken))) logger.warn("A Bizpole grant that Accountanz discarded could not be revoked; the owner can revoke it in Bizpole");
}

/** Step 1: exchange the owner's connection code. One shared company connects at once; several wait for a choice. */
export async function connect(actor: AuthUser, ctx: ClientContext, input: ConnectInput): Promise<BizpoleConnectionView> {
  ownerOnly(ctx, "connect");
  if (!bizpoleConfigured()) throw new AppError("UNAVAILABLE", NOT_SET_UP);

  // Don't spend the (single-use) code if this client is already linked.
  const before = await repo.findByClient(ctx.clientId);
  if (before && (before.status === "connected" || before.status === "pending")) {
    throw AppError.conflict("Bizpole Books is already connected for your company. Disconnect it before connecting again.");
  }

  const t = await exchangeCode(input.code);
  try {
    let listed: BizpoleCompany[];
    try {
      listed = (await getJson<{ data: BizpoleCompany[] }>(t.access_token, `grant:${t.grant_id}`, "companies")).data ?? [];
    } catch (err) {
      throw appErrorFrom(err);
    }
    const shared = new Set(t.companies.map(String));
    const companies: CompanyChoice[] = listed.filter((c) => shared.has(String(c.id))).map((c) => ({ id: String(c.id), name: c.name, gstin: c.gstin ?? null }));
    if (companies.length === 0) throw AppError.conflict("This connection code doesn't share any company. Create a new code in Bizpole Books and choose your company.");

    const sealed = sealTokens(t);
    const clientGstin = await repo.clientGstin(ctx.clientId);
    const replaced = await withTransaction(async (conn) => {
      const row = await repo.lockByClient(ctx.clientId, conn);
      if (row && (row.status === "connected" || row.status === "pending")) {
        throw AppError.conflict("Bizpole Books is already connected for your company. Disconnect it before connecting again.");
      }
      // An 'error' row may still hold a live grant: it is replaced below, so revoke it after the commit.
      const previous = row?.status === "error" ? openRefreshToken(row) : null;
      if (companies.length === 1) {
        const company = companies[0]!;
        const rule = gstinRule(clientGstin, company.gstin);
        if (rule.block) throw AppError.conflict(rule.block);
        if (await repo.companyTakenBy(company.id, ctx.clientId, conn)) throw AppError.conflict("This Bizpole Books company is already connected to another Accountanz client.");
        const id = await repo.saveNewGrant(ctx.clientId, row?.id ?? null, sealed, { status: "connected", company }, actor.id, conn);
        await recordAudit(actor, { action: "Bizpole Books connected", entityType: "IntegrationConnection", entityId: id, clientId: ctx.clientId, details: `Company ${company.id} (${company.name})` }, conn);
      } else {
        const id = await repo.saveNewGrant(ctx.clientId, row?.id ?? null, sealed, { status: "pending", companies }, actor.id, conn);
        await recordAudit(actor, { action: "Bizpole Books awaiting company choice", entityType: "IntegrationConnection", entityId: id, clientId: ctx.clientId, details: `${companies.length} companies shared` }, conn);
      }
      return previous;
    });
    if (replaced) await discardGrant(replaced);
  } catch (err) {
    // Anything that stops the link after the exchange: give the grant back so it doesn't linger in Bizpole.
    await discardGrant(t.refresh_token);
    throw err;
  }
  return view(ctx.clientId);
}

/** Step 2 (several companies shared): the owner picks one. It must be one of the grant's companies. */
export async function selectCompany(actor: AuthUser, ctx: ClientContext, input: SelectCompanyInput): Promise<BizpoleConnectionView> {
  ownerOnly(ctx, "connect");
  const clientGstin = await repo.clientGstin(ctx.clientId);
  await withTransaction(async (conn) => {
    const row = await repo.lockByClient(ctx.clientId, conn);
    if (!row || row.status !== "pending") throw AppError.conflict("There's no Bizpole Books connection waiting for a company choice.");
    const company = choicesOf(row).find((c) => c.id === input.company_id);
    if (!company) throw new AppError("VALIDATION_ERROR", "That company isn't one you shared in this connection code", { fieldErrors: { company_id: ["Not shared in this connection"] } });
    const rule = gstinRule(clientGstin, company.gstin);
    if (rule.block) throw AppError.conflict(rule.block);
    if (await repo.companyTakenBy(company.id, ctx.clientId, conn)) throw AppError.conflict("This Bizpole Books company is already connected to another Accountanz client.");
    await repo.setCompany(row.id, company, conn);
    await recordAudit(actor, { action: "Bizpole Books connected", entityType: "IntegrationConnection", entityId: row.id, clientId: ctx.clientId, details: `Company ${company.id} (${company.name})` }, conn);
  });
  return view(ctx.clientId);
}

/** The owner disconnects: Accountanz drops its tokens and asks Bizpole to revoke the grant (POST /auth/revoke). */
export async function disconnect(actor: AuthUser, ctx: ClientContext): Promise<BizpoleConnectionView & { revoked_at_bizpole: boolean }> {
  ownerOnly(ctx, "disconnect");
  const { token, alreadyEnded } = await withTransaction(async (conn) => {
    // Under the row lock, so no refresh can rotate the token between reading it and marking the row.
    const row = await repo.lockByClient(ctx.clientId, conn);
    if (!row || row.status === "disconnected") throw AppError.conflict("Bizpole Books is not connected for your company.");
    const refresh = openRefreshToken(row);
    await repo.markDisconnected(row.id, conn);
    await recordAudit(actor, { action: "Bizpole Books disconnected", entityType: "IntegrationConnection", entityId: row.id, clientId: ctx.clientId, details: "Disconnected by the company owner" }, conn);
    return { token: refresh, alreadyEnded: row.status === "revoked" };
  });
  // A revoked grant is already over at Bizpole. Otherwise only a confirmed /auth/revoke counts.
  const revoked = alreadyEnded || (token !== null && bizpoleConfigured() && (await revokeGrant(token)));
  return { ...(await view(ctx.clientId)), revoked_at_bizpole: revoked };
}

/* ---------------- staff reads ---------------- */

async function callWithTokenRetry<T>(connectionId: number, path: string, query: Record<string, string>): Promise<T> {
  const token = await accessTokenFor(connectionId);
  try {
    return await getJson<T>(token, `conn:${connectionId}`, path, query);
  } catch (err) {
    // 401 invalid_token: refresh (unless someone already did) and retry exactly once.
    if (err instanceof BizpoleApiError && err.status === 401 && err.code === "invalid_token") {
      const fresh = await accessTokenFor(connectionId, token);
      return getJson<T>(fresh, `conn:${connectionId}`, path, query);
    }
    throw err;
  }
}

export interface StaffReadResult {
  resource: BizpoleResource;
  company_id: string;
  fetched_at: string;
  /** Paged lists: every row, all pages joined. Single resources (company, totals, stock-valuation): Bizpole's body as sent. */
  data: unknown;
  pages?: number;
}

/**
 * A staff read of one resource for a client they work on. Read-only, audited (one row per read), and scoped to the
 * company linked to this client. Only the parameters Bizpole documents for that resource are passed on.
 */
export async function staffRead(actor: AuthUser, clientId: number, resource: BizpoleResource, rawQuery: StaffQuery, reqCtx: RequestContext): Promise<StaffReadResult> {
  const spec = BIZPOLE_RESOURCES[resource];
  const query: Record<string, string> = {};
  for (const p of spec.params) if (rawQuery[p] !== undefined && rawQuery[p] !== "") query[p] = rawQuery[p]!;
  const details = `${resource}${Object.keys(query).length ? ` ${new URLSearchParams(query).toString()}` : ""}`;

  return auditedBizpoleRead(actor, clientId, reqCtx, resource, details, async () => {
    await requireClientAccess(actor, clientId);
    if (!bizpoleConfigured()) throw new AppError("UNAVAILABLE", NOT_SET_UP);
    const row = await repo.findByClient(clientId);
    if (!row || !row.external_org_id || (row.status !== "connected" && row.status !== "error")) {
      throw AppError.conflict(row?.status === "revoked" ? "Access to Bizpole Books has ended. The client owner needs to reconnect." : "Bizpole Books isn't connected for this client.");
    }
    const base = `companies/${encodeURIComponent(row.external_org_id)}${spec.path ? `/${spec.path}` : ""}`;

    try {
      let result: StaffReadResult;
      if (!spec.paged) {
        result = { resource, company_id: row.external_org_id, fetched_at: new Date().toISOString(), data: await callWithTokenRetry<unknown>(row.id, base, query) };
      } else {
        const rows: unknown[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          if (pages === MAX_PAGES) {
            throw new AppError("VALIDATION_ERROR", `More than ${MAX_PAGES * spec.limit} rows. Narrow the request${(spec.params as readonly string[]).includes("from") ? " with from/to" : ""}.`);
          }
          const page: BizpolePage = await callWithTokenRetry<BizpolePage>(row.id, base, { ...query, limit: String(spec.limit), ...(cursor ? { cursor } : {}) });
          rows.push(...(Array.isArray(page.data) ? page.data : []));
          cursor = page.hasMore && page.nextCursor ? page.nextCursor : null;
          pages++;
        } while (cursor);
        result = { resource, company_id: row.external_org_id, fetched_at: new Date().toISOString(), data: rows, pages };
      }
      await repo.touchHealthy(row.id);
      return result;
    } catch (err) {
      // 404 on a company path: the company is no longer shared with Accountanz (or no longer exists).
      if (err instanceof BizpoleApiError && err.status === 404) await repo.markError(row.id, "Bizpole Books says this company is no longer shared with Accountanz.");
      throw appErrorFrom(err);
    }
  });
}
