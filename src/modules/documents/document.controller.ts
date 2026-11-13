import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./document.service.js";
import type { CreateRequestInput, DocumentListQuery, DocumentStatusInput, RequestListQuery, StaffUploadInput } from "./document.validation.js";

const id = (res: Response) => (res.locals.params as IdParam).id;

export async function list(req: Request, res: Response) {
  res.json(await service.listDocuments(req.user!, res.locals.query as DocumentListQuery));
}

export async function upload(req: Request, res: Response) {
  res.status(201).json(await service.uploadDocument(req.user!, res.locals.body as StaffUploadInput, req.file!));
}

export async function setStatus(req: Request, res: Response) {
  res.json(await service.changeStatus(req.user!, id(res), (req.body as DocumentStatusInput).status));
}

export async function download(req: Request, res: Response) {
  const { file, name } = await service.openDocument(req.user!, id(res));
  res.setHeader("Cache-Control", "private, no-store");
  res.attachment(name);
  res.type(file.contentType);
  if (Number.isFinite(file.size)) res.setHeader("Content-Length", String(file.size));
  await pipeline(file.stream, res);
}

export async function requests(req: Request, res: Response) {
  res.json(await service.listRequests(req.user!, res.locals.query as RequestListQuery));
}

export async function createRequest(req: Request, res: Response) {
  res.status(201).json(await service.createRequest(req.user!, req.body as CreateRequestInput));
}

export async function cancelRequest(req: Request, res: Response) {
  res.json(await service.cancelRequest(req.user!, id(res)));
}
