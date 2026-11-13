-- The JournL session from the owner's "Sign in with JournL", kept encrypted so Accountanz can READ the
-- company's data (GET only) until JournL expires it (8h). JournL has no refreshable partner token.
ALTER TABLE integration_connections
  ADD COLUMN access_token_enc TEXT NULL AFTER authorized_at,
  ADD COLUMN token_expires_at DATETIME NULL AFTER access_token_enc;
