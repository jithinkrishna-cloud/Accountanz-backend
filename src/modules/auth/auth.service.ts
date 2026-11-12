import bcrypt from "bcryptjs";
import type { PoolConnection } from "mysql2/promise";
import { env } from "../../config/env.js";
import { pool, withTransaction } from "../../database/connection.js";
import { portalOf, type AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { newOpaqueToken, sha256 } from "../../utils/crypto.js";
import { logger } from "../../utils/logger.js";
import { inviteEmail, passwordChangedEmail, passwordResetEmail } from "../../emails/templates.js";
import { humanize } from "../../utils/format.js";
import { sendMail } from "../../utils/mailer.js";
import { recordAudit } from "../audit/audit.service.js";
import { linkClientUser } from "../clients/client.repository.js";
import { notifyCompanyRegistered } from "../notifications/notification.service.js";
import { openProspect } from "../onboarding/onboarding.service.js";
import { findUserByEmail, findUserById, insertUser, isRejectedStaff, setPassword, touchLastLogin } from "../users/user.repository.js";
import type { PublicUser, UserRow } from "../users/user.types.js";
import * as repo from "./auth.repository.js";
import { refreshTtlMs, signAccessToken } from "./auth.tokens.js";
import type { IssuedSession, UserTokenPurpose } from "./auth.types.js";
import type { LoginInput, RegisterInput, ResetPasswordInput } from "./auth.validation.js";

const BCRYPT_ROUNDS = 12;
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Compared against when the e-mail is unknown, so response time does not reveal which accounts exist.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", BCRYPT_ROUNDS);

export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_ROUNDS);

export const toPublicUser = (u: Pick<UserRow, "id" | "email" | "full_name" | "portal_role">): PublicUser => ({
  id: u.id,
  email: u.email,
  fullName: u.full_name,
  role: u.portal_role,
  portal: portalOf(u.portal_role),
});

const toAuthUser = (u: UserRow): AuthUser => ({ id: u.id, email: u.email, fullName: u.full_name, role: u.portal_role });

async function issueSession(user: UserRow, db?: PoolConnection): Promise<IssuedSession> {
  const refreshToken = newOpaqueToken();
  await repo.insertRefreshToken(user.id, sha256(refreshToken), new Date(Date.now() + refreshTtlMs()), db ?? pool);
  return { accessToken: signAccessToken(user.id, user.portal_role), refreshToken };
}

export async function login(input: LoginInput): Promise<{ user: PublicUser; session: IssuedSession }> {
  const user = await findUserByEmail(input.email);
  const ok = await bcrypt.compare(input.password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !user.password_hash || !ok) throw AppError.unauthenticated("Incorrect email or password");
  if (user.status !== "active") throw AppError.forbidden("This account is not active. Contact your administrator.");
  if (await isRejectedStaff(user.id)) throw AppError.forbidden("Your verification was rejected, so you can't sign in. Contact your administrator.");

  const session = await issueSession(user);
  await touchLastLogin(user.id);
  return { user: toPublicUser(user), session };
}

/**
 * A company joins through the platform: the person becomes the owner of a new lead client whose
 * onboarding case starts at "registered", exactly as if an admin had added the prospect. Admins are e-mailed.
 */
export async function register(input: RegisterInput): Promise<{ user: PublicUser; session: IssuedSession }> {
  if (await findUserByEmail(input.email)) {
    const message = "An account with this email already exists";
    throw new AppError("CONFLICT", message, { fieldErrors: { email: [message] } });
  }
  const passwordHash = await hashPassword(input.password);
  const result = await withTransaction(async (conn) => {
    const id = await insertUser(
      { email: input.email, fullName: input.fullName, role: "client_owner", passwordHash, status: "active" },
      conn,
    );
    const user = (await findUserById(id, conn))!;
    const actor = toAuthUser(user);
    await recordAudit(actor, { action: "Account registered", entityType: "User", entityId: id }, conn);
    const { clientId, caseId } = await openProspect(
      actor,
      { ...input.company, notes: `Registered on the Accountanz platform by ${input.fullName} (${input.email}).` },
      conn,
      "Company registered",
    );
    await linkClientUser(clientId, id, "owner", true, conn);
    return { user: toPublicUser(user), session: await issueSession(user, conn), caseId };
  });
  void notifyCompanyRegistered(result.caseId);
  return { user: result.user, session: result.session };
}

/**
 * Rotates the refresh token. Presenting an already-revoked token means it was copied:
 * every session for that user is revoked.
 */
export async function refresh(presented: string | undefined): Promise<{ user: PublicUser; session: IssuedSession }> {
  if (!presented) throw AppError.unauthenticated();
  const outcome = await withTransaction(async (conn) => {
    const row = await repo.findRefreshTokenForUpdate(sha256(presented), conn);
    if (!row) return { kind: "invalid" as const };
    if (row.revoked_at) {
      await repo.revokeAllRefreshTokens(row.user_id, conn);
      return { kind: "reused" as const, userId: row.user_id };
    }
    if (row.expired) return { kind: "invalid" as const };
    const user = await findUserById(row.user_id, conn);
    if (!user || user.status !== "active" || (await isRejectedStaff(user.id, conn))) return { kind: "invalid" as const };
    await repo.revokeRefreshToken(row.id, conn);
    return { kind: "ok" as const, user, session: await issueSession(user, conn) };
  });

  if (outcome.kind === "reused") {
    logger.warn({ userId: outcome.userId }, "Refresh token reuse detected; all sessions revoked");
  }
  if (outcome.kind !== "ok") throw AppError.unauthenticated("Your session has expired. Please sign in again.");
  return { user: toPublicUser(outcome.user), session: outcome.session };
}

export async function logout(presented: string | undefined) {
  if (presented) await repo.revokeRefreshTokenByHash(sha256(presented));
}

export async function getMe(userId: number): Promise<PublicUser> {
  const user = await findUserById(userId);
  if (!user) throw AppError.unauthenticated();
  return toPublicUser(user);
}

/** Creates a one-time link token and returns the raw token (only its hash is stored). */
export async function issueUserToken(userId: number, purpose: UserTokenPurpose, db?: PoolConnection): Promise<string> {
  const token = newOpaqueToken();
  const ttl = purpose === "invite" ? INVITE_TTL_MS : RESET_TTL_MS;
  await repo.insertUserToken(userId, purpose, sha256(token), new Date(Date.now() + ttl), db ?? pool);
  return token;
}

/** Always succeeds from the caller's point of view, so it cannot be used to discover accounts. */
export async function forgotPassword(email: string) {
  const user = await findUserByEmail(email);
  if (!user || user.status === "disabled") return;
  const purpose: UserTokenPurpose = user.status === "invited" ? "invite" : "password_reset";
  const token = await issueUserToken(user.id, purpose);
  // Someone who never accepted their invite gets a fresh invite instead of a reset link.
  const content =
    purpose === "invite"
      ? inviteEmail({ inviteeName: user.full_name, inviterName: "Accountanz", roleLabel: humanize(user.portal_role), url: `${env.APP_URL}/accept-invite?token=${token}`, validDays: 7 })
      : passwordResetEmail({ name: user.full_name, url: `${env.APP_URL}/reset-password?token=${token}`, validMinutes: RESET_TTL_MS / 60000 });
  await sendMail({ to: user.email, ...content, idempotencyKey: `${purpose}/${user.id}/${sha256(token).slice(0, 16)}` });
}

async function consumeTokenAndSetPassword(input: ResetPasswordInput, purpose: UserTokenPurpose) {
  const passwordHash = await hashPassword(input.password);
  const user = await withTransaction(async (conn) => {
    const token = await repo.findUsableUserTokenForUpdate(sha256(input.token), purpose, conn);
    if (!token) throw new AppError("VALIDATION_ERROR", "This link is invalid or has expired. Request a new one.");
    const user = await findUserById(token.user_id, conn);
    if (!user || user.status === "disabled") throw AppError.forbidden("This account is not active");
    await repo.markUserTokenUsed(token.id, conn);
    await setPassword(user.id, passwordHash, conn);
    await repo.revokeAllRefreshTokens(user.id, conn); // sign out everywhere after a password change
    await recordAudit(
      toAuthUser(user),
      { action: purpose === "invite" ? "Invite accepted" : "Password reset", entityType: "User", entityId: user.id },
      conn,
    );
    return user;
  });
  // Security notice / welcome after the change is committed. Sent in the background; never blocks.
  const content = passwordChangedEmail({ name: user.full_name, kind: purpose === "invite" ? "activated" : "reset" });
  void sendMail({ to: user.email, ...content, idempotencyKey: `password-changed/${user.id}/${sha256(input.token).slice(0, 16)}` });
}

export const resetPassword = (input: ResetPasswordInput) => consumeTokenAndSetPassword(input, "password_reset");
export const acceptInvite = (input: ResetPasswordInput) => consumeTokenAndSetPassword(input, "invite");
