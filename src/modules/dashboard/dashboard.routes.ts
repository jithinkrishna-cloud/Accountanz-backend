import { Router } from "express";
import * as controller from "./dashboard.controller.js";

export const dashboardRoutes = Router();

dashboardRoutes.get("/", controller.admin);
