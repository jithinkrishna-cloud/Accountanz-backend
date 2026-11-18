import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import { getJournlOverview } from "./journl-data.service.js";
import { auditedJournlRead, requestContext } from "../audit/journl-read-audit.js";
import { queryOne } from "../../database/connection.js";
import * as service from "./integration.service.js";
import type { IntegrationListQuery, JournlDataQuery } from "./integration.validation.js";

export async function list(_req: Request, res: Response) {
  res.json(await service.listConnections(res.locals.query as IntegrationListQuery));
}

/** Read-only overview of the client's JournL books (GET only, nothing stored). Admin reads are audited like staff reads. */
export async function journlData(req: Request, res: Response) {
  const connectionId = (res.locals.params as IdParam).id;
  const period = res.locals.query as JournlDataQuery;
  const clientId = await connectionClientId(connectionId);
  const target = { feature: "overview", label: `Overview (connection #${connectionId})`, from: period.from, to: period.to };
  res.json(await auditedJournlRead(req.user!, clientId, requestContext(req), target, () => getJournlOverview(connectionId, period)));
}

async function connectionClientId(connectionId: number): Promise<number | null> {
  const row = await queryOne<{ client_id: number }>(`SELECT client_id FROM integration_connections WHERE id = ?`, [connectionId]);
  return row?.client_id ?? null;
}
