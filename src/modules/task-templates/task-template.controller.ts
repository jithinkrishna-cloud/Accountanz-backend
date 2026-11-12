import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./task-template.service.js";
import type { ItemIdParam } from "./task-template.validation.js";

export async function list(_req: Request, res: Response) {
  res.json({ items: await service.listTemplates() });
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await service.createTemplate(req.user!, req.body));
}

export async function addItem(req: Request, res: Response) {
  res.status(201).json(await service.addItem(req.user!, (res.locals.params as IdParam).id, req.body));
}

export async function updateItem(req: Request, res: Response) {
  res.json(await service.updateItem(req.user!, (res.locals.params as ItemIdParam).itemId, req.body));
}

export async function deleteItem(req: Request, res: Response) {
  await service.deleteItem(req.user!, (res.locals.params as ItemIdParam).itemId);
  res.status(204).end();
}
