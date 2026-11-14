import type { PoolConnection } from "mysql2/promise";
import { execute, query, queryOne, type Param } from "../../database/connection.js";
import type { SprintInput, UpdateSprintInput } from "./sprint.validation.js";

export type SprintStatus = "planned" | "active" | "completed";

export interface SprintRow {
  id: number;
  name: string;
  goal: string | null;
  start_date: string | null;
  end_date: string | null;
  status: SprintStatus;
  completed_at: string | null;
  item_count: number;
  done_count: number;
  points: number | null;
}

const SELECT = `
  SELECT sp.id, sp.name, sp.goal, DATE_FORMAT(sp.start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(sp.end_date, '%Y-%m-%d') AS end_date,
         sp.status, sp.completed_at,
         (SELECT COUNT(*) FROM project_items i WHERE i.sprint_id = sp.id) AS item_count,
         (SELECT COUNT(*) FROM project_items i JOIN project_statuses st ON st.id = i.status_id WHERE i.sprint_id = sp.id AND st.category = 'done') AS done_count,
         (SELECT SUM(i.story_points) FROM project_items i WHERE i.sprint_id = sp.id) AS points
    FROM project_sprints sp`;

/** Open sprints (active first, then planned) and, when asked, completed ones. */
export const listSprints = (spaceId: number, includeCompleted: boolean) =>
  query<SprintRow>(
    `${SELECT} WHERE sp.space_id = ? ${includeCompleted ? "" : "AND sp.status <> 'completed'"}
      ORDER BY FIELD(sp.status, 'active', 'planned', 'completed'), sp.start_date IS NULL, sp.start_date, sp.id`,
    [spaceId],
  );

export const findSprint = (spaceId: number, id: number, db?: PoolConnection) => queryOne<SprintRow>(`${SELECT} WHERE sp.space_id = ? AND sp.id = ?`, [spaceId, id], db);

export const lockSprint = (spaceId: number, id: number, conn: PoolConnection) =>
  queryOne<{ id: number; status: SprintStatus; name: string; start_date: string | null; end_date: string | null }>(
    `SELECT id, status, name, start_date, end_date FROM project_sprints WHERE space_id = ? AND id = ? FOR UPDATE`,
    [spaceId, id],
    conn,
  );

export const activeSprintId = async (spaceId: number, conn: PoolConnection) =>
  (await queryOne<{ id: number }>(`SELECT id FROM project_sprints WHERE space_id = ? AND status = 'active' FOR UPDATE`, [spaceId], conn))?.id ?? null;

export const countSprints = async (spaceId: number) => (await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM project_sprints WHERE space_id = ?`, [spaceId]))?.n ?? 0;

export async function insertSprint(spaceId: number, s: SprintInput) {
  const r = await execute(`INSERT INTO project_sprints (space_id, name, goal, start_date, end_date) VALUES (?, ?, ?, ?, ?)`, [spaceId, s.name, s.goal ?? null, s.start_date ?? null, s.end_date ?? null]);
  return r.insertId;
}

export async function updateSprint(spaceId: number, id: number, s: UpdateSprintInput) {
  const sets: string[] = [];
  const params: Param[] = [];
  for (const k of ["name", "goal", "start_date", "end_date"] as const) if (s[k] !== undefined) (sets.push(`${k} = ?`), params.push(s[k] ?? null));
  if (sets.length) await execute(`UPDATE project_sprints SET ${sets.join(", ")} WHERE space_id = ? AND id = ?`, [...params, spaceId, id]);
}

export const startSprint = (id: number, conn: PoolConnection) => execute(`UPDATE project_sprints SET status = 'active' WHERE id = ?`, [id], conn);

/** Moves the sprint's unfinished items to the target (backlog = null), then closes it. */
export async function completeSprint(spaceId: number, id: number, moveTo: number | null, conn: PoolConnection) {
  await execute(
    `UPDATE project_items i JOIN project_statuses st ON st.id = i.status_id SET i.sprint_id = ? WHERE i.space_id = ? AND i.sprint_id = ? AND st.category <> 'done'`,
    [moveTo, spaceId, id],
    conn,
  );
  await execute(`UPDATE project_sprints SET status = 'completed', completed_at = UTC_TIMESTAMP() WHERE id = ?`, [id], conn);
}

/** Deleting a planned sprint returns its items to the backlog (FK ON DELETE SET NULL). */
export const deleteSprint = (spaceId: number, id: number, conn: PoolConnection) => execute(`DELETE FROM project_sprints WHERE space_id = ? AND id = ?`, [spaceId, id], conn);
