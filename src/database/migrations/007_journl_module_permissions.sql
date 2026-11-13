-- Assignment-level JournL module permissions (provisional).
--
-- The module list below comes from Accountanz's own architecture notes; it is NOT verified against JournL's API.
-- Module ids, actions and access levels are data so they can be mapped to JournL once its documentation is in:
-- fill journl_*_id and set verified_at only after checking them there. In production, nothing unverified can be
-- granted or counts toward effective access.
--
-- Effective access = client grant (enforced by JournL) ∩ this accountant's assignment grant ∩ an active engagement.
-- assignments.journl_access stays as the master switch: module grants take effect only while it is on.

CREATE TABLE journl_modules (
  module_key       VARCHAR(50)  NOT NULL PRIMARY KEY COMMENT 'Accountanz identifier; independent of JournL ids',
  label            VARCHAR(100) NOT NULL,
  sort_order       SMALLINT     NOT NULL,
  default_policy   ENUM('limited','configurable','restricted') NOT NULL COMMENT 'restricted = cannot be granted until the policy is changed',
  journl_module_id VARCHAR(100) NULL COMMENT 'JournL module id, once confirmed from its API documentation',
  verified_at      DATETIME     NULL COMMENT 'set when the mapping is confirmed against JournL'
) ENGINE=InnoDB;

-- One provisional action per module ("access") until JournL's real access levels are known. Add or replace
-- actions here; nothing in code assumes view / edit / approve / delete exist.
CREATE TABLE journl_module_actions (
  module_key       VARCHAR(50)  NOT NULL,
  action_key       VARCHAR(50)  NOT NULL,
  label            VARCHAR(100) NOT NULL,
  journl_action_id VARCHAR(100) NULL,
  verified_at      DATETIME     NULL,
  PRIMARY KEY (module_key, action_key),
  CONSTRAINT fk_jma_module FOREIGN KEY (module_key) REFERENCES journl_modules(module_key) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE assignment_module_permissions (
  assignment_id   BIGINT UNSIGNED NOT NULL,
  module_key      VARCHAR(50)     NOT NULL,
  allowed_actions JSON            NOT NULL COMMENT 'array of journl_module_actions.action_key',
  status          ENUM('active','revoked') NOT NULL DEFAULT 'active',
  granted_by      BIGINT UNSIGNED NULL,
  granted_at      DATETIME        NOT NULL,
  revoked_by      BIGINT UNSIGNED NULL,
  revoked_at      DATETIME        NULL,
  PRIMARY KEY (assignment_id, module_key),
  CONSTRAINT fk_amp_assignment FOREIGN KEY (assignment_id) REFERENCES assignments(id)          ON DELETE CASCADE,
  CONSTRAINT fk_amp_module     FOREIGN KEY (module_key)    REFERENCES journl_modules(module_key) ON DELETE RESTRICT,
  CONSTRAINT fk_amp_granted_by FOREIGN KEY (granted_by)    REFERENCES users(id)                 ON DELETE SET NULL,
  CONSTRAINT fk_amp_revoked_by FOREIGN KEY (revoked_by)    REFERENCES users(id)                 ON DELETE SET NULL
) ENGINE=InnoDB;

INSERT INTO journl_modules (module_key, label, sort_order, default_policy) VALUES
  ('dashboard',          'Dashboard',                      10,  'limited'),
  ('transactions',       'Transactions',                   20,  'configurable'),
  ('sales',              'Sales / Invoices',               30,  'configurable'),
  ('purchases',          'Purchases / Expenses',           40,  'configurable'),
  ('banking',            'Bank Accounts / Reconciliation', 50,  'configurable'),
  ('contacts',           'Contacts',                       60,  'configurable'),
  ('chart_of_accounts',  'Chart of Accounts',              70,  'configurable'),
  ('journal_entries',    'Journal Entries',                80,  'configurable'),
  ('reports',            'Reports',                        90,  'configurable'),
  ('documents',          'Documents',                      100, 'configurable'),
  ('settings',           'Settings / Administration',      110, 'restricted');

INSERT INTO journl_module_actions (module_key, action_key, label)
  SELECT module_key, 'access', 'Access (provisional, single level)' FROM journl_modules;
