import type { PoolConnection } from "mysql2/promise";
import { execute, pool, query, queryOne, type Param } from "../../database/connection.js";
import type { TaskTemplateItemRow, TaskTemplateRow, TaskTemplateWithItems } from "./task-template.types.js";
import type { ItemInput, ItemUpdateInput, TemplateInput } from "./task-template.validation.js";

type Db = PoolConnection | typeof pool;

const TEMPLATE_SELECT = `
  SELECT tt.id, tt.service_id, s.name AS service_name, tt.name, tt.recurrence, tt.due_day_of_period
    FROM task_templates tt JOIN services s ON s.id = tt.service_id`;

const normalizeItem = (r: TaskTemplateItemRow & { client_visible: unknown }): TaskTemplateItemRow => ({ ...r, client_visible: Boolean(r.client_visible) });

export async function listTemplates(): Promise<TaskTemplateWithItems[]> {
  const templates = await query<TaskTemplateRow>(`${TEMPLATE_SELECT} ORDER BY tt.due_day_of_period, tt.name`);
  if (!templates.length) return [];
  const items = await query<TaskTemplateItemRow>(
    `SELECT id, template_id, title, checklist, client_visible, sort_order FROM task_template_items
      WHERE template_id IN (${templates.map(() => "?").join(",")}) ORDER BY sort_order, id`,
    templates.map((t) => t.id),
  );
  return templates.map((t) => ({ ...t, items: items.filter((i) => i.template_id === t.id).map(normalizeItem) }));
}

export const findTemplateById = (id: number, db: Db = pool) => queryOne<TaskTemplateRow>(`${TEMPLATE_SELECT} WHERE tt.id = ?`, [id], db);

export async function findItemById(id: number, db: Db = pool) {
  const row = await queryOne<TaskTemplateItemRow>(
    `SELECT id, template_id, title, checklist, client_visible, sort_order FROM task_template_items WHERE id = ?`,
    [id],
    db,
  );
  return row ? normalizeItem(row) : null;
}

export const serviceExists = async (id: number) => !!(await queryOne<{ id: number }>(`SELECT id FROM services WHERE id = ?`, [id]));

export async function insertTemplate(t: TemplateInput, db: Db) {
  const r = await execute(
    `INSERT INTO task_templates (service_id, name, recurrence, due_day_of_period) VALUES (?, ?, ?, ?)`,
    [t.service_id, t.name, t.recurrence, t.due_day_of_period],
    db,
  );
  return r.insertId;
}

/** New items go to the end of the template. */
export async function insertItem(templateId: number, i: ItemInput, db: Db) {
  const r = await execute(
    `INSERT INTO task_template_items (template_id, title, checklist, client_visible, sort_order)
     SELECT ?, ?, ?, ?, COALESCE(MAX(sort_order), 0) + 1 FROM task_template_items WHERE template_id = ?`,
    [templateId, i.title, JSON.stringify(i.checklist), i.client_visible, templateId],
    db,
  );
  return r.insertId;
}

export async function updateItem(id: number, i: ItemUpdateInput, db: Db) {
  const sets: string[] = [];
  const params: Param[] = [];
  if (i.title !== undefined) (sets.push("title = ?"), params.push(i.title));
  if (i.checklist !== undefined) (sets.push("checklist = ?"), params.push(JSON.stringify(i.checklist)));
  if (i.client_visible !== undefined) (sets.push("client_visible = ?"), params.push(i.client_visible));
  if (!sets.length) return;
  await execute(`UPDATE task_template_items SET ${sets.join(", ")} WHERE id = ?`, [...params, id], db);
}

/** Tasks already generated from the item keep their content (tasks.template_item_id becomes NULL). */
export async function deleteItem(id: number, db: Db) {
  await execute(`DELETE FROM task_template_items WHERE id = ?`, [id], db);
}
