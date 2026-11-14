import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import * as c from "./sprint.controller.js";
import { completeSprintSchema, sprintParam, updateSprintSchema } from "./sprint.validation.js";

/** /api/projects/:key/sprints (Scrum spaces). Mounted after the space is resolved. */
export const sprintRoutes = Router({ mergeParams: true });

sprintRoutes.get("/", c.list);
sprintRoutes.post("/", validate({ body: updateSprintSchema }), c.create);
sprintRoutes.patch("/:id", validate({ params: sprintParam, body: updateSprintSchema }), c.update);
sprintRoutes.post("/:id/start", validate({ params: sprintParam }), c.start);
sprintRoutes.post("/:id/complete", validate({ params: sprintParam, body: completeSprintSchema }), c.complete);
sprintRoutes.delete("/:id", validate({ params: sprintParam }), c.remove);
