export type UserTokenPurpose = "password_reset" | "invite";

export interface RefreshTokenRow {
  id: number;
  user_id: number;
  expires_at: string;
  revoked_at: string | null;
  expired: 0 | 1;
}

export interface UserTokenRow {
  id: number;
  user_id: number;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
}
