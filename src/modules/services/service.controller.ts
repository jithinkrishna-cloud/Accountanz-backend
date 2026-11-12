import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./service.service.js";

export async function list(_req: Request, res: Response) {
  res.json({ items: await service.listServices() });
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await service.createService(req.user!, req.body));
}

export async function update(req: Request, res: Response) {
  res.json(await service.updateService(req.user!, (res.locals.params as IdParam).id, req.body));
}
