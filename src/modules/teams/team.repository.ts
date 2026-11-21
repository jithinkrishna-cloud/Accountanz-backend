import type { PoolConnection } from "mysql2/promise";
import { activeAssignmentSql } from "../access/client-access.js";
import { execute, pool, query, queryOne, type Param } from "../../database/connection.js";
import { offsetOf, type Paged } from "../../utils/pagination.js";
import type { TeamMember, TeamRow } from "./team.types.js";
import type { TeamListQuery } from "./team.validation.js";

type Db = PoolConnection | typeof pool;

export const findTeamByClient = (clientId: number, db: Db = pool) =>
  queryOne<{ id: number; name: string }>(`SELECT id, name FROM teams WHERE client_id = ?`, [clientId], db);

/** One team per client (unique key on teams.client_id). */
export async function insertTeam(clientId: number, name: string, db: Db) {
  const r = await execute(`INSERT INTO teams (client_id, name) VALUES (?, ?)`, [clientId, name], db);
  return r.insertId;
}

export async function renameTeam(clientId: number, name: string, db: Db) {
  await execute(`UPDATE teams SET name = ? WHERE client_id = ?`, [name, clientId], db);
}

/** Clients that can still get a team: no team yet, not exited. */
export const listClientsWithoutTeam = () =>
  query<{ id: number; name: string }>(
    `SELECT c.id, COALESCE(c.trade_name, c.legal_name) AS name
       FROM clients c LEFT JOIN teams t ON t.client_id = c.id
      WHERE t.id IS NULL AND c.status <> 'exited'
      ORDER BY name`,
  );

/** Created teams; members are the assignments granting access today. */
export async function listTeams(q: TeamListQuery): Promise<Paged<TeamRow>> {
  const where: string[] = [];
  const params: Param[] = [];
  if (q.q) {
    const like = `%${q.q}%`;
    where.push(`(c.legal_name LIKE ? OR c.trade_name LIKE ? OR t.name LIKE ?
                 OR EXISTS (SELECT 1 FROM assignments a JOIN users u ON u.id = a.user_id
                             WHERE a.client_id = c.id AND ${activeAssignmentSql("a")} AND u.full_name LIKE ?))`);
    params.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const from = `FROM teams t JOIN clients c ON c.id = t.client_id`;
  const teams = await query<Omit<TeamRow, "members">>(
    `SELECT c.id AS client_id, COALESCE(c.trade_name, c.legal_name) AS client_name, c.status AS client_status,
            t.id AS team_id, t.name AS team_name,
            (SELECT COUNT(*) FROM assignments a WHERE a.client_id = c.id AND a.status = 'active' AND a.valid_from > CURDATE()) AS scheduled_count
       ${from} ${whereSql}
      ORDER BY t.name
      LIMIT ? OFFSET ?`,
    [...params, q.pageSize, offsetOf(q)],
  );
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n ${from} ${whereSql}`, params);

  const members = teams.length
    ? await query<TeamMember & { client_id: number }>(
        `SELECT a.client_id, a.id AS assignment_id, a.user_id, u.full_name, u.email, a.team_role, a.journl_access, a.valid_to, sg.name AS source_group_name
           FROM assignments a JOIN users u ON u.id = a.user_id LEFT JOIN staff_groups sg ON sg.id = a.source_group_id
          WHERE a.client_id IN (${teams.map(() => "?").join(",")})
            AND ${activeAssignmentSql("a")}
          ORDER BY FIELD(a.team_role, 'cfo', 'finance_manager', 'reviewer', 'bookkeeper'), u.full_name`,
        teams.map((t) => t.client_id),
      )
    : [];

  const items = teams.map((t) => ({
    ...t,
    members: members.filter((m) => m.client_id === t.client_id).map(({ client_id: _c, ...m }) => ({ ...m, journl_access: Boolean(m.journl_access) })),
  }));
  return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
}
