import { z } from "zod";
import { listQuerySchema } from "../../utils/pagination.js";
import { optionalText } from "../../utils/zod-helpers.js";

export const articleBodySchema = z.object({
  title: z.string().trim().min(2, "Enter a title").max(200),
  category: z.string().trim().min(2, "Enter a category").max(80),
  summary: optionalText(500),
  body: z.string().trim().min(1, "Write the article").max(60000),
});

export const articleListQuerySchema = listQuerySchema;
export type ArticleInput = z.infer<typeof articleBodySchema>;
