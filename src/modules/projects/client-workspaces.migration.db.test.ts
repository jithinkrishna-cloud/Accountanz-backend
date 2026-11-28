import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../../database/connection.js";

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("client workspaces migration 037 (real DB)", () => {
  afterAll(() => pool.end());

  it("allows only one client_primary per client", async () => {
    const [clients] = await pool.query<any[]>("SELECT id FROM clients ORDER BY id LIMIT 1");
    expect(clients.length).toBe(1);
    const clientId = clients[0].id;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const ins = (key: string) =>
        conn.query(
          "INSERT INTO project_spaces (space_key, name, template, client_id, kind) VALUES (?, 'dup test', 'kanban', ?, 'client_primary')",
          [key, clientId],
        );
      // Remove any existing primary inside the transaction so the first insert is the one that succeeds.
      await conn.query("UPDATE project_spaces SET kind = 'client_project' WHERE client_id = ? AND kind = 'client_primary'", [clientId]);
      await ins("DUPT1");
      await expect(ins("DUPT2")).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    } finally {
      await conn.rollback();
      conn.release();
    }
  });

  it("classifies existing spaces", async () => {
    const [spaces] = await pool.query<any[]>("SELECT id, client_id, kind, created_at FROM project_spaces");
    const byClient = new Map<number, any[]>();
    for (const s of spaces) {
      if (s.client_id === null) {
        expect(s.kind).toBe("internal");
      } else {
        const list = byClient.get(s.client_id) ?? [];
        list.push(s);
        byClient.set(s.client_id, list);
      }
    }
    for (const list of byClient.values()) {
      list.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at) || a.id - b.id);
      const primaries = list.filter((s) => s.kind === "client_primary");
      expect(primaries.length).toBe(1);
      expect(primaries[0].id).toBe(list[0].id);
      for (const s of list.slice(1)) expect(s.kind).toBe("client_project");
    }
  });

  // Existing members were migrated as 'manual'; after that the client-team sync adds 'client_team' rows, but only ever
  // to a client's primary space (internal and project spaces are managed by hand).
  it("only primary client spaces carry client_team members", async () => {
    const [rows] = await pool.query<any[]>(
      `SELECT COUNT(*) AS n FROM project_space_members m JOIN project_spaces s ON s.id = m.space_id
        WHERE m.source = 'client_team' AND s.kind <> 'client_primary'`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});
