import { beforeEach, describe, expect, it, vi } from "vitest";

/** The stuck flag is computed in SQL (DB clock on both sides), on the reads that feed get/list/check/resolve. */
const m = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock("../../database/connection.js", () => ({ query: m.query, queryOne: m.queryOne, execute: vi.fn(), pool: {} }));
const repo = await import("./correction.repository.js");

beforeEach(() => vi.resetAllMocks());

describe("stuck_posting", () => {
  it("findCorrection and listForClient select it from status and updated_at vs NOW()", async () => {
    m.queryOne.mockResolvedValue({ id: 1, status: "posting", stuck_posting: 1, payload: "{}" });
    m.query.mockResolvedValue([]);
    expect((await repo.findCorrection(1))?.stuck_posting).toBe(1);
    await repo.listForClient(42);
    for (const sql of [m.queryOne.mock.calls[0][0], m.query.mock.calls[0][0]]) {
      expect(sql).toContain("(status = 'posting' AND updated_at < NOW() - INTERVAL 120 SECOND) AS stuck_posting");
    }
    expect(repo.STUCK_POSTING_SECONDS).toBe(120);
  });
});
