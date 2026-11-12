import { z } from "zod";

export const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const offsetOf = (q: { page: number; pageSize: number }) => (q.page - 1) * q.pageSize;
