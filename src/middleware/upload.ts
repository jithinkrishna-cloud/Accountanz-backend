import type { RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import { AppError } from "../utils/app-error.js";

const MB = 1024 * 1024;

/**
 * Parses a single multipart file field into memory (req.file). Files are checked by extension and
 * MIME type here; the service decides where they are stored.
 */
export function singleFile(field: string, opts: { maxMb: number; extensions: string[]; label: string; optional?: boolean }): RequestHandler {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: opts.maxMb * MB, files: 1 },
    fileFilter: (_req, file, cb) => {
      const ext = file.originalname.toLowerCase().split(".").pop() ?? "";
      if (!opts.extensions.includes(ext)) {
        cb(new AppError("VALIDATION_ERROR", `${opts.label} must be one of: ${opts.extensions.join(", ").toUpperCase()}`));
        return;
      }
      cb(null, true);
    },
  }).single(field);

  return (req, res, next) => {
    handler(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        const message = err.code === "LIMIT_FILE_SIZE" ? `${opts.label} must be ${opts.maxMb} MB or smaller` : `Upload failed: ${err.message}`;
        next(new AppError("VALIDATION_ERROR", message));
        return;
      }
      if (err) {
        next(err);
        return;
      }
      if (!req.file && !opts.optional) {
        next(new AppError("VALIDATION_ERROR", `Choose a file for ${opts.label.toLowerCase()}`));
        return;
      }
      next();
    });
  };
}

/** Client documents (portal uploads and staff uploads): one owner for the accepted formats and size. */
export const documentUpload = () =>
  singleFile("file", { maxMb: 20, extensions: ["pdf", "png", "jpg", "jpeg", "xls", "xlsx", "csv", "doc", "docx", "zip"], label: "The document" });

/** Multipart text fields arrive as strings after the file is parsed; validate them like a JSON body. */
export function multipartFields(schema: z.ZodType): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      next(new AppError("VALIDATION_ERROR", "Please check the highlighted fields", z.flattenError(parsed.error)));
      return;
    }
    res.locals.body = parsed.data;
    next();
  };
}
