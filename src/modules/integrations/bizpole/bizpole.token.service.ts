import { env } from "../../../config/env.js";
import { queryOne, withTransaction } from "../../../database/connection.js";
import { AppError } from "../../../utils/app-error.js";
import { decryptSecret, encryptSecret } from "../../../utils/crypto.js";
import { logger } from "../../../utils/logger.js";
import { BizpoleApiError, BizpoleBusy, BizpoleUnreachable, requestToken } from "./bizpole.client.js";
import * as repo from "./bizpole.repository.js";
import type { BizpoleConnectionRow, BizpoleTokenResponse } from "./bizpole.types.js";

/**
 * Bizpole tokens: the access token lives 15 minutes; every refresh returns a NEW refresh token and reusing an old one
 * makes Bizpole revoke the whole grant (no grace period). So, per connection:
 *   - only one refresh at a time: an in-process promise per connection, plus a row lock (SELECT ... FOR UPDATE)
 *     that also covers several API instances; inside the lock the token is re-checked, since another request may
 *     have refreshed already;
 *   - the rotated tokens are saved in that same transaction, before the new access token is used;
 *   - if saving fails after Bizpole rotated, the stored refresh token is dead: the connection is marked revoked
 *     (reconnect) rather than ever sending the old token again.
 * Refreshes start 60s before expiry.
 */

const REFRESH_EARLY_MS = 60_000;
const RECONNECT = "Access to Bizpole Books has ended (revoked by the owner, or expired). The client owner needs to reconnect with a new connection code.";

function key(): string {
  if (!env.BIZPOLE_TOKEN_KEY) throw new AppError("UNAVAILABLE", "Bizpole Books isn't set up on this server");
  return env.BIZPOLE_TOKEN_KEY;
}

export function sealTokens(t: BizpoleTokenResponse, now = Date.now()): repo.SealedTokens {
  const k = key();
  return {
    accessEnc: encryptSecret(t.access_token, k),
    refreshEnc: encryptSecret(t.refresh_token, k),
    expiresAt: new Date(now + t.expires_in * 1000),
    grantId: t.grant_id,
  };
}

/** UTC DATETIME string from MySQL (dateStrings) -> epoch ms. */
const utcMs = (v: string | null) => (v ? new Date(`${v.replace(" ", "T")}Z`).getTime() : 0);

/** The stored access token when it is good for at least another minute; otherwise null. */
function usableAccessToken(row: Pick<BizpoleConnectionRow, "access_token_enc" | "token_expires_at">, now = Date.now()): string | null {
  if (!row.access_token_enc || !(utcMs(row.token_expires_at) - now > REFRESH_EARLY_MS)) return null;
  try {
    return decryptSecret(row.access_token_enc, key());
  } catch {
    return null;
  }
}

/** Maps Bizpole transport/API failures to the Accountanz error the caller should see. Never includes tokens. */
export function appErrorFrom(err: unknown): unknown {
  if (err instanceof AppError) return err;
  if (err instanceof BizpoleBusy) return new AppError("RATE_LIMITED", `Bizpole Books is busy. Try again in ${err.retryAfterSec} seconds.`);
  if (err instanceof BizpoleUnreachable) return new AppError("UNAVAILABLE", `${err.reason}. Please try again shortly.`);
  if (err instanceof BizpoleApiError) {
    if (err.code === "invalid_client") {
      logger.error({ bizpoleRequestId: err.requestId }, "Bizpole refused Accountanz's partner credentials (invalid_client)");
      return new AppError("UNAVAILABLE", "Accountanz's Bizpole Books partner credentials were refused. An administrator needs to check them.");
    }
    if (err.code === "integration_disabled") return new AppError("UNAVAILABLE", "The Bizpole Books integration is switched off on Bizpole's side.");
    if (err.status === 429) return new AppError("RATE_LIMITED", `Bizpole Books is busy. Try again in ${err.retryAfterSec ?? 60} seconds.`);
    if (err.code === "invalid_grant") return AppError.conflict(RECONNECT);
    if (err.status === 400) return new AppError("VALIDATION_ERROR", `Bizpole Books: ${err.message}`);
    if (err.status === 404) return AppError.conflict("This company is no longer shared with Accountanz in Bizpole Books. The client owner needs to reconnect.");
    if (err.status >= 500) return new AppError("UNAVAILABLE", "Bizpole Books can't be reached right now. Please try again shortly.");
    return new AppError("UNAVAILABLE", `Bizpole Books refused the request (${err.code}).`);
  }
  return err;
}

/** grant_type=connection_code. Errors come back already mapped (invalid_grant here means a bad, used or expired code). */
export async function exchangeCode(code: string): Promise<BizpoleTokenResponse> {
  try {
    return await requestToken({ grant_type: "connection_code", code });
  } catch (err) {
    if (err instanceof BizpoleApiError && err.code === "invalid_grant") {
      throw new AppError("VALIDATION_ERROR", "That connection code isn't valid, was already used or has expired (codes last 10 minutes). Create a new one in Bizpole Books.", {
        fieldErrors: { code: ["Invalid, used or expired code"] },
      });
    }
    throw appErrorFrom(err);
  }
}

const inflight = new Map<number, Promise<string>>();

/**
 * A valid access token for this connection, refreshing when it expires within a minute. `rejected` is the access
 * token Bizpole just answered 401 invalid_token to: then a refresh is forced unless another request already
 * replaced that token.
 */
export async function accessTokenFor(connectionId: number, rejected?: string): Promise<string> {
  if (!rejected) {
    const row = await queryOne<BizpoleConnectionRow>(
      `SELECT access_token_enc, token_expires_at FROM integration_connections WHERE id = ? AND provider = 'bizpole_books'`,
      [connectionId],
    );
    const token = row ? usableAccessToken(row) : null;
    if (token) return token;
  }
  let p = inflight.get(connectionId);
  if (!p) {
    p = refresh(connectionId, rejected).finally(() => inflight.delete(connectionId));
    inflight.set(connectionId, p);
  }
  return p;
}

type RefreshOutcome = { kind: "token"; token: string } | { kind: "revoked"; reason: string };

async function refresh(connectionId: number, rejected?: string): Promise<string> {
  let rotated = false;
  let outcome: RefreshOutcome;
  try {
    outcome = await withTransaction(async (conn): Promise<RefreshOutcome> => {
      const row = await repo.lockById(connectionId, conn);
      if (!row || !["connected", "pending", "error"].includes(row.status)) throw AppError.conflict("Bizpole Books isn't connected for this client.");
      // Another request may have refreshed while we waited for the lock.
      const current = usableAccessToken(row);
      if (current && current !== rejected) return { kind: "token", token: current };

      let refreshToken: string;
      try {
        if (!row.refresh_token_enc) throw new Error("no refresh token");
        refreshToken = decryptSecret(row.refresh_token_enc, key());
      } catch {
        await repo.markRevoked(row.id, "The stored Bizpole Books tokens can't be read. Reconnect needed.", conn);
        return { kind: "revoked", reason: RECONNECT };
      }

      let t: BizpoleTokenResponse;
      try {
        t = await requestToken({ grant_type: "refresh_token", refresh_token: refreshToken });
      } catch (err) {
        if (err instanceof BizpoleApiError && err.code === "invalid_grant") {
          await repo.markRevoked(row.id, "Bizpole Books refused the refresh (invalid_grant): access revoked, refresh token reused or expired.", conn);
          return { kind: "revoked", reason: RECONNECT };
        }
        throw err;
      }
      rotated = true;
      await repo.saveRotatedTokens(row.id, sealTokens(t), conn);
      return { kind: "token", token: t.access_token };
    });
  } catch (err) {
    if (rotated) {
      // Bizpole issued new tokens but they weren't saved: the stored refresh token is now dead. Never resend it.
      logger.error({ connectionId, err: (err as Error).message }, "Bizpole tokens rotated but could not be saved; marking the connection for reconnect");
      await repo.markRevoked(connectionId, "New Bizpole Books tokens could not be saved. Reconnect needed.").catch((e: unknown) =>
        logger.error({ connectionId, err: (e as Error).message }, "Could not mark the Bizpole connection for reconnect"),
      );
      throw AppError.conflict(RECONNECT);
    }
    throw appErrorFrom(err);
  }
  if (outcome.kind === "revoked") throw AppError.conflict(outcome.reason);
  return outcome.token;
}
