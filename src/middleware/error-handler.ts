import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError } from "../utils/app-error.js";
import { logger } from "../utils/logger.js";

export const notFound: RequestHandler = (req) => {
  throw new AppError("NOT_FOUND", `No route for ${req.method} ${req.path}`);
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Request body is not valid JSON" } });
    return;
  }
  // Unique-key race that slipped past a service-level check.
  if (err?.code === "ER_DUP_ENTRY") {
    res.status(409).json({ error: { code: "CONFLICT", message: "A record with these details already exists" } });
    return;
  }
  logger.error({ err, path: req.path, method: req.method }, "Unhandled error");
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong. Please try again." } });
};
