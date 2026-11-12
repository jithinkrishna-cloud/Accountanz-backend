import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./task-template.controller.js";
import { itemBodySchema, itemIdParam, itemUpdateSchema, templateBodySchema } from "./task-template.validation.js";

export const taskTemplateRoutes = Router();

taskTemplateRoutes.get("/", controller.list);
taskTemplateRoutes.post("/", validate({ body: templateBodySchema }), controller.create);
taskTemplateRoutes.post("/:id/items", validate({ params: idParam, body: itemBodySchema }), controller.addItem);
taskTemplateRoutes.patch("/items/:itemId", validate({ params: itemIdParam, body: itemUpdateSchema }), controller.updateItem);
taskTemplateRoutes.delete("/items/:itemId", validate({ params: itemIdParam }), controller.deleteItem);
