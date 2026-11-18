import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../../database/connection.js";
import { events } from "./correction.repository.js";

/** Real-DB check against the local dev data (ACZ-2 from the Task 12 test): every history step keeps its actor's name. */
describe.skipIf(process.env.RUN_DB_TESTS !== "1")("correction history actor names (real DB)", () => {
  afterAll(() => pool.end());

  it("ACZ-2 returns all four steps with Arun, Priya, Priya, Priya", async () => {
    const rows = await events(2);
    expect(rows.map((e) => `${e.from_status}→${e.to_status}`)).toEqual([
      "draft→pending_approval",
      "pending_approval→approved",
      "approved→posting",
      "posting→posted",
    ]);
    expect(rows.map((e) => e.actor_name)).toEqual(["Arun Menon", "Priya Nair", "Priya Nair", "Priya Nair"]);
  });
});
