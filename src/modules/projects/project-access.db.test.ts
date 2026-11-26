import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../../database/connection.js";
import { countedMembershipSql } from "./project-access.js";
import { listClientTeam, listMembersWithSource } from "./project.repository.js";

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("counted membership (real DB)", () => {
  afterAll(() => pool.end());

  it("a client_team row counts only while the assignment is active; a manual row always counts", async () => {
    // A staff user with no active assignment on some client.
    const [pairs] = await pool.query<any[]>(
      `SELECT u.id AS user_id, c.id AS client_id FROM users u CROSS JOIN clients c
        WHERE u.portal_role NOT IN ('super_admin','ops_admin','client')
          AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.user_id = u.id AND a.client_id = c.id AND a.status = 'active')
        LIMIT 1`,
    );
    expect(pairs.length).toBe(1);
    const { user_id: userId, client_id: clientId } = pairs[0];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [ins] = await conn.query<any>("INSERT INTO project_spaces (space_key, name, template, client_id, kind) VALUES ('ZZLAPSE', 'lapse test', 'kanban', ?, 'client_project')", [clientId]);
      const spaceId = ins.insertId;
      await conn.query("INSERT INTO project_space_members (space_id, user_id, role, source) VALUES (?, ?, 'member', 'client_team')", [spaceId, userId]);
      const role = async () =>
        (
          await conn.query<any[]>(
            `SELECT m.role FROM project_spaces s LEFT JOIN project_space_members m ON m.space_id = s.id AND m.user_id = ? AND ${countedMembershipSql("m", "s")} WHERE s.id = ?`,
            [userId, spaceId],
          )
        )[0][0].role;
      expect(await role()).toBeNull();

      await conn.query("UPDATE project_space_members SET source = 'manual' WHERE space_id = ? AND user_id = ?", [spaceId, userId]);
      expect(await role()).toBe("member");

      // The sync's own reads are valid SQL on this server (FOR SHARE OF, disabled filter).
      await expect(listMembersWithSource(spaceId, conn)).resolves.toHaveLength(1);
      await expect(listClientTeam(clientId, conn)).resolves.toBeInstanceOf(Array);
    } finally {
      await conn.rollback();
      conn.release();
    }
  });
});
