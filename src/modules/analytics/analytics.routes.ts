import { Router } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate.js";
import * as controller from "./analytics.controller.js";

/** ?range=3|6|12 months (default 6). */
const overviewQuery = z.object({ range: z.enum(["3", "6", "12"]).default("6") });

export const analyticsRoutes = Router();

analyticsRoutes.get("/", validate({ query: overviewQuery }), controller.overview);
