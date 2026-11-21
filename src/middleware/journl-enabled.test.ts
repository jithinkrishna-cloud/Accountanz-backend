import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { env } from "../config/env.js";
import { errorHandler } from "./error-handler.js";
import { journlEnabled } from "./journl-enabled.js";

/** The JOURNL_INTEGRATION_ENABLED switch: a guarded route answers 404 while it's off, and runs normally while it's on. */
const original = env.JOURNL_INTEGRATION_ENABLED;
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.get("/guarded", journlEnabled, (_req, res) => void res.json({ ok: true }));
  app.get("/open", (_req, res) => void res.json({ ok: true }));
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  env.JOURNL_INTEGRATION_ENABLED = original;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("journlEnabled", () => {
  it("answers 404 while the integration is off, and leaves other routes alone", async () => {
    env.JOURNL_INTEGRATION_ENABLED = false;
    expect((await fetch(`${base}/guarded`)).status).toBe(404);
    expect((await fetch(`${base}/open`)).status).toBe(200);
  });

  it("lets the request through while the integration is on", async () => {
    env.JOURNL_INTEGRATION_ENABLED = true;
    const res = await fetch(`${base}/guarded`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
