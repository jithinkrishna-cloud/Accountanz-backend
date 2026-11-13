import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

/**
 * The one place Accountanz talks to JournL.
 *
 * - `signIn`: the client owner proves they own a JournL company by signing in with their JournL login.
 *   Accountanz forwards the email and password once to JournL's own `POST /auth/login` and never stores
 *   them. JournL issues the session, so the company it returns is JournL's answer, not the owner's claim.
 * - `getGrant`: a lasting "may Accountanz still access this company?" check. JournL has no partner API
 *   (no grant or refreshable token; its login token expires after 8h), so this answers "unavailable"
 *   and the admin "Check with JournL" button stays hidden.
 */
export type GrantResult =
  | { kind: "active"; companyName: string }
  | { kind: "failed"; reason: string }
  | { kind: "unavailable"; reason: string };

export interface JournlCompany {
  id: string;
  name: string;
  email: string | null;
}

/** JournL's own login token (JWT, about 8h) and when it expires. Used only for GET requests. */
export interface JournlSession {
  token: string;
  expiresAt: Date;
}

export type SignInResult =
  | { kind: "ok"; journlUserName: string; journlEmail: string; companies: JournlCompany[]; session: JournlSession | null }
  | { kind: "rejected"; reason: string; field?: "journl_email" | "journl_password" }
  | { kind: "unavailable"; reason: string };

export interface JournlGateway {
  /** False until JournL ships a partner API; the admin UI hides "Check with JournL" while false. */
  available: boolean;
  /** True when JOURNL_API_URL is set, so owners can sign in with JournL. */
  signInAvailable: boolean;
  getGrant(externalOrgId: string): Promise<GrantResult>;
  signIn(email: string, password: string): Promise<SignInResult>;
}

const UNAVAILABLE = "JournL can't be reached right now. Please try again in a few minutes.";
const TIMEOUT_MS = 15_000;

interface JournlLoginAccount {
  token?: string;
  name?: string;
  email?: string;
  role?: string;
  companyDetails?: { id?: number; name?: string; email?: string | null; isDeleted?: number }[];
}
interface JournlLoginResponse {
  success?: boolean;
  message?: string;
  code?: string;
  data?: JournlLoginAccount[];
}

/** Reads the expiry from JournL's JWT (not verified: JournL holds the key and checks it on every request). */
function sessionFrom(token: string | undefined): JournlSession | null {
  if (!token) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number };
    return payload.exp ? { token, expiresAt: new Date(payload.exp * 1000) } : null;
  } catch {
    return null;
  }
}

async function signIn(email: string, password: string): Promise<SignInResult> {
  if (!env.JOURNL_API_URL) return { kind: "unavailable", reason: "Signing in with JournL isn't set up on this server." };
  const url = new URL("auth/login", env.JOURNL_API_URL.endsWith("/") ? env.JOURNL_API_URL : `${env.JOURNL_API_URL}/`);

  let body: JournlLoginResponse;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 500) {
      logger.warn({ status: res.status }, "JournL login returned a server error");
      return { kind: "unavailable", reason: UNAVAILABLE };
    }
    body = (await res.json()) as JournlLoginResponse;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "JournL login request failed");
    return { kind: "unavailable", reason: UNAVAILABLE };
  }

  if (!body.success) {
    const msg = (body.message ?? "").toLowerCase();
    if (msg.includes("not found")) return { kind: "rejected", field: "journl_email", reason: "No JournL account uses this email" };
    if (msg.includes("password")) return { kind: "rejected", field: "journl_password", reason: "That JournL password is incorrect" };
    if (body.code === "ACCOUNT_DELETED") return { kind: "rejected", reason: "This JournL company has been deleted" };
    return { kind: "rejected", reason: body.message ? `JournL: ${body.message}` : "JournL didn't accept this sign-in" };
  }

  // One email with several JournL accounts: JournL checks the password against only one of them,
  // so the list doesn't prove which companies this person owns.
  if (body.message === "Multiple users found") {
    return { kind: "rejected", field: "journl_email", reason: "This email has several JournL accounts. Sign in with the email of your JournL company account." };
  }

  const account = body.data?.[0];
  if (!account) return { kind: "unavailable", reason: UNAVAILABLE };
  if (account.role !== "company") {
    return { kind: "rejected", field: "journl_email", reason: "Sign in with your JournL company owner account, not a staff login" };
  }
  const companies = (account.companyDetails ?? [])
    .filter((c) => typeof c.id === "number" && !c.isDeleted)
    .map((c) => ({ id: String(c.id), name: c.name?.trim() || `Company ${c.id}`, email: c.email ?? null }));
  if (companies.length === 0) return { kind: "rejected", reason: "This JournL account has no active company" };

  return { kind: "ok", journlUserName: account.name ?? email, journlEmail: account.email ?? email, companies, session: sessionFrom(account.token) };
}

export type ReadResult<T = unknown> = { kind: "ok"; data: T } | { kind: "expired" } | { kind: "failed"; reason: string };

/**
 * Reads from JournL with the owner's session. GET only: this function is the only JournL call besides login,
 * and it has no way to send POST/PUT/PATCH/DELETE, so Accountanz never writes to JournL through it.
 */
export async function journlGet<T = unknown>(token: string, path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<ReadResult<T>> {
  if (!env.JOURNL_API_URL) return { kind: "failed", reason: "JournL isn't set up on this server" };
  const url = new URL(path.replace(/^\//, ""), env.JOURNL_API_URL.endsWith("/") ? env.JOURNL_API_URL : `${env.JOURNL_API_URL}/`);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  try {
    const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401) return { kind: "expired" };
    const body = (await res.json().catch(() => null)) as { success?: boolean; message?: string; data?: T } | null;
    if (!res.ok || !body || body.success === false) {
      return { kind: "failed", reason: body?.message ? `JournL: ${body.message}` : `JournL answered ${res.status}` };
    }
    return { kind: "ok", data: body.data as T };
  } catch (err) {
    logger.warn({ err: (err as Error).message, path }, "JournL read failed");
    return { kind: "failed", reason: UNAVAILABLE };
  }
}

const gateway: JournlGateway = {
  available: false,
  signInAvailable: !!env.JOURNL_API_URL,
  getGrant: async () => ({ kind: "unavailable", reason: "The JournL partner API is not available yet. Check the organisation in JournL and use Mark verified." }),
  signIn,
};

export const journlGateway: JournlGateway = gateway;
