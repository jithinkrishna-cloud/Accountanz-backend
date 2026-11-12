import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { gstinSchema, optionalText, panSchema } from "../../utils/zod-helpers.js";
import { ACCOUNTING_SOFTWARE, CLIENT_STATUSES } from "./client.types.js";

export const clientBodySchema = z.object({
  legal_name: z.string().trim().min(2, "Enter the legal name").max(200),
  trade_name: optionalText(200),
  gstin: gstinSchema,
  pan: panSchema,
  state: optionalText(60),
  address: optionalText(500),
  status: z.enum(CLIENT_STATUSES).default("lead"),
  accounting_software: z.enum(ACCOUNTING_SOFTWARE).default("none"),
});

export const clientUpdateSchema = clientBodySchema.partial().refine((v) => Object.keys(v).length > 0, "Nothing to update");

export const clientListQuerySchema = listQuerySchema.extend({
  status: z.enum(CLIENT_STATUSES).optional(),
});

export type ClientInput = z.infer<typeof clientBodySchema>;
export type ClientUpdateInput = z.infer<typeof clientUpdateSchema>;
export type ClientListQuery = z.infer<typeof clientListQuerySchema>;

export const inviteClientUserSchema = z.object({
  full_name: z.string().trim().min(2, "Enter the full name").max(150),
  email: z.email("Enter a valid email address").max(255).transform((v) => v.trim().toLowerCase()),
  phone: optionalText(30),
  role: z.enum(["owner", "member"]).default("member"),
  can_approve: z.boolean().default(false),
});
export type InviteClientUserInput = z.infer<typeof inviteClientUserSchema>;
