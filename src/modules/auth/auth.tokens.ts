import type { CookieOptions, Response } from "express";
import jwt from "jsonwebtoken";
import { env, isProd } from "../../config/env.js";
import { PORTAL_ROLES, type PortalRole } from "../../types/auth.types.js";

export const ACCESS_COOKIE = "acz_at";
export const REFRESH_COOKIE = "acz_rt";

/** The refresh cookie is only ever sent to the auth endpoints. */
const REFRESH_PATH = "/api/auth";

interface AccessPayload {
  sub: number;
  role: PortalRole;
}

const base: CookieOptions = { httpOnly: true, secure: isProd, sameSite: "lax" };

export function signAccessToken(userId: number, role: PortalRole): string {
  return jwt.sign({ role }, env.JWT_ACCESS_SECRET, {
    subject: String(userId),
    expiresIn: `${env.ACCESS_TOKEN_TTL_MIN}m`,
    algorithm: "HS256",
  });
}

export function verifyAccessToken(token: string): AccessPayload | null {
  try {
    const p = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] });
    if (typeof p === "string" || !p.sub) return null;
    const sub = Number(p.sub);
    const role = (p as { role?: unknown }).role;
    if (!Number.isInteger(sub) || !PORTAL_ROLES.includes(role as PortalRole)) return null;
    return { sub, role: role as PortalRole };
  } catch {
    return null;
  }
}

export const refreshTtlMs = () => env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...base, path: "/", maxAge: env.ACCESS_TOKEN_TTL_MIN * 60 * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...base, path: REFRESH_PATH, maxAge: refreshTtlMs() });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...base, path: "/" });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_PATH });
}
