import { z } from "zod";
import { BIZPOLE_RESOURCES, type BizpoleResource } from "./bizpole.types.js";

/** The owner pastes the connection code (BPC-XXXXX-XXXXX-XXXXX-XXXXX). Bizpole does the real check; this only bounds it. */
export const connectSchema = z.object({
  code: z.string().trim().min(8, "Paste the connection code from Bizpole Books").max(64, "That doesn't look like a connection code"),
});
export type ConnectInput = z.infer<typeof connectSchema>;

/** The company the owner chose from a pending grant (Bizpole company ids are numeric strings). */
export const selectCompanySchema = z.object({
  company_id: z.string().regex(/^\d{1,10}$/, "Choose a company"),
});
export type SelectCompanyInput = z.infer<typeof selectCompanySchema>;

const resources = Object.keys(BIZPOLE_RESOURCES) as [BizpoleResource, ...BizpoleResource[]];

export const staffParams = z.object({
  id: z.coerce.number().int().positive(),
  resource: z.enum(resources),
});
export type StaffParams = z.infer<typeof staffParams>;

/** Plain short strings only; the service keeps just the parameters that resource accepts. Bizpole validates values. */
export const staffQuery = z.record(z.string(), z.string().max(40, "Value too long"));
export type StaffQuery = z.infer<typeof staffQuery>;
