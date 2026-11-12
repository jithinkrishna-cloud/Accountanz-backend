import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import type { ListQuery } from "../../utils/pagination.js";
import { recordAudit } from "../audit/audit.service.js";
import * as repo from "./knowledge.repository.js";
import type { ArticleInput } from "./knowledge.validation.js";

export const listArticles = (q: ListQuery) => repo.listArticles(q);

export async function createArticle(actor: AuthUser, input: ArticleInput) {
  const id = await withTransaction(async (conn) => {
    const newId = await repo.insertArticle(input, actor.id, conn);
    await recordAudit(actor, { action: "Article created", entityType: "KnowledgeArticle", entityId: newId, details: input.title }, conn);
    return newId;
  });
  return (await repo.findArticle(id))!;
}

export async function updateArticle(actor: AuthUser, id: number, input: ArticleInput) {
  if (!(await repo.findArticle(id))) throw AppError.notFound("Article");
  await withTransaction(async (conn) => {
    await repo.updateArticle(id, input, actor.id, conn);
    await recordAudit(actor, { action: "Article updated", entityType: "KnowledgeArticle", entityId: id, details: input.title }, conn);
  });
  return (await repo.findArticle(id))!;
}

export async function deleteArticle(actor: AuthUser, id: number) {
  const article = await repo.findArticle(id);
  if (!article) throw AppError.notFound("Article");
  await withTransaction(async (conn) => {
    await repo.deleteArticle(id, conn);
    await recordAudit(actor, { action: "Article deleted", entityType: "KnowledgeArticle", entityId: id, details: article.title }, conn);
  });
}
