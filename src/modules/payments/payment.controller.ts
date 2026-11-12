import type { Request, Response } from "express";
import * as service from "./payment.service.js";
import type { PaymentListQuery } from "./payment.validation.js";

export async function list(_req: Request, res: Response) {
  res.json(await service.listPayments(res.locals.query as PaymentListQuery));
}

export async function openInvoices(_req: Request, res: Response) {
  res.json({ items: await service.listOpenInvoices() });
}

export async function record(req: Request, res: Response) {
  res.status(201).json(await service.recordPayment(req.user!, req.body));
}
