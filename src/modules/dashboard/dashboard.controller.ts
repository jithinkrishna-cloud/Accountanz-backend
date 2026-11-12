import type { Request, Response } from "express";
import * as service from "./dashboard.service.js";

export async function admin(_req: Request, res: Response) {
  res.json(await service.getAdminDashboard());
}
