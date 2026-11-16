import type { Request, Response } from "express";
import * as service from "./journl-client-permission.service.js";
import type { ModulePermissionBody, ModulePermissionParams } from "../journl-permissions/permission.validation.js";
import type { ClientContext } from "./client-portal.types.js";

export async function catalog(_req: Request, res: Response) {
  res.json(await service.catalog());
}

export async function team(_req: Request, res: Response) {
  const ctx = res.locals.client as { clientId: number };
  res.json({ items: await service.team(ctx.clientId) });
}

export async function setModule(req: Request, res: Response) {
  const p = res.locals.params as ModulePermissionParams;
  const body = req.body as ModulePermissionBody;
  res.json(await service.setModulePermission(req.user!, res.locals.client as ClientContext, p.id, p.moduleKey, body.actions));
}

export async function activity(req: Request, res: Response) {
  const p = res.locals.params as { id: number };
  res.json({ items: await service.activity(req.user!, res.locals.client as ClientContext, p.id) });
}
