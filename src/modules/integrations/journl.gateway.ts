import { env } from "../../config/env.js";
import { AppError } from "../../utils/app-error.js";
import { logger } from "../../utils/logger.js";

/**
 * The one place Accountanz talks to JournL.
 *
 * - `signIn`: the client owner proves they own a JournL company by signing in with their JournL login.
 *   Accountanz forwards the email and password once to JournL's own `POST /auth/login` and never stores
 *   them. JournL issues the session, so the company it returns is JournL's answer, not the owner's claim.
 * - `journlGet`: GET-only reads with that session (about 8h; JournL has no refreshable partner token).
 * - `journlWrite`: the only code path that writes to JournL (corrections). Guarded by `assertWritesEnabled`.
 */
export interface JournlCompany {
  id: string;
  name: string;
  email: string | null;
}

/** JournL's own login token (JWT, about 8h) and when it expires. Used only for GET requests. */
export interface JournlSession {
  token: string;
  expiresAt: Date;
}

export type SignInResult =
  | { kind: "ok"; journlUserName: string; journlEmail: string; companies: JournlCompany[]; session: JournlSession | null }
  | { kind: "rejected"; reason: string; field?: "journl_email" | "journl_password" }
  | { kind: "unavailable"; reason: string };

export interface JournlGateway {
  /** True when JOURNL_API_URL is set, so owners can sign in with JournL. */
  signInAvailable: boolean;
  signIn(email: string, password: string): Promise<SignInResult>;
}

const UNAVAILABLE = "JournL can't be reached right now. Please try again in a few minutes.";
const TIMEOUT_MS = 15_000;

interface JournlLoginAccount {
  token?: string;
  name?: string;
  email?: string;
  role?: string;
  companyDetails?: { id?: number; name?: string; email?: string | null; isDeleted?: number }[];
}
interface JournlLoginResponse {
  success?: boolean;
  message?: string;
  code?: string;
  data?: JournlLoginAccount[];
}

/** Reads the expiry from JournL's JWT (not verified: JournL holds the key and checks it on every request). */
function sessionFrom(token: string | undefined): JournlSession | null {
  if (!token) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number };
    return payload.exp ? { token, expiresAt: new Date(payload.exp * 1000) } : null;
  } catch {
    return null;
  }
}

async function signIn(email: string, password: string): Promise<SignInResult> {
  if (!env.JOURNL_API_URL) return { kind: "unavailable", reason: "Signing in with JournL isn't set up on this server." };
  const url = new URL("auth/login", env.JOURNL_API_URL.endsWith("/") ? env.JOURNL_API_URL : `${env.JOURNL_API_URL}/`);

  let body: JournlLoginResponse;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 500) {
      logger.warn({ status: res.status }, "JournL login returned a server error");
      return { kind: "unavailable", reason: UNAVAILABLE };
    }
    body = (await res.json()) as JournlLoginResponse;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "JournL login request failed");
    return { kind: "unavailable", reason: UNAVAILABLE };
  }

  if (!body.success) {
    // JournL's own wording, for support: the mapping below is lossy (e.g. "invalid email or password" reads as a bad password).
    // Never log the email or password.
    logger.info({ journlMessage: body.message, journlCode: body.code }, "JournL sign-in rejected");
    const msg = (body.message ?? "").toLowerCase();
    if (msg.includes("not found")) return { kind: "rejected", field: "journl_email", reason: "No JournL account uses this email" };
    if (msg.includes("password")) return { kind: "rejected", field: "journl_password", reason: "That JournL password is incorrect" };
    if (body.code === "ACCOUNT_DELETED") return { kind: "rejected", reason: "This JournL company has been deleted" };
    return { kind: "rejected", reason: body.message ? `JournL: ${body.message}` : "JournL didn't accept this sign-in" };
  }

  // One email with several JournL accounts: JournL checks the password against only one of them,
  // so the list doesn't prove which companies this person owns.
  if (body.message === "Multiple users found") {
    return { kind: "rejected", field: "journl_email", reason: "This email has several JournL accounts. Sign in with the email of your JournL company account." };
  }

  const account = body.data?.[0];
  if (!account) return { kind: "unavailable", reason: UNAVAILABLE };
  if (account.role !== "company") {
    return { kind: "rejected", field: "journl_email", reason: "Sign in with your JournL company owner account, not a staff login" };
  }
  const companies = (account.companyDetails ?? [])
    .filter((c) => typeof c.id === "number" && !c.isDeleted)
    .map((c) => ({ id: String(c.id), name: c.name?.trim() || `Company ${c.id}`, email: c.email ?? null }));
  if (companies.length === 0) return { kind: "rejected", reason: "This JournL account has no active company" };

  return { kind: "ok", journlUserName: account.name ?? email, journlEmail: account.email ?? email, companies, session: sessionFrom(account.token) };
}

export type ReadResult<T = unknown> = { kind: "ok"; data: T } | { kind: "expired" } | { kind: "failed"; reason: string };

/**
 * Reads from JournL with the owner's session. GET only: this function has no way to send POST/PUT/PATCH/DELETE.
 * Writes go only through `journlWrite` below.
 */
export async function journlGet<T = unknown>(token: string, path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<ReadResult<T>> {
  if (!env.JOURNL_API_URL) return { kind: "failed", reason: "JournL isn't set up on this server" };
  const url = new URL(path.replace(/^\//, ""), env.JOURNL_API_URL.endsWith("/") ? env.JOURNL_API_URL : `${env.JOURNL_API_URL}/`);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  try {
    const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401) return { kind: "expired" };
    const body = (await res.json().catch(() => null)) as { success?: boolean; message?: string; data?: T } | null;
    if (!res.ok || !body || body.success === false) {
      return { kind: "failed", reason: body?.message ? `JournL: ${body.message}` : `JournL answered ${res.status}` };
    }
    return { kind: "ok", data: body.data as T };
  } catch (err) {
    logger.warn({ err: (err as Error).message, path }, "JournL read failed");
    return { kind: "failed", reason: UNAVAILABLE };
  }
}

export type WriteResult<T = unknown> =
  | { kind: "ok"; data: T }
  | { kind: "rejected"; status: number; message: string }
  | { kind: "session"; message: string }
  | { kind: "unknown"; reason: string };

const WRITES_DISABLED = "JournL corrections are disabled in this environment";
const WRITE_TIMEOUT_MS = 20_000;

/** Throws unless JOURNL_WRITES_ENABLED is true and the JOURNL_API_URL host is allow-listed for writes. */
export function assertWritesEnabled(): void {
  if (!env.JOURNL_WRITES_ENABLED || !env.JOURNL_API_URL) throw new AppError("UNAVAILABLE", WRITES_DISABLED);
  let host: string;
  try {
    const u = new URL(env.JOURNL_API_URL);
    if (u.protocol !== "https:") throw new Error("not https");
    host = u.hostname.toLowerCase();
  } catch {
    throw new AppError("UNAVAILABLE", WRITES_DISABLED);
  }
  if (!env.JOURNL_WRITE_HOSTS.includes(host)) throw new AppError("UNAVAILABLE", WRITES_DISABLED);
}

/**
 * The only JournL write path. Guarded by `assertWritesEnabled`; sent exactly once (no retry), 20s timeout.
 * Never logs the token, request body or response body: only method, path and HTTP status.
 * `ok` carries the whole parsed JSON body; callers pick `data.data`.
 */
export async function journlWrite<T = unknown>(token: string, method: "POST" | "PUT", path: string, body: unknown): Promise<WriteResult<T>> {
  assertWritesEnabled();
  const base = env.JOURNL_API_URL as string;
  // `path` must be a plain relative path: no scheme, no `//` or backslash tricks that change the host.
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.includes("\\") || path.startsWith("//")) throw new Error("journlWrite: path must be a relative path");
  const baseUrl = new URL(base.endsWith("/") ? base : `${base}/`);
  const url = new URL(path.replace(/^\//, ""), baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) throw new Error("journlWrite: path escapes the JournL API base");
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      redirect: "manual",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as Error).name;
    const timedOut = name === "AbortError" || name === "TimeoutError";
    const cause = (err as { cause?: { code?: unknown } }).cause?.code;
    logger.warn({ method, path, timedOut, errName: name, errCode: typeof cause === "string" ? cause : undefined }, "JournL write did not complete");
    return { kind: "unknown", reason: timedOut ? "JournL did not answer in time" : "JournL could not be reached" };
  }
  logger.info({ method, path, status: res.status }, "JournL write answered");

  // Never follow redirects: a followed POST can turn into a GET (reported as ok) or be re-sent elsewhere.
  if (res.type === "opaqueredirect" || res.status === 0 || res.redirected || (res.status >= 300 && res.status < 400)) {
    return { kind: "unknown", reason: "JournL answered with a redirect" };
  }

  const parsed = (await res.json().catch(() => null)) as { success?: boolean; message?: string; code?: string } | null;
  const json = parsed && typeof parsed === "object" ? parsed : null;
  const message = typeof json?.message === "string" && json.message ? json.message : `JournL answered ${res.status}`;

  // `session` only when JournL certainly did not apply the write: 401, or an expired-session code on a 4xx / success:false answer.
  const expiredCode = json?.code === "SESSION_EXPIRED" || json?.code === "TOKEN_EXPIRED";
  const notApplied = (res.status >= 400 && res.status < 500) || (res.status >= 200 && res.status < 300 && json?.success === false);
  if (res.status === 401 || (expiredCode && notApplied)) {
    return { kind: "session", message: "Your JournL session has expired" };
  }
  if (res.status >= 500) return { kind: "unknown", reason: `JournL answered ${res.status}` };
  if (!json) return { kind: "unknown", reason: `JournL answered ${res.status} with an unreadable body` };
  if (res.status >= 400) return { kind: "rejected", status: res.status, message };
  if (res.status >= 200 && res.status < 300) {
    if (json.success === true) return { kind: "ok", data: json as T };
    if (json.success === false) return { kind: "rejected", status: res.status, message };
    return { kind: "unknown", reason: "JournL answered without a success flag" };
  }
  return { kind: "unknown", reason: `JournL answered ${res.status}` };
}

const gateway: JournlGateway = {
  signInAvailable: !!env.JOURNL_API_URL,
  signIn,
};

export const journlGateway: JournlGateway = gateway;
