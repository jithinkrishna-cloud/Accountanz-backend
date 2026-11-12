import type { Request, Response } from "express";
import * as service from "./review.service.js";
import type { TaskIdParam } from "./review.validation.js";

export async function overview(_req: Request, res: Response) {
  res.json(await service.getReviewOverview());
}

export async function staffQueue(req: Request, res: Response) {
  res.json({ queue: await service.getStaffReviewQueue(req.user!) });
}

export async function decide(req: Request, res: Response) {
  await service.decideReview(req.user!, (res.locals.params as TaskIdParam).taskId, req.body);
  res.status(204).end();
}
