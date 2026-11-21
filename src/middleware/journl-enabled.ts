import type { RequestHandler } from "express";
import { env } from "../config/env.js";
import { AppError } from "../utils/app-error.js";

/**
 * Hides a JournL integration route while JOURNL_INTEGRATION_ENABLED is off: the route answers 404 as if it didn't exist.
 * Accountants work in JournL directly with their own JournL login, so Accountanz doesn't read or write JournL data.
 */
export const journlEnabled: RequestHandler = (_req, _res, next) => {
  if (!env.JOURNL_INTEGRATION_ENABLED) throw AppError.notFound("Page");
  next();
};
