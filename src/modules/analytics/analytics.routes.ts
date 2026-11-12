import { Router } from "express";
import * as controller from "./analytics.controller.js";

export const analyticsRoutes = Router();

analyticsRoutes.get("/", controller.overview);
