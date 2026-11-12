import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import * as repo from "./task-template.repository.js";
import type { ItemInput, ItemUpdateInput, TemplateInput } from "./task-template.validation.js";

export const listTemplates = () => repo.listTemplates();

export async function createTemplate(actor: AuthUser, input: TemplateInput) {
  if (!(await repo.serviceExists(input.service_id))) throw new AppError("VALIDATION_ERROR", "That service no longer exists");
  const id = await withTransaction(async (conn) => {
    const newId = await repo.insertTemplate(input, conn);
    await recordAudit(actor, { action: "Task template created", entityType: "TaskTemplate", entityId: newId, details: input.name }, conn);
    return newId;
  });
  return { ...(await repo.findTemplateById(id))!, items: [] };
}

export async function addItem(actor: AuthUser, templateId: number, input: ItemInput) {
  const template = await repo.findTemplateById(templateId);
  if (!template) throw AppError.notFound("Template");
  const id = await withTransaction(async (conn) => {
    const newId = await repo.insertItem(templateId, input, conn);
    await recordAudit(actor, { action: "Template item added", entityType: "TaskTemplateItem", entityId: newId, details: `${template.name}: ${input.title}` }, conn);
    return newId;
  });
  return (await repo.findItemById(id))!;
}

export async function updateItem(actor: AuthUser, itemId: number, input: ItemUpdateInput) {
  const before = await repo.findItemById(itemId);
  if (!before) throw AppError.notFound("Template item");
  await withTransaction(async (conn) => {
    await repo.updateItem(itemId, input, conn);
    await recordAudit(actor, { action: "Template item updated", entityType: "TaskTemplateItem", entityId: itemId, details: input.title ?? before.title }, conn);
  });
  return (await repo.findItemById(itemId))!;
}

export async function deleteItem(actor: AuthUser, itemId: number) {
  const before = await repo.findItemById(itemId);
  if (!before) throw AppError.notFound("Template item");
  await withTransaction(async (conn) => {
    await repo.deleteItem(itemId, conn);
    await recordAudit(actor, { action: "Template item deleted", entityType: "TaskTemplateItem", entityId: itemId, details: before.title }, conn);
  });
}
