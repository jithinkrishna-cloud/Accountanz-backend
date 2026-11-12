import type { RequestHandler } from "express";
import { ACCESS_COOKIE, verifyAccessToken } from "../modules/auth/auth.tokens.js";
import { findActiveUserById } from "../modules/users/user.repository.js";
import { AppError } from "../utils/app-error.js";

/**
 * Requires a valid access token (httpOnly cookie). The user is re-read from the DB on every
 * request so disabling a user or changing their role takes effect immediately.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const token: string | undefined = req.cookies?.[ACCESS_COOKIE];
  if (!token) throw AppError.unauthenticated();
  const payload = verifyAccessToken(token);
  if (!payload) throw AppError.unauthenticated("Your session has expired");
  const user = await findActiveUserById(payload.sub);
  if (!user) throw AppError.unauthenticated("Your account is not active");
  req.user = { id: user.id, email: user.email, fullName: user.full_name, role: user.portal_role };
  next();
};
