import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./invoice.service.js";
import type { InvoiceListQuery, InvoiceStatusInput } from "./invoice.validation.js";

export async function list(_req: Request, res: Response) {
  res.json(await service.listInvoices(res.locals.query as InvoiceListQuery));
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await service.createInvoice(req.user!, req.body));
}

export async function setStatus(req: Request, res: Response) {
  res.json(await service.changeStatus(req.user!, (res.locals.params as IdParam).id, (req.body as InvoiceStatusInput).status));
}
