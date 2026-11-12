import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./database/connection.js";
import { logger } from "./utils/logger.js";

const server = createApp().listen(env.PORT, () => {
  logger.info(`Accountanz API listening on http://localhost:${env.PORT}`);
});

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => logger.error({ reason }, "Unhandled promise rejection"));
