-- JournL corrections: maker-checker queue for opening-balance and journal corrections posted to a client's JournL books.
-- The human reference "ACZ-<id>" is derived in code from id (MySQL cannot use an AUTO_INCREMENT column in a generated column).
-- Money inside payload/before_values/after_values is in paise. Tokens, credentials and JournL response bodies are never stored.
-- No ON DELETE / ON UPDATE actions on users FKs: the approver-differs CHECK below cannot coexist with referential actions.
CREATE TABLE journl_corrections (
  id                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id            BIGINT UNSIGNED NOT NULL,
  connection_id        BIGINT UNSIGNED NOT NULL,
  journl_company_id    VARCHAR(50)  NOT NULL,
  journl_branch_id     INT          NOT NULL COMMENT 'branch chosen at preparation, sent explicitly in every write',
  kind                 ENUM('opening_balance','journal_entry') NOT NULL,
  purpose              ENUM('correction','unresolved_tb_difference') NOT NULL DEFAULT 'correction',
  status               ENUM('draft','pending_approval','approved','posting','posted','rejected','unknown') NOT NULL DEFAULT 'draft',
  payload              JSON NOT NULL,
  before_values        JSON NULL,
  after_values         JSON NULL,
  reason               VARCHAR(1000) NOT NULL,
  initiated_by         BIGINT UNSIGNED NOT NULL,
  approved_by          BIGINT UNSIGNED NULL,
  approved_at          DATETIME NULL,
  review_comment       VARCHAR(1000) NULL,
  journl_session_owner BIGINT UNSIGNED NULL,
  journl_voucher_id    VARCHAR(50)  NULL,
  rejected_by_source   ENUM('reviewer','journl','stale') NULL,
  journl_message       VARCHAR(1000) NULL,
  copied_from          BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_jc_client_status (client_id, status),
  KEY ix_jc_connection (connection_id),
  CONSTRAINT fk_jc_client      FOREIGN KEY (client_id)            REFERENCES clients(id),
  CONSTRAINT fk_jc_connection  FOREIGN KEY (connection_id)        REFERENCES integration_connections(id),
  CONSTRAINT fk_jc_initiator   FOREIGN KEY (initiated_by)         REFERENCES users(id),
  CONSTRAINT fk_jc_approver    FOREIGN KEY (approved_by)          REFERENCES users(id),
  CONSTRAINT fk_jc_owner       FOREIGN KEY (journl_session_owner) REFERENCES users(id),
  CONSTRAINT fk_jc_copied_from FOREIGN KEY (copied_from)          REFERENCES journl_corrections(id),
  CONSTRAINT ck_jc_maker_checker CHECK (approved_by IS NULL OR approved_by <> initiated_by)
) ENGINE=InnoDB;

CREATE TABLE journl_correction_events (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  correction_id BIGINT UNSIGNED NOT NULL,
  from_status   VARCHAR(20) NULL,
  to_status     VARCHAR(20) NOT NULL,
  actor_id      BIGINT UNSIGNED NULL,
  note          VARCHAR(1000) NULL,
  request_id    VARCHAR(64) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_jce_correction (correction_id, id),
  CONSTRAINT fk_jce_correction FOREIGN KEY (correction_id) REFERENCES journl_corrections(id) ON DELETE CASCADE,
  CONSTRAINT fk_jce_actor      FOREIGN KEY (actor_id)      REFERENCES users(id)
) ENGINE=InnoDB;

-- Per-client override of the JournL accounting group that holds the Suspense ledger (default behaviour uses group id 9).
ALTER TABLE integration_connections
  ADD COLUMN journl_corrections_suspense_group_id INT NULL;

-- New "correct" action on the ledger/journal features; grant screens are action-driven.
INSERT IGNORE INTO journl_module_actions (module_key, action_key, label, journl_action_id, verified_at)
  SELECT module_key, 'correct', 'Correct (with approval)', 'correct', UTC_TIMESTAMP()
    FROM journl_modules
   WHERE module_key IN ('f_journal', 'f_general_ledgers', 'f_customers', 'f_suppliers');
