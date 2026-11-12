import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import * as repo from "./service.repository.js";
import type { ServiceInput, ServiceUpdateInput } from "./service.validation.js";

export const listServices = () => repo.listServices();

async function assertCodeFree(code: string | undefined, exceptId?: number) {
  if (!code) return;
  const existing = await repo.findServiceByCode(code);
  if (existing && existing.id !== exceptId) throw AppError.conflict(`Service code ${code} is already in use`);
}

export async function createService(actor: AuthUser, input: ServiceInput) {
  await assertCodeFree(input.code);
  const id = await withTransaction(async (conn) => {
    const newId = await repo.insertService(input, conn);
    await recordAudit(actor, { action: "Service created", entityType: "Service", entityId: newId, details: `${input.code} · ${input.name}` }, conn);
    return newId;
  });
  return (await repo.findServiceById(id))!;
}

export async function updateService(actor: AuthUser, id: number, input: ServiceUpdateInput) {
  const before = await repo.findServiceById(id);
  if (!before) throw AppError.notFound("Service");
  await assertCodeFree(input.code, id);
  await withTransaction(async (conn) => {
    await repo.updateService(id, input, conn);
    await recordAudit(actor, { action: "Service updated", entityType: "Service", entityId: id, details: input.name ?? before.name }, conn);
  });
  return (await repo.findServiceById(id))!;
}
