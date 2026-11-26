import { Router } from "express";
import { documentUpload, multipartFields } from "../../middleware/upload.js";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./document.controller.js";
import { moveDocumentSchema, renameFolderSchema } from "../document-folders/document-folder.validation.js";
import { createRequestSchema, documentListQuerySchema, documentStatusSchema, requestListQuerySchema, staffCreateFolderSchema, staffFolderListQuerySchema, staffUploadSchema } from "./document.validation.js";

/** Mounted at /api/admin/documents and /api/team/documents; the service applies each user's client access. */
export const documentRoutes = Router();

documentRoutes.get("/", validate({ query: documentListQuerySchema }), controller.list);
documentRoutes.post("/", documentUpload(), multipartFields(staffUploadSchema), controller.upload);
documentRoutes.get("/requests", validate({ query: requestListQuerySchema }), controller.requests);
documentRoutes.post("/requests", validate({ body: createRequestSchema }), controller.createRequest);
documentRoutes.post("/requests/:id/cancel", validate({ params: idParam }), controller.cancelRequest);
documentRoutes.get("/folders", validate({ query: staffFolderListQuerySchema }), controller.folders);
documentRoutes.post("/folders", validate({ body: staffCreateFolderSchema }), controller.createFolder);
documentRoutes.patch("/folders/:id", validate({ params: idParam, body: renameFolderSchema }), controller.renameFolder);
documentRoutes.delete("/folders/:id", validate({ params: idParam }), controller.deleteFolder);
documentRoutes.patch("/:id/folder", validate({ params: idParam, body: moveDocumentSchema }), controller.moveToFolder);
documentRoutes.patch("/:id/status", validate({ params: idParam, body: documentStatusSchema }), controller.setStatus);
documentRoutes.get("/:id/file", validate({ params: idParam }), controller.download);
