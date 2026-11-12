import type { Request, Response } from "express";
import type { IdParam } from "../../middleware/validate.js";
import * as service from "./client.service.js";
import type { ClientListQuery } from "./client.validation.js";

export async function list(_req: Request, res: Response) {
  res.json(await service.listClients(res.locals.query as ClientListQuery));
}

export async function get(_req: Request, res: Response) {
  res.json(await service.getClient((res.locals.params as IdParam).id));
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await service.createClient(req.user!, req.body));
}

export async function update(req: Request, res: Response) {
  res.json(await service.updateClient(req.user!, (res.locals.params as IdParam).id, req.body));
}

export async function inviteUser(req: Request, res: Response) {
  res.status(201).json(await service.inviteClientUser(req.user!, (res.locals.params as IdParam).id, req.body));
}
