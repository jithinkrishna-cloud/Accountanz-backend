import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./package.service.js";

export async function list(_req: Request, res: Response) {
  res.json({ items: await service.listPackages() });
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await service.createPackage(req.user!, req.body));
}

export async function update(req: Request, res: Response) {
  res.json(await service.updatePackage(req.user!, (res.locals.params as IdParam).id, req.body));
}
