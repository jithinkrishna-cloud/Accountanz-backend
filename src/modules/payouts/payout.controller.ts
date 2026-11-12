import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./payout.service.js";
import type { MarkPaidInput, PayoutPeriodQuery } from "./payout.validation.js";

export async function list(_req: Request, res: Response) {
  res.json(await service.getPayouts((res.locals.query as PayoutPeriodQuery).period));
}

export async function generate(req: Request, res: Response) {
  res.status(201).json(await service.generateRun(req.user!, req.body.period));
}

export async function approve(req: Request, res: Response) {
  await service.approve(req.user!, (res.locals.params as IdParam).id);
  res.status(204).end();
}

export async function markPaid(req: Request, res: Response) {
  await service.markPaid(req.user!, (res.locals.params as IdParam).id, (req.body as MarkPaidInput).reference);
  res.status(204).end();
}
