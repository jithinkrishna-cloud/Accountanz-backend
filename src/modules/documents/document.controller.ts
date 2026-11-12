import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import type { ListQuery } from "../../utils/pagination.js";
import * as service from "./document.service.js";
import type { DocumentListQuery, DocumentStatusInput } from "./document.validation.js";

export async function list(_req: Request, res: Response) {
  res.json(await service.listDocuments(res.locals.query as DocumentListQuery));
}

export async function setStatus(req: Request, res: Response) {
  res.json(await service.changeStatus(req.user!, (res.locals.params as IdParam).id, (req.body as DocumentStatusInput).status));
}

export async function download(_req: Request, res: Response) {
  const { file, name } = await service.openDocument((res.locals.params as IdParam).id);
  res.setHeader("Cache-Control", "private, no-store");
  res.attachment(name);
  res.type(file.contentType);
  if (Number.isFinite(file.size)) res.setHeader("Content-Length", String(file.size));
  await pipeline(file.stream, res);
}

export async function openRequests(_req: Request, res: Response) {
  res.json(await service.listOpenRequests(res.locals.query as ListQuery));
}
