import pino from "pino";
import { isProd } from "../config/env.js";

export const logger = pino({
  level: isProd ? "info" : "debug",
  redact: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']", "*.password", "*.password_hash"],
  ...(isProd ? {} : { transport: { target: "pino-pretty", options: { colorize: true, ignore: "pid,hostname" } } }),
});
