import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./workspace.service.js";
import type { JournlDataQuery } from "../integrations/integration.validation.js";
import type { ChecklistQuery, ClosingParams, ReadinessInput } from "./workspace.validation.js";

export const dashboard = async (req: Request, res: Response) => void res.json(await service.dashboard(req.user!));
export const clients = async (req: Request, res: Response) => void res.json({ items: await service.myClients(req.user!) });
export const clientOptions = async (req: Request, res: Response) => void res.json({ items: await service.clientOptions(req.user!) });
export const client = async (req: Request, res: Response) => void res.json(await service.clientOverview(req.user!, (res.locals.params as IdParam).id));
export const checklist = async (req: Request, res: Response) => void res.json(await service.checklist(req.user!, (res.locals.query as ChecklistQuery).period));

export async function setReadiness(req: Request, res: Response) {
  const p = res.locals.params as ClosingParams;
  res.json(await service.setReadiness(req.user!, p.clientId, p.period, (req.body as ReadinessInput).status, (req.body as ReadinessInput).reason));
}

/** Read-only JournL books for this client (GET only, live from JournL). */
export const clientJournlData = async (req: Request, res: Response) =>
  void res.json(await service.clientJournlData(req.user!, (res.locals.params as IdParam).id, res.locals.query as JournlDataQuery));
