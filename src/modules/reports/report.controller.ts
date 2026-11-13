import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./report.service.js";
import type { CreateReportInput, ReportListQuery } from "./report.validation.js";

const id = (res: Response) => (res.locals.params as IdParam).id;

export const list = async (req: Request, res: Response) => void res.json(await service.listReports(req.user!, res.locals.query as ReportListQuery));
export const create = async (req: Request, res: Response) => void res.status(201).json(await service.createReport(req.user!, res.locals.body as CreateReportInput, req.file));
export const publish = async (req: Request, res: Response) => void res.json(await service.publishReport(req.user!, id(res)));
export const unpublish = async (req: Request, res: Response) => void res.json(await service.unpublishReport(req.user!, id(res)));

export async function remove(req: Request, res: Response) {
  await service.deleteReport(req.user!, id(res));
  res.status(204).end();
}

export async function download(req: Request, res: Response) {
  const { file, name } = await service.openReport(req.user!, id(res));
  res.setHeader("Cache-Control", "private, no-store");
  res.attachment(name);
  res.type(file.contentType);
  if (Number.isFinite(file.size)) res.setHeader("Content-Length", String(file.size));
  await pipeline(file.stream, res);
}
