import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authRateLimit } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./auth.controller.js";
import { forgotPasswordSchema, loginSchema, registerAccountantSchema, registerSchema, resetPasswordSchema } from "./auth.validation.js";

export const authRoutes = Router();

authRoutes.post("/login", authRateLimit, validate({ body: loginSchema }), controller.login);
authRoutes.post("/register", authRateLimit, validate({ body: registerSchema }), controller.register);
authRoutes.post("/register-accountant", authRateLimit, validate({ body: registerAccountantSchema }), controller.registerAccountant);
authRoutes.post("/refresh", controller.refresh);
authRoutes.post("/logout", controller.logout);
authRoutes.get("/me", authenticate, controller.me);
authRoutes.post("/forgot-password", authRateLimit, validate({ body: forgotPasswordSchema }), controller.forgotPassword);
authRoutes.post("/reset-password", authRateLimit, validate({ body: resetPasswordSchema }), controller.resetPassword);
authRoutes.post("/accept-invite", authRateLimit, validate({ body: resetPasswordSchema }), controller.acceptInvite);
