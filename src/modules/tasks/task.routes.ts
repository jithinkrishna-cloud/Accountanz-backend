import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./task.controller.js";
import {
  checklistProgressSchema,
  createTaskSchema,
  generateTasksSchema,
  optionsQuerySchema,
  taskListQuerySchema,
  updateTaskSchema,
  workLogSchema,
} from "./task.validation.js";

/** Admin portal: /api/admin/tasks */
export const taskRoutes = Router();

taskRoutes.get("/", validate({ query: taskListQuerySchema }), controller.list);
taskRoutes.get("/options", validate({ query: optionsQuerySchema }), controller.options);
taskRoutes.post("/", validate({ body: createTaskSchema }), controller.create);
taskRoutes.post("/generate", validate({ body: generateTasksSchema }), controller.generate);
taskRoutes.get("/:id", validate({ params: idParam }), controller.get);
taskRoutes.patch("/:id", validate({ params: idParam, body: updateTaskSchema }), controller.update);

/** Accountant portal: /api/team/tasks. Same service; role rules are enforced there. */
export const staffTaskRoutes = Router();

staffTaskRoutes.get("/", validate({ query: taskListQuerySchema }), controller.listForStaff);
staffTaskRoutes.get("/options", validate({ query: optionsQuerySchema }), controller.options);
staffTaskRoutes.post("/", validate({ body: createTaskSchema }), controller.create);
staffTaskRoutes.get("/:id", validate({ params: idParam }), controller.get);
staffTaskRoutes.patch("/:id", validate({ params: idParam, body: updateTaskSchema }), controller.update);
staffTaskRoutes.put("/:id/checklist", validate({ params: idParam, body: checklistProgressSchema }), controller.checklist);
staffTaskRoutes.post("/:id/work-logs", validate({ params: idParam, body: workLogSchema }), controller.logWork);
staffTaskRoutes.post("/:id/submit", validate({ params: idParam }), controller.submit);
