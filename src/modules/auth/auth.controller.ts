import type { Request, Response } from "express";
import * as service from "./auth.service.js";
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from "./auth.tokens.js";

export async function login(req: Request, res: Response) {
  const { user, session } = await service.login(req.body);
  setAuthCookies(res, session.accessToken, session.refreshToken);
  res.json({ user });
}

export async function register(req: Request, res: Response) {
  const { user, session } = await service.register(req.body);
  setAuthCookies(res, session.accessToken, session.refreshToken);
  res.status(201).json({ user });
}

export async function registerAccountant(req: Request, res: Response) {
  res.status(201).json(await service.registerAccountant(req.body));
}

export async function refresh(req: Request, res: Response) {
  try {
    const { user, session } = await service.refresh(req.cookies?.[REFRESH_COOKIE]);
    setAuthCookies(res, session.accessToken, session.refreshToken);
    res.json({ user });
  } catch (err) {
    clearAuthCookies(res);
    throw err;
  }
}

export async function logout(req: Request, res: Response) {
  await service.logout(req.cookies?.[REFRESH_COOKIE]);
  clearAuthCookies(res);
  res.status(204).end();
}

export async function me(req: Request, res: Response) {
  res.json({ user: await service.getMe(req.user!.id) });
}

export async function forgotPassword(req: Request, res: Response) {
  await service.forgotPassword(req.body.email);
  res.json({ message: "If an account exists for that email, we've sent a link to reset the password." });
}

export async function resetPassword(req: Request, res: Response) {
  await service.resetPassword(req.body);
  res.json({ message: "Your password has been updated. You can sign in now." });
}

export async function acceptInvite(req: Request, res: Response) {
  await service.acceptInvite(req.body);
  res.json({ message: "Your account is ready. You can sign in now." });
}
