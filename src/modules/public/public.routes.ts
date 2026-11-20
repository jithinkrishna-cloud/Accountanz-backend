import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { publicAccountants } from "../accountant-requests/accountant-request.repository.js";
import { listPackages } from "../packages/package.repository.js";

/**
 * Unauthenticated, read-only data for the public home page. Keep everything here safe to show to anyone:
 * no ids, contact details, rates or performance numbers.
 */
export const publicRoutes = Router();

publicRoutes.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many requests. Please try again in a minute." } },
  }),
);

publicRoutes.get("/accountants", async (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({ items: await publicAccountants() });
});

/** Active packages as the public home page shows them: no ids or internal codes. */
export async function publicPackages() {
  const rows = await listPackages();
  return rows
    .filter((p) => p.is_active)
    .map((p) => ({
      name: p.name,
      description: p.description,
      monthly_fee: Number(p.monthly_fee),
      billing_cycle: p.billing_cycle,
      scope_notes: p.scope_notes,
      team_roles: parseRoles(p.team_roles),
      services: p.services.map((s) => s.name),
    }))
    .sort((a, b) => a.monthly_fee - b.monthly_fee);
}

function parseRoles(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

publicRoutes.get("/packages", async (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({ items: await publicPackages() });
});
