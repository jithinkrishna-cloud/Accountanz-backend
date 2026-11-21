import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.url().default("http://localhost:3000"),
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
  /** JournL API base URL (e.g. https://testapi.bizpolebooks.com). Without it, owners can't sign in with JournL to connect. */
  JOURNL_API_URL: z.url().optional(),
  /** 32-byte base64 key that encrypts stored JournL session tokens. Without it, JournL data can't be read. */
  JOURNL_TOKEN_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, "JOURNL_TOKEN_KEY must be 32 bytes, base64").optional(),
  /**
   * JournL web address for "Open in JournL" (https). JournL picks the company from the login, not the URL, so today
   * this is just its sign-in page; `{companyId}` is filled in if JournL ever adds per-company links. The link never
   * carries a token. Unset = the button says the link isn't configured.
   */
  JOURNL_APP_URL_TEMPLATE: z
    .string()
    .optional()
    .refine((v) => !v || /^https:\/\//.test(v), "JOURNL_APP_URL_TEMPLATE must start with https://"),
  /** Master switch for writing corrections to JournL. Off unless explicitly enabled. */
  JOURNL_WRITES_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /** JournL API hostnames that corrections may be written to, comma-separated. Guards against writing to production by accident. */
  JOURNL_WRITE_HOSTS: z
    .string()
    .default("testapi.bizpolebooks.com")
    .transform((v) => v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)),
  /** Bizpole Books Integration API base, ending in /integration/v1 (e.g. https://testapi.bizpolebooks.com/integration/v1). */
  BIZPOLE_API_BASE_URL: z.url().optional(),
  /** Accountanz's partner credentials, issued by Bizpole. Server-side only; never sent to a browser or logged. */
  BIZPOLE_CLIENT_ID: z.string().min(1).optional(),
  BIZPOLE_CLIENT_SECRET: z.string().min(1).optional(),
  /** 32-byte base64 key that encrypts stored Bizpole access and refresh tokens (separate from JOURNL_TOKEN_KEY). */
  BIZPOLE_TOKEN_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, "BIZPOLE_TOKEN_KEY must be 32 bytes, base64").optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
