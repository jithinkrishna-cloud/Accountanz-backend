import rateLimit from "express-rate-limit";

/** Brute-force protection for credential endpoints. */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many attempts. Please wait a few minutes and try again." } },
});
