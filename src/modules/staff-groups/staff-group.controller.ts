import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./staff-group.service.js";

const id = (res: Response) => (res.locals.params as IdParam).id;

export async function list(_req: Request, res: Response) {
  res.json({ items: await service.listGroups() });
}

export async function get(_req: Request, res: Response) {
  res.json(await service.getGroup(id(res)));
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await service.createGroup(req.user!, req.body));
}

export async function update(req: Request, res: Response) {
  res.json(await service.updateGroup(req.user!, id(res), req.body));
}

export async function remove(req: Request, res: Response) {
  await service.deleteGroup(req.user!, id(res));
  res.status(204).end();
}

export async function assign(req: Request, res: Response) {
  res.status(201).json(await service.assignGroup(req.user!, id(res), req.body));
}
