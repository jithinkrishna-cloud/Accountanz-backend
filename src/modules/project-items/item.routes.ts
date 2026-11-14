import { Router } from "express";
import { singleFile } from "../../middleware/upload.js";
import { validate } from "../../middleware/validate.js";
import * as c from "./item.controller.js";
import { ATTACHMENT_EXTENSIONS, ATTACHMENT_MAX_MB } from "./item.types.js";
import { childParam, commentSchema, createItemSchema, itemParam, listItemsQuery, moveItemSchema, updateItemSchema } from "./item.validation.js";

/** /api/projects/:key/items. Mounted after the space is resolved. */
export const itemRoutes = Router({ mergeParams: true });

const attachment = singleFile("file", { maxMb: ATTACHMENT_MAX_MB, extensions: ATTACHMENT_EXTENSIONS, label: "The attachment" });

itemRoutes.get("/", validate({ query: listItemsQuery }), c.list);
itemRoutes.post("/", validate({ body: createItemSchema }), c.create);
itemRoutes.get("/:number", validate({ params: itemParam }), c.get);
itemRoutes.patch("/:number", validate({ params: itemParam, body: updateItemSchema }), c.update);
itemRoutes.post("/:number/move", validate({ params: itemParam, body: moveItemSchema }), c.move);
itemRoutes.delete("/:number", validate({ params: itemParam }), c.remove);

itemRoutes.get("/:number/activity", validate({ params: itemParam }), c.activity);
itemRoutes.get("/:number/comments", validate({ params: itemParam }), c.comments);
itemRoutes.post("/:number/comments", validate({ params: itemParam, body: commentSchema }), c.addComment);
itemRoutes.patch("/:number/comments/:id", validate({ params: childParam, body: commentSchema }), c.editComment);
itemRoutes.delete("/:number/comments/:id", validate({ params: childParam }), c.deleteComment);

itemRoutes.post("/:number/attachments", validate({ params: itemParam }), attachment, c.addAttachment);
itemRoutes.get("/:number/attachments/:id", validate({ params: childParam }), c.downloadAttachment);
itemRoutes.delete("/:number/attachments/:id", validate({ params: childParam }), c.deleteAttachment);
