import type { Request, Response } from "express";
import * as service from "./team.service.js";
import type { ClientIdParam, TeamListQuery, TeamNameInput } from "./team.validation.js";

export async function list(_req: Request, res: Response) {
  res.json(await service.listTeams(res.locals.query as TeamListQuery));
}

export async function clientOptions(_req: Request, res: Response) {
  res.json({ items: await service.listClientsWithoutTeam() });
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await service.createTeam(req.user!, req.body));
}

export async function rename(req: Request, res: Response) {
  res.json(await service.renameTeam(req.user!, (res.locals.params as ClientIdParam).clientId, (req.body as TeamNameInput).name));
}
