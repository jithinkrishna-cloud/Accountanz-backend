import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { BlobNotFoundError, del, get, put } from "@vercel/blob";
import { env } from "../config/env.js";
import { AppError } from "./app-error.js";

/**
 * Private file storage boundary, backed by a Vercel Blob store with `access: "private"`.
 * Blobs are never exposed by URL; they are only streamed back through authenticated API routes.
 *
 * Stored keys are blob pathnames ("agreements/2026/11/<uuid>.pdf"), which is what the DB keeps.
 */
const token = env.BLOB_READ_WRITE_TOKEN;

function assertKey(key: string) {
  const normalized = path.posix.normalize(key);
  if (!key || normalized !== key || key.startsWith("/") || key.startsWith("..")) throw AppError.forbidden("Invalid file path");
  return key;
}

export async function saveFile(folder: string, originalName: string, data: Buffer, contentType?: string): Promise<string> {
  const now = new Date();
  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
  const key = path.posix.join(folder, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), `${randomUUID()}${ext}`);
  await put(assertKey(key), data, {
    access: "private",
    token,
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: contentType || undefined,
  });
  return key;
}

export interface StoredFile {
  stream: Readable;
  contentType: string;
  size: number;
}

/** Opens a stored file for streaming; throws NOT_FOUND when the blob is missing. */
export async function openFile(key: string): Promise<StoredFile> {
  let result;
  try {
    result = await get(assertKey(key), { access: "private", token });
  } catch (err) {
    if (err instanceof BlobNotFoundError) throw AppError.notFound("File");
    throw err;
  }
  if (!result || result.statusCode !== 200) throw AppError.notFound("File");
  return {
    stream: Readable.fromWeb(result.stream as import("node:stream/web").ReadableStream<Uint8Array>),
    contentType: result.blob.contentType || "application/octet-stream",
    size: result.blob.size,
  };
}

/** Best-effort removal, e.g. of a replaced file or one whose DB write failed. */
export async function deleteFile(key: string | null | undefined) {
  if (!key) return;
  await del(assertKey(key), { token }).catch(() => undefined);
}
