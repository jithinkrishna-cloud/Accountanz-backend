import express, { Router } from "express";
import { env } from "../../../config/env.js";
import { logger } from "../../../utils/logger.js";
import { applyEasebuzzResult, type Outcome } from "./easebuzz.service.js";

/**
 * Called by Easebuzz, not by a signed-in user, so there is no authentication: the response hash (checked with our
 * merchant salt) is what proves a request is genuine.
 */
export const easebuzzRoutes = Router();
easebuzzRoutes.use(express.urlencoded({ extended: false, limit: "100kb" })); // Easebuzz posts form data

/** The browser comes back here after paying (success and failure alike) and is sent on to the billing page. */
easebuzzRoutes.post("/return", async (req, res) => {
  let r: { outcome: Outcome; invoiceId?: number };
  try {
    r = await applyEasebuzzResult(req.body);
  } catch (err) {
    logger.error({ err }, "Easebuzz return failed");
    r = { outcome: "pending" }; // the webhook can still apply it; don't show the payer a raw error
  }
  const q = new URLSearchParams({ payment: r.outcome, ...(r.invoiceId ? { invoice: String(r.invoiceId) } : {}) });
  res.redirect(303, `${env.APP_URL}/app/billing?${q}`);
});

/** Server-to-server notification, in case the payer closed the tab before the return above. */
easebuzzRoutes.post("/webhook", async (req, res) => {
  const r = await applyEasebuzzResult(req.body);
  res.status(200).json({ received: r.outcome !== "invalid" }); // 200 even when rejected, so a bad payload isn't retried forever
});
