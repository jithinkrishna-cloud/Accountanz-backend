import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./permission.service.js";
import type { ModulePermissionBody, ModulePermissionParams } from "./permission.validation.js";

export async function catalog(_req: Request, res: Response) {
  res.json(await service.catalog());
}

export async function forAssignment(_req: Request, res: Response) {
  res.json(await service.assignmentPermissions((res.locals.params as IdParam).id));
}

export async function setModule(req: Request, res: Response) {
  const p = res.locals.params as ModulePermissionParams;
  res.json(await service.setModulePermission(req.user!, p.id, p.moduleKey, (req.body as ModulePermissionBody).actions));
}
