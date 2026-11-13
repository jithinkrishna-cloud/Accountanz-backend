import type { Request, Response } from "express";
import * as service from "./closing.service.js";
import type { ClosingParams, ClosingStatusInput } from "./closing.validation.js";

export async function grid(_req: Request, res: Response) {
  res.json(await service.getGrid());
}

export async function setStatus(req: Request, res: Response) {
  const { clientId, period } = res.locals.params as ClosingParams;
  const body = req.body as ClosingStatusInput;
  await service.setStatus(req.user!, clientId, period, body.status, body.reason);
  res.status(204).end();
}
