import { Router } from "express";
import { multipartFields, singleFile } from "../../middleware/upload.js";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./report.controller.js";
import { createReportSchema, reportListQuerySchema } from "./report.validation.js";

const reportFile = singleFile("file", { maxMb: 20, extensions: ["pdf", "xls", "xlsx", "csv", "doc", "docx"], label: "The report", optional: true });

/** Mounted at /api/admin/reports and /api/team/reports; the service applies client access and publish rights. */
export const reportRoutes = Router();

reportRoutes.get("/", validate({ query: reportListQuerySchema }), controller.list);
reportRoutes.post("/", reportFile, multipartFields(createReportSchema), controller.create);
reportRoutes.post("/:id/publish", validate({ params: idParam }), controller.publish);
reportRoutes.post("/:id/unpublish", validate({ params: idParam }), controller.unpublish);
reportRoutes.delete("/:id", validate({ params: idParam }), controller.remove);
reportRoutes.get("/:id/file", validate({ params: idParam }), controller.download);
