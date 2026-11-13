import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import * as repo from "./integration.repository.js";
import type { CreateConnectionInput, IntegrationListQuery, VerifyConnectionInput } from "./integration.validation.js";
import { journlGateway } from "./journl.gateway.js";

const PROVIDER_LABEL = { journl: "JournL" } as const;

export async function listConnections(q: IntegrationListQuery) {
  return { ...(await repo.listConnections(q)), journlApiAvailable: journlGateway.available };
}

export async function createConnection(actor: AuthUser, input: CreateConnectionInput) {
  if (!(await repo.clientExists(input.client_id))) throw AppError.notFound("Client");
  if (await repo.connectionExists(input.client_id, input.provider)) {
    throw AppError.conflict(`This client already has a ${PROVIDER_LABEL[input.provider]} connection`);
  }
  const id = await withTransaction(async (conn) => {
    const newId = await repo.insertConnection(input, conn);
    await repo.setClientSoftware(input.client_id, input.provider, conn);
    await recordAudit(actor, { action: "Integration added", entityType: "IntegrationConnection", entityId: newId, clientId: input.client_id, details: `${PROVIDER_LABEL[input.provider]} ${input.external_org_id ?? ""}`.trim() }, conn);
    return newId;
  });
  return (await repo.findConnection(id))!;
}

/**
 * An admin checked the organisation in JournL by hand (it exists, is active, belongs to this client)
 * and records how. This is an internal check, not proof that JournL authorised API access.
 */
export async function verifyConnection(actor: AuthUser, id: number, input: VerifyConnectionInput) {
  const connection = await repo.findConnection(id);
  if (!connection) throw AppError.notFound("Connection");
  // Connected rows approved by the old health check (no verification recorded) can still be verified.
  if (connection.status === "connected" && connection.verified_at) throw AppError.conflict("This connection is already verified");
  if (connection.status === "disconnected") throw AppError.conflict("The client disconnected this connection; they must reconnect it first");
  if (!connection.external_org_id) throw AppError.conflict("Add the JournL organisation ID before verifying");
  await withTransaction(async (conn) => {
    await repo.recordManualVerification(id, actor.id, input.note, conn);
    await recordAudit(actor, { action: "Integration verified manually", entityType: "IntegrationConnection", entityId: id, clientId: connection.client_id, details: `${PROVIDER_LABEL[connection.provider]} ${connection.external_org_id}: ${input.note}` }, conn);
  });
  return (await repo.findConnection(id))!;
}

/** Asks JournL whether Accountanz holds an active grant for the organisation. Records nothing while the API is unavailable. */
export async function runHealthCheck(actor: AuthUser, id: number) {
  const connection = await repo.findConnection(id);
  if (!connection) throw AppError.notFound("Connection");
  if (connection.status === "disconnected") throw AppError.conflict("The client disconnected this connection");
  if (!connection.external_org_id) throw AppError.conflict("This connection has no JournL organisation ID");
  const grant = await journlGateway.getGrant(connection.external_org_id);
  if (grant.kind === "unavailable") throw AppError.conflict(grant.reason);
  const ok = grant.kind === "active";
  await withTransaction(async (conn) => {
    await repo.recordHealthCheck(id, ok ? "connected" : "error", ok ? null : grant.reason, conn);
    await recordAudit(actor, { action: "Integration health check", entityType: "IntegrationConnection", entityId: id, clientId: connection.client_id, details: `${PROVIDER_LABEL[connection.provider]}: ${ok ? "connected" : grant.reason}` }, conn);
  });
  return (await repo.findConnection(id))!;
}
