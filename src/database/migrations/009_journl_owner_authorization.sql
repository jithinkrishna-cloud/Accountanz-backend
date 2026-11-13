-- The company owner's consent, given in the Accountanz portal ("Authorize JournL" dialog), for the
-- Accountanz team to work in their JournL organisation. Separate from the admin's manual verification.
ALTER TABLE integration_connections
  ADD COLUMN authorized_by BIGINT UNSIGNED NULL AFTER last_error,
  ADD COLUMN authorized_at DATETIME NULL AFTER authorized_by,
  ADD CONSTRAINT fk_integration_authorized_by FOREIGN KEY (authorized_by) REFERENCES users(id) ON DELETE SET NULL;
