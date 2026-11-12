import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type ListQuery, type Paged } from "../../utils/pagination.js";
import type { ArticleRow } from "./knowledge.types.js";
import type { ArticleInput } from "./knowledge.validation.js";

const SELECT = `
  SELECT a.id, a.title, a.category, a.summary, a.body, u.email AS updated_by_email, a.updated_at
    FROM knowledge_articles a LEFT JOIN users u ON u.id = a.updated_by`;

export async function listArticles(q: ListQuery): Promise<Paged<ArticleRow>> {
  const params: Param[] = [];
  let whereSql = "";
  if (q.q) {
    whereSql = "WHERE a.title LIKE ? OR a.category LIKE ? OR a.summary LIKE ?";
    params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  const items = await query<ArticleRow>(`${SELECT} ${whereSql} ORDER BY a.updated_at DESC, a.id DESC LIMIT ? OFFSET ?`, [...params, q.pageSize, offsetOf(q)]);
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM knowledge_articles a ${whereSql}`, params);
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

export const findArticle = (id: number) => queryOne<ArticleRow>(`${SELECT} WHERE a.id = ?`, [id]);

export async function insertArticle(a: ArticleInput, userId: number, conn: PoolConnection) {
  const r = await execute(
    `INSERT INTO knowledge_articles (title, category, summary, body, updated_by) VALUES (?, ?, ?, ?, ?)`,
    [a.title, a.category, a.summary, a.body, userId],
    conn,
  );
  return r.insertId;
}

export async function updateArticle(id: number, a: ArticleInput, userId: number, conn: PoolConnection) {
  await execute(`UPDATE knowledge_articles SET title = ?, category = ?, summary = ?, body = ?, updated_by = ? WHERE id = ?`, [a.title, a.category, a.summary, a.body, userId, id], conn);
}

export async function deleteArticle(id: number, conn: PoolConnection) {
  await execute(`DELETE FROM knowledge_articles WHERE id = ?`, [id], conn);
}
