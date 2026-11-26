import { afterAll, describe, expect, it } from "vitest";
import { pool, withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { guarded } from "./client-space-hooks.js";

const actor = { id: 1, role: "super_admin", email: "a@x.com" } as AuthUser;
const ROLLBACK = new Error("rollback sentinel");

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("workspace hook savepoints (real DB)", () => {
  afterAll(() => pool.end());

  it("runs a success body and a throwing body without throwing", async () => {
    const [clients] = await pool.query<any[]>("SELECT id FROM clients ORDER BY id LIMIT 1");
    const clientId = clients[0].id;
    let ran = false;
    await expect(
      withTransaction(async (conn) => {
        await guarded(actor, clientId, "test ok", conn, async () => {
          ran = true;
        });
        const failures = async () => (await conn.query<any[]>("SELECT details FROM audit_logs WHERE action = 'Workspace sync failed' AND client_id = ?", [clientId]))[0];
        expect(await failures()).toHaveLength(0);
        await expect(
          guarded(actor, clientId, "test fail", conn, async () => {
            throw new Error("boom");
          }),
        ).resolves.toBeUndefined();
        const rows = await failures();
        expect(rows).toHaveLength(1);
        expect(rows[0].details).toContain("boom");
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
    expect(ran).toBe(true);
  });
});
