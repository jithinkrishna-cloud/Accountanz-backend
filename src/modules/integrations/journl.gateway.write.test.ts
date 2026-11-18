import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  env: { JOURNL_WRITES_ENABLED: true, JOURNL_WRITE_HOSTS: ["testapi.bizpolebooks.com"], JOURNL_API_URL: "https://testapi.bizpolebooks.com/api" as string | undefined },
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../../config/env.js", () => ({ env: m.env }));
vi.mock("../../utils/logger.js", () => ({ logger: { info: m.info, warn: m.warn, error: m.error, debug: m.debug } }));

import { assertWritesEnabled, journlWrite } from "./journl.gateway.js";

const TOKEN = "tok-SECRET-123";
const fetchMock = vi.fn();

function reply(status: number, body: unknown) {
  fetchMock.mockResolvedValue(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  m.env.JOURNL_WRITES_ENABLED = true;
  m.env.JOURNL_API_URL = "https://testapi.bizpolebooks.com/api";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("journlWrite", () => {
  it("is disabled unless flag and host allow it", async () => {
    m.env.JOURNL_WRITES_ENABLED = false;
    await expect(journlWrite(TOKEN, "POST", "/x", {})).rejects.toThrow("JournL corrections are disabled in this environment");
    m.env.JOURNL_WRITES_ENABLED = true;
    m.env.JOURNL_API_URL = "https://api.bizpolebooks.com/api";
    await expect(journlWrite(TOKEN, "POST", "/x", {})).rejects.toThrow("JournL corrections are disabled in this environment");
    m.env.JOURNL_API_URL = undefined;
    await expect(journlWrite(TOKEN, "POST", "/x", {})).rejects.toThrow("JournL corrections are disabled in this environment");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("2xx success:true is ok with the parsed body, sent once with the right request", async () => {
    reply(201, { success: true, message: "created", data: 42 });
    const r = await journlWrite<{ data: number }>(TOKEN, "POST", "/journal", { a: 1 });
    expect(r).toEqual({ kind: "ok", data: { success: true, message: "created", data: 42 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://testapi.bizpolebooks.com/api/journal");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("200 success:false is rejected with JournL's message", async () => {
    reply(200, { success: false, message: "nope" });
    expect(await journlWrite(TOKEN, "PUT", "/l", {})).toEqual({ kind: "rejected", status: 200, message: "nope" });
  });

  it.each([400, 409, 422])("%i is rejected with the message", async (status) => {
    reply(status, { success: false, message: "OPENING_BALANCE_BELOW_SETTLED" });
    expect(await journlWrite(TOKEN, "PUT", "/l", {})).toEqual({ kind: "rejected", status, message: "OPENING_BALANCE_BELOW_SETTLED" });
  });

  it("401 and expired-session codes are session", async () => {
    reply(401, { success: false, message: "x" });
    expect((await journlWrite(TOKEN, "POST", "/j", {})).kind).toBe("session");
    reply(400, { success: false, code: "SESSION_EXPIRED" });
    expect((await journlWrite(TOKEN, "POST", "/j", {})).kind).toBe("session");
    reply(200, { success: false, code: "TOKEN_EXPIRED" });
    expect((await journlWrite(TOKEN, "POST", "/j", {})).kind).toBe("session");
  });

  it("expired-session code on 5xx is unknown and on 2xx success:true is ok", async () => {
    reply(500, { success: false, code: "TOKEN_EXPIRED" });
    expect((await journlWrite(TOKEN, "POST", "/j", {})).kind).toBe("unknown");
    reply(200, { success: true, code: "SESSION_EXPIRED", data: 1 });
    expect((await journlWrite(TOKEN, "POST", "/j", {})).kind).toBe("ok");
  });

  it.each([301, 302, 307, 308])("redirect %i is unknown, never followed", async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status, headers: { Location: "https://testapi.bizpolebooks.com/api/list" } }));
    expect((await journlWrite(TOKEN, "POST", "/j", { a: 1 })).kind).toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1];
    expect(init.redirect).toBe("manual");
    expect(init.method).not.toBe("GET");
  });

  it("opaque redirect or redirected response is unknown", async () => {
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
    fetchMock.mockResolvedValue(opaque);
    expect((await journlWrite(TOKEN, "POST", "/j", {})).kind).toBe("unknown");
    const redirected = new Response(JSON.stringify({ success: true, data: 1 }), { status: 200 });
    Object.defineProperty(redirected, "redirected", { value: true });
    fetchMock.mockResolvedValue(redirected);
    expect((await journlWrite(TOKEN, "POST", "/j", {})).kind).toBe("unknown");
  });

  it.each(["https://api.bizpolebooks.com/voucherJournal", "//evil.com/x", "///evil.com", "/\\evil.com", "\\evil.com", "/../other"])("rejects path %s before fetch", async (path) => {
    await expect(journlWrite(TOKEN, "POST", path, {})).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a timeout signal of 20s", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    reply(200, { success: true });
    await journlWrite(TOKEN, "PUT", "/j", {});
    expect(spy).toHaveBeenCalledWith(20_000);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("TimeoutError is unknown", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("t"), { name: "TimeoutError" }));
    expect((await journlWrite(TOKEN, "POST", "/j", {})).kind).toBe("unknown");
  });

  it("guard: http, suffix-spoofed, trailing-dot and userinfo hosts are disabled; uppercase and port are fine", () => {
    for (const url of ["http://testapi.bizpolebooks.com/api", "https://testapi.bizpolebooks.com.evil.com/api", "https://testapi.bizpolebooks.com./api", "https://testapi.bizpolebooks.com@evil.com/api", "not a url"]) {
      m.env.JOURNL_API_URL = url;
      expect(() => assertWritesEnabled(), url).toThrow(expect.objectContaining({ code: "UNAVAILABLE", message: "JournL corrections are disabled in this environment" }));
    }
    for (const url of ["https://TESTAPI.BizpoleBooks.com/api", "https://testapi.bizpolebooks.com:8443/api"]) {
      m.env.JOURNL_API_URL = url;
      expect(() => assertWritesEnabled(), url).not.toThrow();
    }
  });

  it("500, non-JSON HTML, and 2xx without a success flag are unknown", async () => {
    reply(500, { success: false, message: "boom" });
    expect((await journlWrite(TOKEN, "POST", "/j", {})).kind).toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    reply(200, "<html>proxy</html>");
    expect((await journlWrite(TOKEN, "POST", "/j", {})).kind).toBe("unknown");
    reply(200, { message: "hm" });
    expect((await journlWrite(TOKEN, "POST", "/j", {})).kind).toBe("unknown");
  });

  it("timeout and network error are unknown and not retried", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    expect((await journlWrite(TOKEN, "POST", "/j", {})).kind).toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect((await journlWrite(TOKEN, "POST", "/j", {})).kind).toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs no body or token", async () => {
    reply(400, { success: false, message: "RESPONSE-SECRET" });
    await journlWrite(TOKEN, "POST", "/j", { narration: "BODY-SECRET" });
    fetchMock.mockRejectedValue(new Error("network"));
    await journlWrite(TOKEN, "POST", "/j", { narration: "BODY-SECRET" });
    const logged = JSON.stringify([m.info.mock.calls, m.warn.mock.calls, m.error.mock.calls, m.debug.mock.calls]);
    expect(logged).toContain("/j");
    expect(logged).toContain("Error");
    for (const secret of [TOKEN, "BODY-SECRET", "RESPONSE-SECRET"]) expect(logged).not.toContain(secret);
  });
});
