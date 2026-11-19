-- Bizpole Books partner integration (read-only, /integration/v1). A second provider next to JournL:
-- same accounting product, linked with the owner's connection code instead of a JournL sign-in.
-- Additive only: existing JournL rows and columns are unchanged.
--   status 'pending'  = (bizpole_books) code exchanged, the owner still has to choose a company
--   status 'revoked'  = Bizpole refused the grant (owner revoked it, refresh token reused or expired): reconnect
-- Tokens reuse access_token_enc / token_expires_at (UTC) and add refresh_token_enc; all AES-GCM sealed.

ALTER TABLE integration_connections
  MODIFY provider ENUM('journl','bizpole_books') NOT NULL DEFAULT 'journl',
  MODIFY status ENUM('pending','connected','error','disconnected','revoked') NOT NULL DEFAULT 'pending',
  ADD COLUMN grant_id            VARCHAR(100) NULL AFTER token_expires_at,
  ADD COLUMN refresh_token_enc   TEXT NULL AFTER grant_id,
  ADD COLUMN available_companies JSON NULL AFTER refresh_token_enc,
  ADD COLUMN external_gstin      VARCHAR(20) NULL AFTER external_org_name;
