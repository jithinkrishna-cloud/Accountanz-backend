import type { Request, Response } from "express";
import * as service from "./analytics.service.js";

export async function overview(_req: Request, res: Response) {
  res.json(await service.getOverview());
}
