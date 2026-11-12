import { z } from "zod";

/** Optional text input: trims, and turns "" into null so the DB stores NULL rather than empty strings. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const upperOptional = (re: RegExp, message: string) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .nullish()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || re.test(v), message);

export const gstinSchema = upperOptional(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Enter a valid 15-character GSTIN");
export const panSchema = upperOptional(/^[A-Z]{5}\d{4}[A-Z]$/, "Enter a valid 10-character PAN");
export const ifscSchema = upperOptional(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Enter a valid 11-character IFSC");

export const money = z.coerce.number().min(0, "Must be 0 or more").max(9_999_999_999.99).multipleOf(0.01, "At most 2 decimals");

/** 'YYYY-MM' accounting period. */
export const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use the format YYYY-MM");
