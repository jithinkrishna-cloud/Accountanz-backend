import { randomUUID } from "node:crypto";
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
import { projectRoutes } from "./modules/projects/project.routes.js";
import { publicRoutes } from "./modules/public/public.routes.js";
import { teamRoutes } from "./modules/team.routes.js";
import { logger } from "./utils/logger.js";

export function createApp() {
  const app = express();

  app.set("trust proxy", 1); // behind the Next.js rewrite / a reverse proxy
  app.disable("x-powered-by");
  app.use(helmet());
  // The browser normally talks to the API through the Next.js /api rewrite (same origin);
  // CORS only matters for direct calls during development.
  app.use(cors({ origin: [env.APP_URL, ...env.CORS_ORIGINS], credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === "/api/health" },
      // A per-request id (req.id) for logs and audit rows; echoed back so a user's report can be traced.
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader("x-request-id", id);
        return id;
      },
    }),
  );

  app.get("/api/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/team", teamRoutes);
  app.use("/api/app", clientPortalRoutes);
  app.use("/api/projects", projectRoutes);
  app.use("/api/public", publicRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
