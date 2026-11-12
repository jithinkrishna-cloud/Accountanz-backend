import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./integration.service.js";
import type { IntegrationListQuery } from "./integration.validation.js";

export async function list(_req: Request, res: Response) {
  res.json(await service.listConnections(res.locals.query as IntegrationListQuery));
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await service.createConnection(req.user!, req.body));
}

export async function healthCheck(req: Request, res: Response) {
  res.json(await service.runHealthCheck(req.user!, (res.locals.params as IdParam).id));
}
