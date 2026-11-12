import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import * as repo from "./integration.repository.js";
import type { IntegrationRow } from "./integration.types.js";
import type { CreateConnectionInput, IntegrationListQuery } from "./integration.validation.js";

const PROVIDER_LABEL = { journl: "JournL", zoho_books: "Zoho Books" } as const;

export const listConnections = (q: IntegrationListQuery) => repo.listConnections(q);

export async function createConnection(actor: AuthUser, input: CreateConnectionInput) {
  if (!(await repo.clientExists(input.client_id))) throw AppError.notFound("Client");
  if (await repo.connectionExists(input.client_id, input.provider)) {
    throw AppError.conflict(`This client already has a ${PROVIDER_LABEL[input.provider]} connection`);
  }
  const id = await withTransaction(async (conn) => {
    const newId = await repo.insertConnection(input, conn);
    await recordAudit(actor, { action: "Integration added", entityType: "IntegrationConnection", entityId: newId, clientId: input.client_id, details: `${PROVIDER_LABEL[input.provider]} ${input.external_org_id ?? ""}`.trim() }, conn);
    return newId;
  });
  return (await repo.findConnection(id))!;
}

/**
 * Checks that the client's books are reachable in the provider.
 * Matches the existing app: the check currently marks the connection as connected and records the time.
 * TODO: call the JournL Partner API / Zoho Books API here and record "error" with the provider's message on failure.
 */
async function probeProvider(_connection: IntegrationRow): Promise<{ ok: true } | { ok: false; error: string }> {
  return { ok: true };
}

export async function runHealthCheck(actor: AuthUser, id: number) {
  const connection = await repo.findConnection(id);
  if (!connection) throw AppError.notFound("Connection");
  const result = await probeProvider(connection);
  await withTransaction(async (conn) => {
    await repo.recordHealthCheck(id, result.ok ? "connected" : "error", result.ok ? null : result.error, conn);
    await recordAudit(actor, { action: "Integration health check", entityType: "IntegrationConnection", entityId: id, clientId: connection.client_id, details: `${PROVIDER_LABEL[connection.provider]}: ${result.ok ? "connected" : result.error}` }, conn);
  });
  return (await repo.findConnection(id))!;
}
