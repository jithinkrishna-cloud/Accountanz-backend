import type { Request, Response } from "express";
import { spaceOf } from "./project-access.js";
import * as service from "./project.service.js";

type P = { id?: number; userId?: number };
const params = (res: Response) => res.locals.params as P;
const q = (res: Response) => (res.locals.query ?? {}) as Record<string, unknown>;

export const list = async (req: Request, res: Response) =>
  void res.json({ items: await service.listSpaces(req.user!, { q: q(res).q as string | undefined, client_id: q(res).client_id as number | undefined }) });
export const keyAvailable = async (_req: Request, res: Response) => void res.json(await service.isKeyAvailable(q(res).key as string));
export const clientOptions = async (_req: Request, res: Response) => void res.json({ items: await service.clientOptions() });
export const create = async (req: Request, res: Response) => void res.status(201).json(await service.createSpace(req.user!, req.body));
export const get = async (req: Request, res: Response) => void res.json(await service.getSpace(req.user!, spaceOf(res)));
export const update = async (req: Request, res: Response) => void res.json(await service.updateSpace(req.user!, spaceOf(res), req.body));

export const statuses = async (_req: Request, res: Response) => void res.json({ items: await service.listStatuses(spaceOf(res)) });
export const createStatus = async (req: Request, res: Response) => void res.status(201).json({ items: await service.createStatus(spaceOf(res), req.body) });
export const updateStatus = async (req: Request, res: Response) => void res.json({ items: await service.updateStatus(spaceOf(res), params(res).id!, req.body) });
export const deleteStatus = async (req: Request, res: Response) =>
  void res.json({ items: await service.deleteStatus(spaceOf(res), params(res).id!, (req.body as { move_to_status_id: number }).move_to_status_id) });
export const reorderStatuses = async (req: Request, res: Response) => void res.json({ items: await service.reorderStatuses(spaceOf(res), (req.body as { ids: number[] }).ids) });

export const members = async (_req: Request, res: Response) => void res.json({ items: await service.listMembers(spaceOf(res)) });
export const staffSearch = async (_req: Request, res: Response) => void res.json({ items: await service.searchStaff(spaceOf(res), q(res).q as string | undefined) });
export const addMembers = async (req: Request, res: Response) => void res.status(201).json({ items: await service.addMembers(req.user!, spaceOf(res), req.body) });
export const changeRole = async (req: Request, res: Response) =>
  void res.json({ items: await service.changeMemberRole(req.user!, spaceOf(res), params(res).userId!, (req.body as { role: "admin" | "member" }).role) });
export const removeMember = async (req: Request, res: Response) => void res.json({ items: await service.removeMember(req.user!, spaceOf(res), params(res).userId!) });

export const summary = async (_req: Request, res: Response) => void res.json(await service.getSummary(spaceOf(res), q(res).assignee_id as number | undefined));
