import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.url().default("http://localhost:30001"),
  /** Extra browser origins allowed by CORS besides APP_URL, comma-separated (e.g. a dev tunnel). */
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean))
    .pipe(z.array(z.url())),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string().regex(/^[A-Za-z0-9_]+$/, "DB_NAME may only contain letters, digits and _"),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  SEED_PASSWORD: z.string().optional(),
  /** Resend API key (use a sending-only key). Without it, e-mails are written to the log instead of sent. */
  RESEND_API_KEY: z.string().startsWith("re_").optional(),
  /** Sender. Until a domain is verified in Resend, only onboarding@resend.dev works (and only to the account owner). */
  MAIL_FROM: z.string().min(3).default("Accountanz <onboarding@resend.dev>"),
  /** Development only: deliver every e-mail to this address instead of the real recipient. */
  MAIL_REDIRECT_TO: z.email().optional(),
  /** Vercel Blob read-write token for the private file store (agreements, documents). Uploads fail without it. */
  BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),
  /** Easebuzz merchant credentials. Without them, "Pay now" says online payments aren't set up. */
  EASEBUZZ_KEY: z.string().min(1).optional(),
  EASEBUZZ_SALT: z.string().min(1).optional(),
  EASEBUZZ_ENV: z.enum(["test", "prod"]).default("test"),
  /**
   * Public base URL that reaches this API; Easebuzz posts the browser back to `<it>/api/payments/easebuzz/return`.
   * Unset = APP_URL, which works because the frontend forwards /api/* to this server.
   */
  API_PUBLIC_URL: z.url().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
