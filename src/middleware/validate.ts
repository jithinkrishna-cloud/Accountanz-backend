import type { RequestHandler } from "express";
import { z, type ZodType } from "zod";
import { AppError } from "../utils/app-error.js";

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Parses body / query / params with Zod so handlers only see validated, coerced data.
 * Express 5 makes req.query read-only, so parsed query/params are stored on res.locals.
 */
export const validate =
  (schemas: Schemas): RequestHandler =>
  (req, res, next) => {
    for (const key of ["params", "query", "body"] as const) {
      const schema = schemas[key];
      if (!schema) continue;
      const result = schema.safeParse(req[key] ?? {});
      if (!result.success) {
        throw new AppError("VALIDATION_ERROR", "Please check the highlighted fields", z.flattenError(result.error));
      }
      if (key === "body") req.body = result.data;
      else res.locals[key] = result.data;
    }
    next();
  };

export const idParam = z.object({ id: z.coerce.number().int().positive() });
export type IdParam = z.infer<typeof idParam>;
