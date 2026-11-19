import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret, decryptSecret } from "../../../utils/crypto.js";

const KEY = vi.hoisted(() => Buffer.alloc(32, 9).toString("base64"));
vi.mock("../../../config/env.js", async (orig) => {
  const real = await orig<typeof import("../../../config/env.js")>();
  return { ...real, env: { ...real.env, BIZPOLE_TOKEN_KEY: KEY } };
});

const m = vi.hoisted(() => ({
  queryOne: vi.fn(),
  lockById: vi.fn(),
  saveRotatedTokens: vi.fn(),
  markRevoked: vi.fn(),
  requestToken: vi.fn(),
  conn: { tag: "conn" },
}));
vi.mock("../../../database/connection.js", () => ({
  queryOne: m.queryOne,
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(m.conn),
}));
vi.mock("./bizpole.repository.js", () => ({ lockById: m.lockById, saveRotatedTokens: m.saveRotatedTokens, markRevoked: m.markRevoked }));
vi.mock("./bizpole.client.js", async (orig) => {
  const real = await orig<typeof import("./bizpole.client.js")>();
  return { ...real, requestToken: m.requestToken };
});

const { BizpoleApiError } = await import("./bizpole.client.js");
const { accessTokenFor, exchangeCode } = await import("./bizpole.token.service.js");

/** UTC DATETIME string (as MySQL returns it with dateStrings) `ms` from now. */
const utcIn = (ms: number) => new Date(Date.now() + ms).toISOString().slice(0, 19).replace("T", " ");
const row = (over: Record<string, unknown> = {}) => ({
  id: 7,
  status: "connected",
  access_token_enc: encryptSecret("old-access", KEY),
  refresh_token_enc: encryptSecret("old-refresh-0123456789abcdef", KEY),
  token_expires_at: utcIn(30_000), // expires within the 60s refresh window
  ...over,
});
const NEW = { access_token: "new-access", token_type: "Bearer", expires_in: 900, refresh_token: "new-refresh-0123456789abcdef", grant_id: "g-1", companies: [201] };

beforeEach(() => {
  vi.clearAllMocks();
  m.saveRotatedTokens.mockResolvedValue(undefined);
  m.markRevoked.mockResolvedValue(undefined);
});

describe("accessTokenFor", () => {
  it("returns the stored token while it has more than a minute left (no refresh)", async () => {
    m.queryOne.mockResolvedValue(row({ token_expires_at: utcIn(10 * 60_000) }));
    await expect(accessTokenFor(7)).resolves.toBe("old-access");
    expect(m.requestToken).not.toHaveBeenCalled();
  });

  it("two concurrent callers trigger exactly one refresh, and the rotated tokens are saved before use", async () => {
    m.queryOne.mockResolvedValue(row());
    m.lockById.mockResolvedValue(row());
    let release!: () => void;
    m.requestToken.mockImplementation(() => new Promise((r) => (release = () => r(NEW))));

    const a = accessTokenFor(7);
    const b = accessTokenFor(7);
    await vi.waitFor(() => expect(m.requestToken).toHaveBeenCalledTimes(1));
    expect(m.saveRotatedTokens).not.toHaveBeenCalled();
    release();
    await expect(Promise.all([a, b])).resolves.toEqual(["new-access", "new-access"]);

    expect(m.requestToken).toHaveBeenCalledTimes(1);
    expect(m.requestToken).toHaveBeenCalledWith({ grant_type: "refresh_token", refresh_token: "old-refresh-0123456789abcdef" });
    const [id, sealed, conn] = m.saveRotatedTokens.mock.calls[0]!;
    expect(id).toBe(7);
    expect(conn).toBe(m.conn); // same transaction as the row lock
    expect(decryptSecret(sealed.refreshEnc, KEY)).toBe(NEW.refresh_token);
    expect(decryptSecret(sealed.accessEnc, KEY)).toBe(NEW.access_token);
    expect(sealed.grantId).toBe("g-1");
  });

  it("re-checks under the lock: another instance already refreshed, so no second refresh", async () => {
    m.queryOne.mockResolvedValue(row());
    m.lockById.mockResolvedValue(row({ access_token_enc: encryptSecret("fresh-from-other", KEY), token_expires_at: utcIn(14 * 60_000) }));
    await expect(accessTokenFor(7)).resolves.toBe("fresh-from-other");
    expect(m.requestToken).not.toHaveBeenCalled();
  });

  it("after a 401 the rejected token is refreshed even though it isn't expired yet", async () => {
    const valid = row({ token_expires_at: utcIn(14 * 60_000) });
    m.lockById.mockResolvedValue(valid);
    m.requestToken.mockResolvedValue(NEW);
    await expect(accessTokenFor(7, "old-access")).resolves.toBe("new-access");
    expect(m.requestToken).toHaveBeenCalledTimes(1);
  });

  it("400 invalid_grant on refresh: connection marked revoked (committed), caller told to reconnect", async () => {
    m.queryOne.mockResolvedValue(row());
    m.lockById.mockResolvedValue(row());
    m.requestToken.mockRejectedValue(new BizpoleApiError(400, "invalid_grant", "revoked", "r", null));
    await expect(accessTokenFor(7)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/reconnect/i) });
    expect(m.markRevoked).toHaveBeenCalledWith(7, expect.stringContaining("invalid_grant"), m.conn);
    expect(m.saveRotatedTokens).not.toHaveBeenCalled();
  });

  it("401 invalid_client is Accountanz's configuration problem: the customer's connection is left alone", async () => {
    m.queryOne.mockResolvedValue(row());
    m.lockById.mockResolvedValue(row());
    m.requestToken.mockRejectedValue(new BizpoleApiError(401, "invalid_client", "Client authentication failed.", "r", null));
    await expect(accessTokenFor(7)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/partner credentials/) });
    expect(m.markRevoked).not.toHaveBeenCalled();
  });

  it("if saving fails after Bizpole rotated, the old refresh token is never reused: marked revoked", async () => {
    m.queryOne.mockResolvedValue(row());
    m.lockById.mockResolvedValue(row());
    m.requestToken.mockResolvedValue(NEW);
    m.saveRotatedTokens.mockRejectedValue(new Error("deadlock"));
    await expect(accessTokenFor(7)).rejects.toMatchObject({ status: 409 });
    expect(m.markRevoked).toHaveBeenCalledWith(7, expect.stringMatching(/could not be saved/));
  });

  it("a disconnected connection is never refreshed", async () => {
    m.queryOne.mockResolvedValue(row({ access_token_enc: null }));
    m.lockById.mockResolvedValue(row({ status: "disconnected" }));
    await expect(accessTokenFor(7)).rejects.toMatchObject({ status: 409 });
    expect(m.requestToken).not.toHaveBeenCalled();
  });
});

describe("exchangeCode", () => {
  it("a bad, used or expired code is a field error on the code", async () => {
    m.requestToken.mockRejectedValue(new BizpoleApiError(400, "invalid_grant", "The connection code is invalid, already used or expired.", "r", null));
    await expect(exchangeCode("BPC-X")).rejects.toMatchObject({ status: 400, details: { fieldErrors: { code: expect.any(Array) } } });
  });

  it("integration switched off on Bizpole's side is reported as such", async () => {
    m.requestToken.mockRejectedValue(new BizpoleApiError(503, "integration_disabled", "The integration API is not enabled on this server.", "r", null));
    await expect(exchangeCode("BPC-X")).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/switched off/) });
  });
});
