import type { Request, Response } from "express";
import * as service from "./settings.service.js";

export async function get(_req: Request, res: Response) {
  res.json(await service.getSettings());
}

export async function update(req: Request, res: Response) {
  res.json(await service.updateSettings(req.user!, req.body));
}
