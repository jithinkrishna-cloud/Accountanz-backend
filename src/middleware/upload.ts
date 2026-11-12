import type { RequestHandler } from "express";
import multer from "multer";
import { AppError } from "../utils/app-error.js";

const MB = 1024 * 1024;

/**
 * Parses a single multipart file field into memory (req.file). Files are checked by extension and
 * MIME type here; the service decides where they are stored.
 */
export function singleFile(field: string, opts: { maxMb: number; extensions: string[]; label: string }): RequestHandler {
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
      if (!req.file) {
        next(new AppError("VALIDATION_ERROR", `Choose a file for ${opts.label.toLowerCase()}`));
        return;
      }
      next();
    });
  };
}
