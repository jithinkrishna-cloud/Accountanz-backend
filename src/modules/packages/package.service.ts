import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import { countExistingServices } from "../services/service.repository.js";
import * as repo from "./package.repository.js";
import type { PackageInput, PackageUpdateInput } from "./package.validation.js";

export const listPackages = () => repo.listPackages();

async function assertServicesExist(ids: number[] | undefined) {
  if (!ids) return;
  if ((await countExistingServices(ids)) !== ids.length) {
    throw new AppError("VALIDATION_ERROR", "One or more selected services no longer exist");
  }
}

export async function createPackage(actor: AuthUser, input: PackageInput) {
  await assertServicesExist(input.service_ids);
  const id = await withTransaction(async (conn) => {
    const newId = await repo.insertPackage(input, conn);
    await repo.replacePackageServices(newId, input.service_ids, conn);
    await recordAudit(actor, { action: "Package created", entityType: "Package", entityId: newId, details: input.name }, conn);
    return newId;
  });
  return (await repo.findPackageById(id))!;
}

export async function updatePackage(actor: AuthUser, id: number, input: PackageUpdateInput) {
  const before = await repo.findPackageById(id);
  if (!before) throw AppError.notFound("Package");
  await assertServicesExist(input.service_ids);
  await withTransaction(async (conn) => {
    await repo.updatePackage(id, input, conn);
    if (input.service_ids) await repo.replacePackageServices(id, input.service_ids, conn);
    await recordAudit(actor, { action: "Package updated", entityType: "Package", entityId: id, details: input.name ?? before.name }, conn);
  });
  return (await repo.findPackageById(id))!;
}
