import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import { getJournlOverview } from "./journl-data.service.js";
import * as service from "./integration.service.js";
import type { IntegrationListQuery, JournlDataQuery } from "./integration.validation.js";

export async function list(_req: Request, res: Response) {
  res.json(await service.listConnections(res.locals.query as IntegrationListQuery));
}

/** Read-only overview of the client's JournL books (GET only, nothing stored). */
export async function journlData(_req: Request, res: Response) {
  res.json(await getJournlOverview((res.locals.params as IdParam).id, res.locals.query as JournlDataQuery));
}
