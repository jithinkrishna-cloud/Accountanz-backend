import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { publicAccountants } from "../accountant-requests/accountant-request.repository.js";

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
