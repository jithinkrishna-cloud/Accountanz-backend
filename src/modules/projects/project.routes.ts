import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { itemRoutes } from "../project-items/item.routes.js";
import { sprintRoutes } from "../project-sprints/sprint.routes.js";
import { withSpace } from "./project-access.js";
import * as c from "./project.controller.js";
import { WORKSPACE_ROLES } from "./project.types.js";
import {
  addMembersSchema,
  createSpaceSchema,
  deleteStatusSchema,
  keyAvailableQuery,
  memberParam,
  reorderStatusesSchema,
  searchQuery,
  statusIdParam,
  statusSchema,
  updateMemberSchema,
  updateSpaceSchema,
  updateStatusSchema,
} from "./project.validation.js";

/** Workspace API: /api/projects (Accountanz staff only; clients never reach it). */
export const projectRoutes = Router();
projectRoutes.use(authenticate, authorize(...WORKSPACE_ROLES));

projectRoutes.get("/", validate({ query: searchQuery.extend({ client_id: z.coerce.number().int().positive().optional() }) }), c.list);
projectRoutes.post("/", validate({ body: createSpaceSchema }), c.create);
projectRoutes.get("/key-available", validate({ query: keyAvailableQuery }), c.keyAvailable);
projectRoutes.get("/client-options", c.clientOptions);

/** Everything under /:key resolves the space and the caller's role once (404 for non-members). */
const space = Router({ mergeParams: true });
projectRoutes.use("/:key", withSpace, space);

space.get("/", c.get);
space.patch("/", validate({ body: updateSpaceSchema }), c.update);
space.get("/summary", validate({ query: z.object({ assignee_id: z.coerce.number().int().positive().optional() }) }), c.summary);

space.get("/statuses", c.statuses);
space.post("/statuses", validate({ body: statusSchema }), c.createStatus);
space.post("/statuses/reorder", validate({ body: reorderStatusesSchema }), c.reorderStatuses);
space.patch("/statuses/:id", validate({ params: statusIdParam, body: updateStatusSchema }), c.updateStatus);
space.delete("/statuses/:id", validate({ params: statusIdParam, body: deleteStatusSchema }), c.deleteStatus);

space.get("/members", c.members);
space.get("/staff-search", validate({ query: searchQuery }), c.staffSearch);
space.post("/members", validate({ body: addMembersSchema }), c.addMembers);
space.patch("/members/:userId", validate({ params: memberParam, body: updateMemberSchema }), c.changeRole);
space.delete("/members/:userId", validate({ params: memberParam }), c.removeMember);

space.use("/sprints", sprintRoutes);
space.use("/items", itemRoutes);
