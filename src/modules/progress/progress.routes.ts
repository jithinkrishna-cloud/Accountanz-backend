import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { idParam, validate, type IdParam } from "../../middleware/validate.js";
import { periodSchema } from "../../utils/zod-helpers.js";
import * as service from "./progress.service.js";

const progressQuery = z.object({ period: periodSchema.optional() });
type ProgressQuery = z.infer<typeof progressQuery>;

/** Admin: /api/admin/progress. Read-only view of each team member's work. */
export const progressRoutes = Router();

progressRoutes.get("/", validate({ query: progressQuery }), async (_req: Request, res: Response) => {
  res.json(await service.listProgress((res.locals.query as ProgressQuery).period));
});

progressRoutes.get("/:id", validate({ params: idParam, query: progressQuery }), async (_req: Request, res: Response) => {
  res.json(await service.personProgress((res.locals.params as IdParam).id, (res.locals.query as ProgressQuery).period));
});
