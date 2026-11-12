/**
 * Applies SQL files in ./migrations in name order, once each, tracked in `schema_migrations`.
 * `--fresh` drops and recreates the database first (development only).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { env, isProd } from "../config/env.js";
import { logger } from "../utils/logger.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

async function main() {
  const fresh = process.argv.includes("--fresh");
  if (fresh && isProd) throw new Error("--fresh is not allowed in production");

  const admin = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    multipleStatements: true,
  });
  if (fresh) {
    await admin.query(`DROP DATABASE IF EXISTS \`${env.DB_NAME}\``);
    logger.warn(`Dropped database ${env.DB_NAME}`);
  }
  await admin.query(
    `CREATE DATABASE IF NOT EXISTS \`${env.DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  );
  await admin.changeUser({ database: env.DB_NAME });
  await admin.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(255) PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  );

  const [doneRows] = await admin.query("SELECT name FROM schema_migrations");
  const done = new Set((doneRows as { name: string }[]).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    logger.info(`Applying ${file}`);
    await admin.query(sql);
    await admin.query("INSERT INTO schema_migrations (name) VALUES (?)", [file]);
  }
  await admin.end();
  logger.info("Migrations complete");
}

main().catch((err) => {
  logger.error(err, "Migration failed");
  process.exit(1);
});
