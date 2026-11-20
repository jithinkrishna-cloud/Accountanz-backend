import { env, isProd } from "../../../config/env.js";
import { logger } from "../../../utils/logger.js";
import type { BizpoleTokenResponse } from "./bizpole.types.js";

/**
 * The only code that talks HTTP to the JournL Integration API. Read-only: data calls are GET only; the two
 * POSTs are the token endpoint and the client's own revoke (disconnect).
 *
 * - Credentials (client id/secret) go in HTTP Basic, server-side only. Never logged; error messages never echo them.
 * - Only the configured host, over HTTPS (plain http allowed for localhost outside production, for a local Bizpole).
 * - Redirects are never followed. Requests time out after 20s.
 * - Limits (Bizpole: 600 data requests/min per grant, 20 token requests/min per IP): Accountanz keeps under them
 *   itself (550 per connection, 18 token requests for the whole server, since every customer shares our IP).
 *   On HTTP 429 it waits for Retry-After when that's 5s or less and tries once more; otherwise it reports "busy".
 */

const TIMEOUT_MS = 20_000;
const MAX_INLINE_WAIT_S = 5;

/** Bizpole answered with its error envelope { error: { code, message, requestId } } (or an HTTP error without one). */
export class BizpoleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly retryAfterSec: number | null,
  ) {
    super(message);
    this.name = "BizpoleApiError";
  }
}

/** No usable answer: network failure, timeout, redirect or an unreadable body. Nothing is known about the outcome. */
export class BizpoleUnreachable extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "BizpoleUnreachable";
  }
}

/** Accountanz's own limiter is full: retry after `retryAfterSec`. */
export class BizpoleBusy extends Error {
  constructor(readonly retryAfterSec: number) {
    super("JournL is busy");
    this.name = "BizpoleBusy";
  }
}

/** True when the API URL, partner credentials and token key are all set. */
export function bizpoleConfigured(): boolean {
  return !!(env.BIZPOLE_API_BASE_URL && env.BIZPOLE_CLIENT_ID && env.BIZPOLE_CLIENT_SECRET && env.BIZPOLE_TOKEN_KEY) && baseUrlOrNull() !== null;
}

function baseUrlOrNull(): URL | null {
  if (!env.BIZPOLE_API_BASE_URL) return null;
  let u: URL;
  try {
    u = new URL(env.BIZPOLE_API_BASE_URL.endsWith("/") ? env.BIZPOLE_API_BASE_URL : `${env.BIZPOLE_API_BASE_URL}/`);
  } catch {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol === "https:" || (u.protocol === "http:" && local && !isProd)) return u;
  return null;
}

/** A path under the API base; refuses anything that could change the host or climb out of the base path. */
export function urlFor(path: string, query: Record<string, string> = {}): URL {
  const base = baseUrlOrNull();
  if (!base) throw new BizpoleUnreachable("JournL isn't set up on this server");
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.includes("\\") || path.startsWith("//") || path.split("/").includes("..")) {
    throw new Error("bizpole: path must be a plain relative path");
  }
  const url = new URL(path.replace(/^\/+/, ""), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error("bizpole: path escapes the API base");
  for (const [k, v] of Object.entries(query)) if (v !== "") url.searchParams.set(k, v);
  return url;
}

/* ---------------- limits ---------------- */

class SlidingWindow {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  /** Records a request and returns 0, or the seconds to wait when the window is full (nothing recorded). */
  take(key: string, now = Date.now()): number {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0]! + this.windowMs - now) / 1000));
    }
    recent.push(now);
    this.hits.set(key, recent);
    return 0;
  }
  reset() {
    this.hits.clear();
  }
}

const tokenWindow = new SlidingWindow(18, 60_000);
const dataWindow = new SlidingWindow(550, 60_000);

/** Tests only. */
export function resetBizpoleLimits() {
  tokenWindow.reset();
  dataWindow.reset();
}

/* ---------------- transport ---------------- */

/** Seconds from a Retry-After header (delta-seconds or an HTTP date); null when absent or unreadable. */
export function parseRetryAfter(raw: string | null, now = Date.now()): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw.trim())) return Number(raw.trim());
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(url: URL, init: RequestInit, logPath: string): Promise<{ status: number; body: unknown; retryAfterSec: number | null }> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      const name = (err as Error).name;
      const timedOut = name === "AbortError" || name === "TimeoutError";
      logger.warn({ method: init.method, path: logPath, timedOut }, "Bizpole request did not complete");
      throw new BizpoleUnreachable(timedOut ? "JournL did not answer in time" : "JournL could not be reached");
    }
    if (res.type === "opaqueredirect" || res.status === 0 || (res.status >= 300 && res.status < 400)) {
      logger.warn({ method: init.method, path: logPath, status: res.status }, "Bizpole answered with a redirect (not followed)");
      throw new BizpoleUnreachable("JournL answered with a redirect");
    }
    const retryAfterSec = parseRetryAfter(res.headers.get("retry-after"));
    const body = (await res.json().catch(() => null)) as unknown;
    const requestId = errorEnvelope(body)?.requestId ?? null;
    logger.info({ method: init.method, path: logPath, status: res.status, bizpoleRequestId: requestId }, "Bizpole answered");

    // A 429 is refused before Bizpole does anything, so one more try after a short wait is safe (also for /auth/token).
    if (res.status === 429 && attempt === 0 && retryAfterSec !== null && retryAfterSec <= MAX_INLINE_WAIT_S) {
      await sleep(retryAfterSec * 1000);
      continue;
    }
    return { status: res.status, body, retryAfterSec };
  }
}

function errorEnvelope(body: unknown): { code?: string; message?: string; requestId?: string } | null {
  const e = (body as { error?: unknown } | null)?.error;
  return e && typeof e === "object" ? (e as { code?: string; message?: string; requestId?: string }) : null;
}

function toApiError(status: number, body: unknown, retryAfterSec: number | null): BizpoleApiError {
  const e = errorEnvelope(body);
  const code = typeof e?.code === "string" ? e.code : status === 429 ? "rate_limited" : `http_${status}`;
  const message = typeof e?.message === "string" && e.message ? e.message : `JournL answered ${status}`;
  return new BizpoleApiError(status, code, message, typeof e?.requestId === "string" ? e.requestId : null, retryAfterSec);
}

function basicAuth(): string {
  const id = env.BIZPOLE_CLIENT_ID ?? "";
  const secret = env.BIZPOLE_CLIENT_SECRET ?? "";
  // The server decodes each part with decodeURIComponent, so encode them the same way.
  return `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
}

async function postForm(path: string, form: Record<string, string>) {
  const wait = tokenWindow.take("server");
  if (wait) throw new BizpoleBusy(wait);
  return send(
    urlFor(path),
    { method: "POST", headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(form).toString() },
    `/${path}`,
  );
}

/** POST /auth/token. Throws BizpoleApiError (e.g. 400 invalid_grant, 401 invalid_client) or BizpoleUnreachable. */
export async function requestToken(form: { grant_type: "connection_code"; code: string } | { grant_type: "refresh_token"; refresh_token: string }): Promise<BizpoleTokenResponse> {
  const { status, body, retryAfterSec } = await postForm("auth/token", form);
  if (status !== 200) throw toApiError(status, body, retryAfterSec);
  const t = body as Partial<BizpoleTokenResponse> | null;
  if (!t || typeof t.access_token !== "string" || typeof t.refresh_token !== "string" || typeof t.expires_in !== "number" || typeof t.grant_id !== "string" || !Array.isArray(t.companies)) {
    throw new BizpoleUnreachable("JournL answered the token request without the expected fields");
  }
  return t as BizpoleTokenResponse;
}

/** POST /auth/revoke (the client disconnects). True when Bizpole confirmed with 200; false when it couldn't be confirmed. */
export async function revokeGrant(refreshToken: string): Promise<boolean> {
  try {
    const { status } = await postForm("auth/revoke", { token: refreshToken });
    return status === 200;
  } catch (err) {
    logger.warn({ err: (err as Error).name }, "Bizpole revoke could not be confirmed");
    return false;
  }
}

/** GET a data route with the access token. `limitKey` is the connection the request counts against. */
export async function getJson<T>(accessToken: string, limitKey: string, path: string, query: Record<string, string> = {}): Promise<T> {
  const wait = dataWindow.take(limitKey);
  if (wait) throw new BizpoleBusy(wait);
  const { status, body, retryAfterSec } = await send(
    urlFor(path, query),
    { method: "GET", headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
    `/${path}`,
  );
  if (status !== 200) throw toApiError(status, body, retryAfterSec);
  if (body === null || typeof body !== "object") throw new BizpoleUnreachable("JournL answered with an unreadable body");
  return body as T;
}
