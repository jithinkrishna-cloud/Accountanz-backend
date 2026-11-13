import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import { getJournlOverview } from "./journl-data.service.js";
import * as service from "./integration.service.js";
import type { IntegrationListQuery, JournlDataQuery, VerifyConnectionInput } from "./integration.validation.js";

export async function list(_req: Request, res: Response) {
  res.json(await service.listConnections(res.locals.query as IntegrationListQuery));
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await service.createConnection(req.user!, req.body));
}

export async function verify(req: Request, res: Response) {
  res.json(await service.verifyConnection(req.user!, (res.locals.params as IdParam).id, req.body as VerifyConnectionInput));
}

export async function healthCheck(req: Request, res: Response) {
  res.json(await service.runHealthCheck(req.user!, (res.locals.params as IdParam).id));
}

/** Read-only overview of the client's JournL books (GET only, nothing stored). */
export async function journlData(_req: Request, res: Response) {
  res.json(await getJournlOverview((res.locals.params as IdParam).id, res.locals.query as JournlDataQuery));
}
