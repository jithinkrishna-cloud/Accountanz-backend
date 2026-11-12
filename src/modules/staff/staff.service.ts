import { env } from "../../config/env.js";
import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import type { Paged } from "../../utils/pagination.js";
import { inviteEmail } from "../../emails/templates.js";
import { sha256 } from "../../utils/crypto.js";
import { humanize } from "../../utils/format.js";
import { sendMail } from "../../utils/mailer.js";
import { recordAudit } from "../audit/audit.service.js";
import { endAllForUser } from "../assignments/assignment.service.js";
import { issueUserToken } from "../auth/auth.service.js";
import { revokeAllRefreshTokens } from "../auth/auth.repository.js";
import { findUserByEmail, insertUser } from "../users/user.repository.js";
import * as repo from "./staff.repository.js";
import { ROLES_BY_STAFF_TYPE, type StaffRow, type StaffType, type StaffView } from "./staff.types.js";
import type { InviteStaffInput, StaffListQuery, UpdateStaffInput } from "./staff.validation.js";

/** Masks the account number to its last four digits. */
export function toStaffView({ bank_account_number, ...rest }: StaffRow): StaffView {
  return { ...rest, bank_account_last4: bank_account_number ? bank_account_number.slice(-4) : null };
}

function assertRoleFits(staffType: StaffType, role: string) {
  if (!(ROLES_BY_STAFF_TYPE[staffType] as readonly string[]).includes(role)) {
    throw new AppError("VALIDATION_ERROR", `The ${role} role is not available for ${staffType}s`);
  }
}

export async function listStaff(q: StaffListQuery): Promise<Paged<StaffView>> {
  const page = await repo.listStaff(q);
  return { ...page, items: page.items.map(toStaffView) };
}

export async function getStaff(userId: number) {
  const staff = await repo.findStaffById(userId);
  if (!staff) throw AppError.notFound("Person");
  return toStaffView(staff);
}

/**
 * Creates an invited account plus its staff profile and e-mails a one-time link to set a password.
 * Access to client records still comes only from assignments.
 */
export async function inviteStaff(actor: AuthUser, input: InviteStaffInput) {
  assertRoleFits(input.staff_type, input.portal_role);
  if (await findUserByEmail(input.email)) throw AppError.conflict("Someone with this email already has an account");

  const { userId, token } = await withTransaction(async (conn) => {
    const id = await insertUser(
      { email: input.email, fullName: input.full_name, phone: input.phone, role: input.portal_role, passwordHash: null, status: "invited" },
      conn,
    );
    await repo.insertStaffProfile(id, input.staff_type, conn);
    const t = await issueUserToken(id, "invite", conn);
    await recordAudit(actor, { action: "Person invited", entityType: "User", entityId: id, details: `${input.email} as ${input.portal_role}` }, conn);
    return { userId: id, token: t };
  });

  const inviteUrl = inviteLink(token);
  const emailed = await sendInviteMail(actor, { userId, email: input.email, name: input.full_name, role: input.portal_role }, token);
  return { ...(await getStaff(userId)), invite_url: inviteUrl, email_sent: emailed };
}

const INVITE_VALID_DAYS = 7;
const inviteLink = (token: string) => `${env.APP_URL}/accept-invite?token=${token}`;

/** One e-mail per issued link (the idempotency key is derived from the token). Returns whether it was sent. */
async function sendInviteMail(actor: AuthUser, person: { userId: number; email: string; name: string; role: string }, token: string) {
  const content = inviteEmail({ inviteeName: person.name, inviterName: actor.fullName, roleLabel: humanize(person.role), url: inviteLink(token), validDays: INVITE_VALID_DAYS });
  const result = await sendMail({ to: person.email, ...content, idempotencyKey: `invite/${person.userId}/${sha256(token).slice(0, 16)}` });
  return result.sent;
}

/**
 * Issues a fresh invite link for someone who hasn't set a password yet. Earlier links stop working.
 * The link is returned to the admin so it can be shared directly (no e-mail provider is configured yet).
 */
export async function resendInvite(actor: AuthUser, userId: number) {
  const staff = await repo.findStaffById(userId);
  if (!staff) throw AppError.notFound("Person");
  if (staff.status !== "invited") throw AppError.conflict("This person has already set a password. Use Forgot password to reset it.");
  const token = await withTransaction(async (conn) => {
    const t = await issueUserToken(userId, "invite", conn);
    await recordAudit(actor, { action: "Invite link issued", entityType: "User", entityId: userId, details: staff.email }, conn);
    return t;
  });
  const emailed = await sendInviteMail(actor, { userId, email: staff.email, name: staff.full_name, role: staff.portal_role }, token);
  return { invite_url: inviteLink(token), expires_in_days: INVITE_VALID_DAYS, email_sent: emailed };
}

/**
 * Deletes a person who has no work history (typically an invite that was never used).
 * Anyone with history is kept so tasks, reviews, time and payouts stay traceable; disable them instead.
 */
export async function deleteStaff(actor: AuthUser, userId: number) {
  if (userId === actor.id) throw AppError.forbidden("You can't delete your own account");
  const staff = await repo.findStaffById(userId);
  if (!staff) throw AppError.notFound("Person");

  await withTransaction(async (conn) => {
    const history = await repo.workHistory(userId, conn);
    const used = Object.entries(history).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k.replace("_", " ")}`);
    if (used.length) {
      throw AppError.conflict(`${staff.full_name} has work history (${used.join(", ")}), so they can't be deleted. Disable the account instead.`);
    }
    await repo.deleteUser(userId, conn);
    await recordAudit(actor, { action: "Person deleted", entityType: "User", entityId: userId, details: `${staff.full_name} <${staff.email}> (${staff.status})` }, conn);
  });
}

export async function updateStaff(actor: AuthUser, userId: number, input: UpdateStaffInput) {
  const before = await repo.findStaffById(userId);
  if (!before) throw AppError.notFound("Person");
  if (input.portal_role) assertRoleFits(before.staff_type, input.portal_role);
  if (userId === actor.id && (input.status === "disabled" || (input.portal_role && input.portal_role !== actor.role))) {
    throw AppError.forbidden("You can't disable your own account or change your own role");
  }
  if (input.status === "active" && before.status === "invited") {
    throw new AppError("VALIDATION_ERROR", "This person hasn't accepted their invite yet");
  }

  // Forms send the whole record; only persist and audit what actually differs.
  const changes = Object.fromEntries(
    Object.entries(input).filter(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(before[k as keyof StaffRow] ?? null)),
  ) as UpdateStaffInput;
  if (Object.keys(changes).length === 0) return { ...toStaffView(before), ended_assignments: 0 };

  const rejected = changes.verification_status === "rejected";
  const endedAssignments = await withTransaction(async (conn) => {
    await repo.updateStaff(userId, changes, conn);
    // Disabling or rejecting someone signs them out everywhere straight away.
    if (changes.status === "disabled" || rejected) await revokeAllRefreshTokens(userId, conn);
    const changed = [...new Set(Object.keys(changes).map((k) => (k.startsWith("bank_") ? "bank details" : k.replaceAll("_", " "))))].join(", ");
    await recordAudit(actor, { action: "Person updated", entityType: "User", entityId: userId, details: `${before.email}: ${changed}` }, conn);
    // A rejected person loses client access too, not just sign-in.
    return rejected ? endAllForUser(actor, userId, "verification rejected", conn) : 0;
  });
  return { ...(await getStaff(userId)), ended_assignments: endedAssignments };
}
