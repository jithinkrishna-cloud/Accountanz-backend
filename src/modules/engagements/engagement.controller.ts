import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./engagement.service.js";
import type { EngagementListQuery } from "./engagement.validation.js";

const id = (res: Response) => (res.locals.params as IdParam).id;

export async function list(_req: Request, res: Response) {
  res.json(await service.listEngagements(res.locals.query as EngagementListQuery));
}

export async function get(_req: Request, res: Response) {
  res.json(await service.getEngagement(id(res)));
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await service.createEngagement(req.user!, req.body));
}

export async function update(req: Request, res: Response) {
  res.json(await service.updateEngagement(req.user!, id(res), req.body));
}

export async function changeStatus(req: Request, res: Response) {
  res.json(await service.changeStatus(req.user!, id(res), req.body));
}

export async function uploadAgreement(req: Request, res: Response) {
  res.json(await service.uploadAgreement(req.user!, id(res), req.file!));
}

export async function downloadAgreement(_req: Request, res: Response) {
  const { file, name } = await service.agreementDownload(id(res));
  res.setHeader("Cache-Control", "private, no-store");
  res.attachment(name);
  res.type(file.contentType);
  if (Number.isFinite(file.size)) res.setHeader("Content-Length", String(file.size));
  await pipeline(file.stream, res);
}

export async function activateNow(req: Request, res: Response) {
  res.json(await service.activateNow(req.user!, id(res)));
}
