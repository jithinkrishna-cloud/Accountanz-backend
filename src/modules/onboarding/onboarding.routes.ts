import { Router } from "express";
import { idParam, validate } from "../../middleware/validate.js";
import * as controller from "./onboarding.controller.js";
import { assessmentBodySchema, onboardingListQuerySchema, prospectBodySchema, serviceRequirementsSchema, stageBodySchema } from "./onboarding.validation.js";

export const onboardingRoutes = Router();

onboardingRoutes.get("/", validate({ query: onboardingListQuerySchema }), controller.list);
onboardingRoutes.post("/", validate({ body: prospectBodySchema }), controller.create);
onboardingRoutes.get("/:id", validate({ params: idParam }), controller.get);
onboardingRoutes.put("/:id/assessment", validate({ params: idParam, body: assessmentBodySchema }), controller.saveAssessment);
onboardingRoutes.post("/:id/stage", validate({ params: idParam, body: stageBodySchema }), controller.changeStage);
onboardingRoutes.get("/:id/service-requirements", validate({ params: idParam }), controller.getServiceRequirements);
onboardingRoutes.put("/:id/service-requirements", validate({ params: idParam, body: serviceRequirementsSchema }), controller.saveServiceRequirements);
