import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { pool } from "./database/connection.js";
import { errorHandler, notFound } from "./middleware/error-handler.js";
import { adminRoutes } from "./modules/admin.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { clientPortalRoutes } from "./modules/client-portal/client-portal.routes.js";
import { teamRoutes } from "./modules/team.routes.js";
import { logger } from "./utils/logger.js";

export function createApp() {
  const app = express();

  app.set("trust proxy", 1); // behind the Next.js rewrite / a reverse proxy
  app.disable("x-powered-by");
  app.use(helmet());
  // The browser normally talks to the API through the Next.js /api rewrite (same origin);
  // CORS only matters for direct calls during development.
  app.use(cors({ origin: env.APP_URL, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/api/health" } }));

  app.get("/api/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/team", teamRoutes);
  app.use("/api/app", clientPortalRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
