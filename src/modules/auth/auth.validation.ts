import { z } from "zod";
import { prospectBodySchema } from "../onboarding/onboarding.validation.js";

const email = z.email("Enter a valid email address").max(255).transform((v) => v.trim().toLowerCase());

/** At least 8 characters with a letter and a digit. */
export const passwordSchema = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(128, "Use at most 128 characters")
  .regex(/[A-Za-z]/, "Include at least one letter")
  .regex(/\d/, "Include at least one number");

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Enter your password").max(128),
});

export const registerSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your full name").max(150),
  email,
  password: passwordSchema,
  /** The company joining; becomes a lead client with an onboarding case. */
  company: prospectBodySchema.omit({ notes: true }),
});

export const accountantRoleSchema = z.enum(["bookkeeper", "finance_manager", "cfo"]);

export const registerAccountantSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your full name").max(150),
  email,
  phone: z.string().trim().max(30).optional().transform((v) => (v ? v : null)),
  password: passwordSchema,
  portal_role: accountantRoleSchema,
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type RegisterAccountantInput = z.infer<typeof registerAccountantSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
