import type { RequestHandler } from "express";
import type { PortalRole } from "../types/auth.types.js";
import { AppError } from "../utils/app-error.js";

/** Allows the request only for the listed portal roles. Must run after `authenticate`. */
export const authorize =
  (...roles: readonly PortalRole[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) throw AppError.unauthenticated();
    if (!roles.includes(req.user.role)) throw AppError.forbidden();
    next();
  };
