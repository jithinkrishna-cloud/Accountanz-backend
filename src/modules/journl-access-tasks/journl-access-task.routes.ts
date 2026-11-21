import { Router, type Request, type Response } from "express";
import { idParam, validate, type IdParam } from "../../middleware/validate.js";
import * as service from "./journl-access-task.service.js";
import { accessTaskListQuerySchema, accessTaskUpdateSchema, type AccessTaskListQuery } from "./journl-access-task.validation.js";

export const journlAccessTaskRoutes = Router();

journlAccessTaskRoutes.get("/", validate({ query: accessTaskListQuerySchema }), async (_req: Request, res: Response) => {
  res.json(await service.listTasks(res.locals.query as AccessTaskListQuery));
});
journlAccessTaskRoutes.get("/options", async (_req: Request, res: Response) => {
  res.json({ responsible: await service.responsibleOptions() });
});
journlAccessTaskRoutes.patch("/:id", validate({ params: idParam, body: accessTaskUpdateSchema }), async (req: Request, res: Response) => {
  res.json(await service.updateTask(req.user!, (res.locals.params as IdParam).id, req.body));
});
