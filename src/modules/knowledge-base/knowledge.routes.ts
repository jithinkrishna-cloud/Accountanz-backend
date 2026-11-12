import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./knowledge.controller.js";
import { articleBodySchema, articleListQuerySchema } from "./knowledge.validation.js";

export const knowledgeRoutes = Router();

knowledgeRoutes.get("/", validate({ query: articleListQuerySchema }), controller.list);
knowledgeRoutes.post("/", validate({ body: articleBodySchema }), controller.create);
knowledgeRoutes.put("/:id", validate({ params: idParam, body: articleBodySchema }), controller.update);
knowledgeRoutes.delete("/:id", validate({ params: idParam }), controller.remove);
