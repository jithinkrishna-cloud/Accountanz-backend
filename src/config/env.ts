import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.url().default("http://localhost:3000"),
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
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
