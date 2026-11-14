import type { Request, Response } from "express";
import { spaceOf } from "../projects/project-access.js";
import * as service from "./sprint.service.js";

const idOf = (res: Response) => (res.locals.params as { id: number }).id;

export const list = async (req: Request, res: Response) => void res.json({ items: await service.listSprints(spaceOf(res), req.query.include_completed === "true") });
export const create = async (req: Request, res: Response) => void res.status(201).json(await service.createSprint(spaceOf(res), req.body ?? {}));
export const update = async (req: Request, res: Response) => void res.json(await service.updateSprint(spaceOf(res), idOf(res), req.body));
export const start = async (_req: Request, res: Response) => void res.json(await service.startSprint(spaceOf(res), idOf(res)));
export const complete = async (req: Request, res: Response) =>
  void res.json(await service.completeSprint(spaceOf(res), idOf(res), (req.body as { move_to_sprint_id: number | null }).move_to_sprint_id));
export async function remove(_req: Request, res: Response) {
  await service.deleteSprint(spaceOf(res), idOf(res));
  res.status(204).end();
}
