import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthUser } from "../../types/auth.types.js";

/**
 * Real-database race test for the single-send gate. Writes to the local DB, so it only runs with RUN_DB_TESTS=1.
 * Inserts its own correction row and deletes it (events, audit rows by entity, correction) in afterAll.
 * The interleaving is forced: another connection holds the row lock while transition() is started.
 */
describe.skipIf(process.env.RUN_DB_TESTS !== "1")("transition race (real DB)", () => {
  let db: typeof import("../../database/connection.js");
  let id = 0;
  let userA = 0;
  let userB = 0;

  beforeAll(async () => {
    db = await import("../../database/connection.js");
    const client = await db.queryOne<{ id: number }>("SELECT id FROM clients ORDER BY id LIMIT 1");
    const conn = await db.queryOne<{ id: number }>("SELECT id FROM integration_connections ORDER BY id LIMIT 1");
    const users = await db.query<{ id: number }>("SELECT id FROM users ORDER BY id LIMIT 2");
    if (!client || !conn || users.length < 2) throw new Error("Need a client, an integration connection and two users");
    userA = users[0]!.id; // initiator
    userB = users[1]!.id; // approver
    const res = await db.execute(
      `INSERT INTO journl_corrections (client_id, connection_id, journl_company_id, journl_branch_id, kind, status, payload, reason, initiated_by, approved_by, approved_at)
       VALUES (?, ?, 'race-test', 1, 'journal_entry', 'approved', '{}', 'race test', ?, ?, UTC_TIMESTAMP())`,
      [client.id, conn.id, userA, userB],
    );
    id = res.insertId;
  });

  afterAll(async () => {
    if (id) {
      await db.execute("DELETE FROM journl_correction_events WHERE correction_id = ?", [id]);
      await db.execute("DELETE FROM audit_logs WHERE entity_type = 'JournlCorrection' AND entity_id = ?", [`ACZ-${id}`]);
      await db.execute("DELETE FROM journl_corrections WHERE id = ?", [id]);
    }
    await db.pool.end();
  });

  const reset = async () => {
    await db.execute("UPDATE journl_corrections SET status = 'approved' WHERE id = ?", [id]);
    await db.execute("DELETE FROM journl_correction_events WHERE correction_id = ?", [id]);
    await db.execute("DELETE FROM audit_logs WHERE entity_type = 'JournlCorrection' AND entity_id = ?", [`ACZ-${id}`]);
  };
  const countRows = async () => {
    const [e] = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM journl_correction_events WHERE correction_id = ?", [id]);
    const [a] = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type = 'JournlCorrection' AND entity_id = ?", [`ACZ-${id}`]);
    return { events: e!.n, audits: a!.n };
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const actorOf = () => ({ id: userB, role: "super_admin", email: "race@test" }) as AuthUser;

  /** Holds the row lock on its own connection, as another reviewer's request mid-transition would. */
  async function holdLock() {
    const conn = await db.pool.getConnection();
    await conn.beginTransaction();
    await conn.query("UPDATE journl_corrections SET status = 'posting' WHERE id = ? AND status = 'approved'", [id]);
    return conn;
  }

  it("blocked behind a held lock; holder commits: transition rejects 409 and writes nothing", async () => {
    await reset();
    const { transition } = await import("./correction.state.js");
    const held = await holdLock();
    let settled = false;
    const p = transition(id, "approved", "posting", actorOf(), { requestId: "race-1" }).finally(() => {
      settled = true;
    });
    p.catch(() => undefined);
    await sleep(300);
    expect(settled).toBe(false); // blocked on the row lock
    await held.commit();
    held.release();
    await expect(p).rejects.toMatchObject({ status: 409, message: "This correction was already posting" });
    expect(await countRows()).toEqual({ events: 0, audits: 0 });
  });

  it("blocked behind a held lock; holder rolls back: transition wins", async () => {
    await reset();
    const { transition } = await import("./correction.state.js");
    const { findCorrection } = await import("./correction.repository.js");
    const held = await holdLock();
    let settled = false;
    const p = transition(id, "approved", "posting", actorOf(), { requestId: "race-2" }).finally(() => {
      settled = true;
    });
    p.catch(() => undefined);
    await sleep(300);
    expect(settled).toBe(false);
    await held.rollback();
    held.release();
    const row = await p;
    expect(row.status).toBe("posting");
    expect((await findCorrection(id))?.status).toBe("posting");
    expect(await countRows()).toEqual({ events: 1, audits: 1 });
  });

  it("smoke: two concurrent approved -> posting, exactly one wins", async () => {
    await reset();
    const { transition } = await import("./correction.state.js");
    const results = await Promise.allSettled([
      transition(id, "approved", "posting", actorOf(), { requestId: "race-3" }),
      transition(id, "approved", "posting", actorOf(), { requestId: "race-4" }),
    ]);
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.reason).toMatchObject({ status: 409 });
    expect(await countRows()).toEqual({ events: 1, audits: 1 });
  });
});
