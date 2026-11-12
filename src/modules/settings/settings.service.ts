import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { recordAudit } from "../audit/audit.service.js";
import * as repo from "./settings.repository.js";
import type { UpdateSettingsInput } from "./settings.validation.js";

export const getSettings = () => repo.getSettings();

export async function updateSettings(actor: AuthUser, input: UpdateSettingsInput) {
  await withTransaction(async (conn) => {
    await repo.updateSettings(input, conn);
    await recordAudit(actor, { action: "Settings updated", entityType: "AppSetting", entityId: 1, details: Object.keys(input).join(", ") }, conn);
  });
  return repo.getSettings();
}
