import type { Request, Response } from "express";
import * as service from "./analytics.service.js";
import type { AnalyticsRange } from "./analytics.types.js";

export async function overview(_req: Request, res: Response) {
  res.json(await service.getOverview(Number((res.locals.query as { range: string }).range) as AnalyticsRange));
}
