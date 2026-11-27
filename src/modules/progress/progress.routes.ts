import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { idParam, validate, type IdParam } from "../../middleware/validate.js";
import { listQuerySchema } from "../../utils/pagination.js";
import { periodSchema } from "../../utils/zod-helpers.js";
import { TASK_VIEWS } from "./progress.repository.js";
import * as service from "./progress.service.js";

const progressQuery = z.object({ period: periodSchema.optional() });
type ProgressQuery = z.infer<typeof progressQuery>;
const taskQuery = listQuerySchema.extend({ view: z.enum(TASK_VIEWS).default("open"), client_id: z.coerce.number().int().positive().optional() });
type TaskQuery = z.infer<typeof taskQuery>;

/** Admin: /api/admin/progress. Read-only view of each team member's work. */
export const progressRoutes = Router();

progressRoutes.get("/", validate({ query: progressQuery }), async (_req: Request, res: Response) => {
  res.json(await service.listProgress((res.locals.query as ProgressQuery).period));
});

/** Per-client view of the firm (must come before /:id). */
progressRoutes.get("/firm", validate({ query: progressQuery }), async (_req: Request, res: Response) => {
  res.json(await service.firmProgress((res.locals.query as ProgressQuery).period));
});

progressRoutes.get("/:id", validate({ params: idParam, query: progressQuery }), async (_req: Request, res: Response) => {
  res.json(await service.personProgress((res.locals.params as IdParam).id, (res.locals.query as ProgressQuery).period));
});

/** One person's tasks, paged, by view. */
progressRoutes.get("/:id/tasks", validate({ params: idParam, query: taskQuery }), async (_req: Request, res: Response) => {
  res.json(await service.personTaskList((res.locals.params as IdParam).id, res.locals.query as TaskQuery));
});
