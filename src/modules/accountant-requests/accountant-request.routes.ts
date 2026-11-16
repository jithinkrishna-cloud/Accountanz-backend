import { Router, type Request, type Response } from "express";
import { idParam, validate, type IdParam } from "../../middleware/validate.js";
import type { ClientContext } from "../client-portal/client-portal.types.js";
import * as service from "./accountant-request.service.js";
import { accountantRequestSchema, adminListQuerySchema, decisionSchema } from "./accountant-request.validation.js";

const ctx = (res: Response) => res.locals.client as ClientContext;
const id = (res: Response) => (res.locals.params as IdParam).id;

/** Client portal (mounted under /api/app, after the company context is resolved). */
export const exploreRoutes = Router();
exploreRoutes.get("/explore/accountants", async (_req: Request, res: Response) => void res.json({ items: await service.explore(ctx(res)) }));
exploreRoutes.get("/explore/accountants/:id", validate({ params: idParam }), async (_req, res) => void res.json(await service.exploreOne(ctx(res), id(res))));
exploreRoutes.post("/explore/accountants/:id/requests", validate({ params: idParam, body: accountantRequestSchema }), async (req, res) =>
  void res.status(201).json(await service.request(req.user!, ctx(res), id(res), req.body)),
);
exploreRoutes.get("/accountant-requests", async (_req, res) => void res.json({ items: await service.myRequests(ctx(res)) }));
exploreRoutes.post("/accountant-requests/:id/withdraw", validate({ params: idParam }), async (req, res) => void res.json(await service.withdraw(req.user!, ctx(res), id(res))));

/** Admin (mounted under /api/admin/accountant-requests). */
export const accountantRequestAdminRoutes = Router();
accountantRequestAdminRoutes.get("/", validate({ query: adminListQuerySchema }), async (_req, res) =>
  void res.json({ items: await service.adminList((res.locals.query as { status?: "pending" | "approved" | "declined" | "withdrawn" }).status) }),
);
accountantRequestAdminRoutes.post("/:id/decision", validate({ params: idParam, body: decisionSchema }), async (req, res) => void res.json(await service.decide(req.user!, id(res), req.body)));
