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
  const body = req.body as ModulePermissionBody & { grantSource?: "accountanz" | "client" };
  res.json(await service.setModulePermission(req.user!, p.id, p.moduleKey, body.actions, body.grantSource));
}

export const overview = async (_req: Request, res: Response) => void res.json(await service.accessOverview());
