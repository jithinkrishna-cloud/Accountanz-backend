import type { Request, Response } from "express";
import * as service from "./approval.service.js";
import type { ApprovalListQuery, CreateApprovalInput } from "./approval.validation.js";

export const list = async (req: Request, res: Response) => void res.json(await service.listApprovals(req.user!, res.locals.query as ApprovalListQuery));
export const create = async (req: Request, res: Response) => void res.status(201).json(await service.requestApproval(req.user!, req.body as CreateApprovalInput));
