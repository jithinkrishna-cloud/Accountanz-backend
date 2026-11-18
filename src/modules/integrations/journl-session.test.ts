import { afterEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ queryOne: vi.fn() }));
vi.mock("../../database/connection.js", () => ({ queryOne: m.queryOne }));
vi.mock("../../config/env.js", async (orig) => {
  const real = await orig<typeof import("../../config/env.js")>();
  return { ...real, env: { ...real.env, JOURNL_TOKEN_KEY: "k" } };
});
vi.mock("../../utils/crypto.js", () => ({ decryptSecret: () => "tok" }));

const { openJournlSession } = await import("./journl-data.service.js");

const row = (token_expires_at: string) => ({ external_org_id: "218", status: "connected", access_token_enc: "enc", token_expires_at });

describe("openJournlSession expiry (token_expires_at is stored as UTC)", () => {
  afterEach(() => vi.useRealTimers());

  it("treats the stored value as UTC: 14:45 UTC is still valid at 11:33 UTC (17:03 IST)", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-18T11:33:00Z") });
    m.queryOne.mockResolvedValue(row("2026-11-18 14:45:49"));
    const s = await openJournlSession(1);
    expect(s.expiresAt.toISOString()).toBe("2026-11-18T14:45:49.000Z");
  });

  it("is expired once the UTC time has passed", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-18T14:45:50Z") });
    m.queryOne.mockResolvedValue(row("2026-11-18 14:45:49"));
    await expect(openJournlSession(1)).rejects.toThrow(/session has expired/);
  });
});
