import type { Request, Response } from "express";
import { requestContext } from "../../audit/journl-read-audit.js";
import type { ClientContext } from "../../client-portal/client-portal.types.js";
import * as service from "./bizpole.service.js";
import type { ConnectInput, SelectCompanyInput, StaffParams, StaffQuery } from "./bizpole.validation.js";

/** Set by the client-portal router: the signed-in user's own company (never taken from the request). */
const ctx = (res: Response) => res.locals.client as ClientContext;

/* client portal (owner) */
export const status = async (_req: Request, res: Response) => void res.json(await service.view(ctx(res).clientId));
export const connect = async (req: Request, res: Response) => void res.status(201).json(await service.connect(req.user!, ctx(res), req.body as ConnectInput));
export const selectCompany = async (req: Request, res: Response) => void res.json(await service.selectCompany(req.user!, ctx(res), req.body as SelectCompanyInput));
export const disconnect = async (req: Request, res: Response) => void res.json(await service.disconnect(req.user!, ctx(res)));

/* staff (read-only data) */
export async function read(req: Request, res: Response) {
  const { id, resource } = res.locals.params as StaffParams;
  res.json(await service.staffRead(req.user!, id, resource, (res.locals.query ?? {}) as StaffQuery, requestContext(req)));
}
