import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  BIZPOLE_API_BASE_URL: "https://bizpole.test/integration/v1" as string | undefined,
  BIZPOLE_CLIENT_ID: "bpc_client",
  BIZPOLE_CLIENT_SECRET: "s3cret:with/odd chars",
  BIZPOLE_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"),
}));
vi.mock("../../../config/env.js", async (orig) => {
  const real = await orig<typeof import("../../../config/env.js")>();
  return { ...real, env: new Proxy(real.env, { get: (t, k) => (k in settings ? settings[k as keyof typeof settings] : t[k as keyof typeof t]) }) };
});

const { BizpoleApiError, BizpoleBusy, BizpoleUnreachable, bizpoleConfigured, getJson, parseRetryAfter, requestToken, resetBizpoleLimits, revokeGrant, urlFor } = await import("./bizpole.client.js");

const TOKENS = { access_token: "acc", token_type: "Bearer", expires_in: 900, refresh_token: "ref-0123456789abcdefghij", grant_id: "g-1", companies: [201] };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetBizpoleLimits();
  settings.BIZPOLE_API_BASE_URL = "https://bizpole.test/integration/v1";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("token endpoint", () => {
  it("POSTs a form to /auth/token with Basic client credentials and never follows redirects", async () => {
    fetchMock.mockResolvedValue(json(200, TOKENS));
    const t = await requestToken({ grant_type: "connection_code", code: "BPC-AAAAA-BBBBB-CCCCC-DDDDD" });
    expect(t.refresh_token).toBe(TOKENS.refresh_token);

    const [url, init] = fetchMock.mock.calls[0]! as [URL, RequestInit];
    expect(String(url)).toBe("https://bizpole.test/integration/v1/auth/token");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const decoded = Buffer.from(headers.Authorization!.replace("Basic ", ""), "base64").toString("utf8");
    expect(decoded.split(":").map(decodeURIComponent)).toEqual(["bpc_client", "s3cret:with/odd chars"]);
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ grant_type: "connection_code", code: "BPC-AAAAA-BBBBB-CCCCC-DDDDD" });
  });

  it("refresh uses the same Basic credentials", async () => {
    fetchMock.mockResolvedValue(json(200, TOKENS));
    await requestToken({ grant_type: "refresh_token", refresh_token: "old-refresh-token-xxxxxxxx" });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    expect(new URLSearchParams(String(init.body)).get("grant_type")).toBe("refresh_token");
  });

  it("maps Bizpole's error envelope and never echoes credentials", async () => {
    fetchMock.mockResolvedValue(json(400, { error: { code: "invalid_grant", message: "The code or refresh token is invalid, expired or revoked.", requestId: "r-1" } }));
    const err = await requestToken({ grant_type: "connection_code", code: "BPC-X" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BizpoleApiError);
    expect(err).toMatchObject({ status: 400, code: "invalid_grant", requestId: "r-1" });
    expect(JSON.stringify(err) + String(err)).not.toContain("s3cret");
  });

  it("treats a redirect as unreachable (not followed, not success)", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { Location: "https://evil.test/" } }));
    await expect(requestToken({ grant_type: "connection_code", code: "BPC-X" })).rejects.toBeInstanceOf(BizpoleUnreachable);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a 200 answer without the token fields", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));
    await expect(requestToken({ grant_type: "connection_code", code: "BPC-X" })).rejects.toBeInstanceOf(BizpoleUnreachable);
  });

  it("keeps the whole server under 18 token requests a minute (every customer shares one IP)", async () => {
    fetchMock.mockImplementation(async () => json(200, TOKENS));
    for (let i = 0; i < 18; i++) await requestToken({ grant_type: "refresh_token", refresh_token: `r-${i}-xxxxxxxxxxxxxxxxxx` });
    await expect(requestToken({ grant_type: "refresh_token", refresh_token: "r-19-xxxxxxxxxxxxxxxxxx" })).rejects.toBeInstanceOf(BizpoleBusy);
    expect(fetchMock).toHaveBeenCalledTimes(18);
  });

  it("revoke posts token=<refresh token> and reports whether Bizpole confirmed", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    expect(await revokeGrant("ref-0123456789abcdefghij")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]! as [URL, RequestInit];
    expect(String(url)).toBe("https://bizpole.test/integration/v1/auth/revoke");
    expect(new URLSearchParams(String(init.body)).get("token")).toBe("ref-0123456789abcdefghij");

    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await revokeGrant("ref-0123456789abcdefghij")).toBe(false);
  });
});

describe("data calls", () => {
  it("GETs with the bearer token and query string", async () => {
    fetchMock.mockResolvedValue(json(200, { data: [], hasMore: false, nextCursor: null }));
    await getJson("acc-token", "conn:1", "companies/201/vouchers", { from: "2026-04-01", limit: "500" });
    const [url, init] = fetchMock.mock.calls[0]! as [URL, RequestInit];
    expect(String(url)).toBe("https://bizpole.test/integration/v1/companies/201/vouchers?from=2026-04-01&limit=500");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer acc-token");
  });

  it("on 429 waits a short Retry-After and tries exactly once more", async () => {
    fetchMock.mockResolvedValueOnce(json(429, { error: { code: "rate_limited" } }, { "Retry-After": "0" })).mockResolvedValueOnce(json(200, { data: [] }));
    await expect(getJson("t", "conn:1", "companies")).resolves.toEqual({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("on 429 with a long Retry-After reports busy without waiting", async () => {
    fetchMock.mockResolvedValue(json(429, {}, { "Retry-After": "60" }));
    await expect(getJson("t", "conn:1", "companies")).rejects.toMatchObject({ status: 429, retryAfterSec: 60 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes 401 invalid_token through for the caller to refresh", async () => {
    fetchMock.mockResolvedValue(json(401, { error: { code: "invalid_token", message: "A valid integration access token is required." } }));
    await expect(getJson("t", "conn:1", "companies")).rejects.toMatchObject({ status: 401, code: "invalid_token" });
  });
});

describe("configuration and URL safety", () => {
  it("refuses paths that could leave the API base", () => {
    expect(() => urlFor("https://evil.test/x")).toThrow();
    expect(() => urlFor("//evil.test/x")).toThrow();
    expect(() => urlFor("companies/../../admin")).toThrow();
    expect(String(urlFor("companies/201/totals", { asOf: "2026-11-01" }))).toBe("https://bizpole.test/integration/v1/companies/201/totals?asOf=2026-11-01");
  });

  it("is only configured over https (http allowed for localhost outside production)", () => {
    expect(bizpoleConfigured()).toBe(true);
    settings.BIZPOLE_API_BASE_URL = "http://bizpole.test/integration/v1";
    expect(bizpoleConfigured()).toBe(false);
    settings.BIZPOLE_API_BASE_URL = "http://localhost:5000/integration/v1";
    expect(bizpoleConfigured()).toBe(true);
    settings.BIZPOLE_API_BASE_URL = undefined;
    expect(bizpoleConfigured()).toBe(false);
  });

  it("reads Retry-After as seconds or an HTTP date", () => {
    expect(parseRetryAfter("30")).toBe(30);
    const now = Date.parse("2026-11-19T10:00:00Z");
    expect(parseRetryAfter("Thu, 19 Nov 2026 10:00:45 GMT", now)).toBe(45);
    expect(parseRetryAfter(null)).toBeNull();
  });
});
