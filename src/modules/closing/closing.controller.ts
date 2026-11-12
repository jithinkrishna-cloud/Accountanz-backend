import type { Request, Response } from "express";
import * as service from "./closing.service.js";
import type { ClosingParams, ClosingStatusInput } from "./closing.validation.js";

export async function grid(_req: Request, res: Response) {
  res.json(await service.getGrid());
}

export async function setStatus(req: Request, res: Response) {
  const { clientId, period } = res.locals.params as ClosingParams;
  await service.setStatus(req.user!, clientId, period, (req.body as ClosingStatusInput).status);
  res.status(204).end();
}
