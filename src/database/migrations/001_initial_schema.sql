-- Accountanz initial schema (MySQL 8, utf8mb4).
-- Conventions: BIGINT UNSIGNED surrogate keys, money as DECIMAL(12,2), accounting periods as CHAR(7) 'YYYY-MM'.
-- People are referenced by users.id (never by e-mail string). Values derivable from other rows are not stored.

-- ───────────────────────────── Identity ─────────────────────────────
CREATE TABLE users (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email              VARCHAR(255) NOT NULL,
  password_hash      VARCHAR(255) NULL COMMENT 'NULL until an invited user sets a password',
  full_name          VARCHAR(150) NOT NULL,
  phone              VARCHAR(30)  NULL,
  portal_role        ENUM('super_admin','ops_admin','bookkeeper','finance_manager','cfo','client_owner','client_member') NOT NULL,
  status             ENUM('invited','active','disabled') NOT NULL DEFAULT 'active',
  notification_prefs JSON NULL,
  last_login_at      DATETIME NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email),
  KEY ix_users_role (portal_role)
) ENGINE=InnoDB;

CREATE TABLE refresh_tokens (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  token_hash  CHAR(64) NOT NULL,
  expires_at  DATETIME NOT NULL,
  revoked_at  DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_refresh_hash (token_hash),
  KEY ix_refresh_user (user_id),
  CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One-time tokens for password reset and invite acceptance.
CREATE TABLE user_tokens (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  purpose     ENUM('password_reset','invite') NOT NULL,
  token_hash  CHAR(64) NOT NULL,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_tokens_hash (token_hash),
  KEY ix_user_tokens_user (user_id, purpose),
  CONSTRAINT fk_user_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE staff_profiles (
  user_id               BIGINT UNSIGNED PRIMARY KEY,
  staff_type            ENUM('accountant','employee') NOT NULL,
  hourly_rate           DECIMAL(10,2) NULL,
  expertise             JSON NULL,
  verification_status   ENUM('pending','verified','rejected') NOT NULL DEFAULT 'pending',
  bank_account_name     VARCHAR(150) NULL,
  bank_account_number   VARCHAR(34)  NULL,
  bank_ifsc             VARCHAR(11)  NULL,
  legacy_accountant_id  VARCHAR(50)  NULL,
  CONSTRAINT fk_staff_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ───────────────────────────── Clients ─────────────────────────────
CREATE TABLE clients (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  legal_name          VARCHAR(200) NOT NULL,
  trade_name          VARCHAR(200) NULL,
  gstin               CHAR(15) NULL,
  pan                 CHAR(10) NULL,
  state               VARCHAR(60) NULL,
  address             VARCHAR(500) NULL,
  status              ENUM('lead','onboarding','active','paused','exited') NOT NULL DEFAULT 'lead',
  accounting_software ENUM('journl','zoho_books','none') NOT NULL DEFAULT 'none',
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_clients_gstin (gstin),
  KEY ix_clients_status (status)
) ENGINE=InnoDB;

CREATE TABLE client_branches (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id           BIGINT UNSIGNED NOT NULL,
  name                VARCHAR(150) NOT NULL,
  gstin               CHAR(15) NULL,
  external_branch_ref VARCHAR(60) NULL,
  CONSTRAINT fk_branch_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE client_users (
  client_id   BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  role        ENUM('owner','member') NOT NULL DEFAULT 'member',
  can_approve BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (client_id, user_id),
  KEY ix_client_users_user (user_id),
  CONSTRAINT fk_cu_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT fk_cu_user   FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─────────────────────── Catalogue & engagements ───────────────────────
CREATE TABLE services (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(20) NOT NULL,
  name        VARCHAR(150) NOT NULL,
  description VARCHAR(500) NULL,
  UNIQUE KEY uq_services_code (code)
) ENGINE=InnoDB;

CREATE TABLE packages (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(150) NOT NULL,
  description   VARCHAR(500) NULL,
  monthly_fee   DECIMAL(12,2) NOT NULL,
  billing_cycle ENUM('monthly','quarterly','yearly') NOT NULL DEFAULT 'monthly',
  scope_notes   VARCHAR(1000) NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
) ENGINE=InnoDB;

CREATE TABLE package_services (
  package_id BIGINT UNSIGNED NOT NULL,
  service_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (package_id, service_id),
  CONSTRAINT fk_ps_package FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE CASCADE,
  CONSTRAINT fk_ps_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE onboarding_cases (
  id                         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id                  BIGINT UNSIGNED NOT NULL,
  stage                      ENUM('registered','assessment','proposal_sent','accepted','rejected') NOT NULL DEFAULT 'registered',
  monthly_transaction_volume INT UNSIGNED NULL,
  complexity                 ENUM('low','medium','high') NULL,
  notes                      VARCHAR(2000) NULL,
  assessed_by                BIGINT UNSIGNED NULL,
  suggested_package_id       BIGINT UNSIGNED NULL,
  suggested_monthly_fee      DECIMAL(12,2) NULL,
  created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_onb_stage (stage),
  CONSTRAINT fk_onb_client   FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT fk_onb_assessor FOREIGN KEY (assessed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_onb_package  FOREIGN KEY (suggested_package_id) REFERENCES packages(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE engagements (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id           BIGINT UNSIGNED NOT NULL,
  package_id          BIGINT UNSIGNED NOT NULL,
  status              ENUM('draft','sent','accepted','active','ended') NOT NULL DEFAULT 'draft',
  start_date          DATE NULL,
  end_date            DATE NULL,
  renewal_date        DATE NULL,
  agreement_file_path VARCHAR(500) NULL,
  agreement_file_name VARCHAR(255) NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_eng_client (client_id, status),
  CONSTRAINT fk_eng_client  FOREIGN KEY (client_id)  REFERENCES clients(id)  ON DELETE RESTRICT,
  CONSTRAINT fk_eng_package FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ───────────────────────────── People & access ─────────────────────────────
CREATE TABLE teams (
  id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id BIGINT UNSIGNED NOT NULL,
  name      VARCHAR(150) NOT NULL,
  UNIQUE KEY uq_team_client (client_id),
  CONSTRAINT fk_team_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Access rule: staff see a client only while an assignment is active and valid_from <= today <= COALESCE(valid_to, today).
CREATE TABLE assignments (
  id                        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id                 BIGINT UNSIGNED NOT NULL,
  user_id                   BIGINT UNSIGNED NOT NULL,
  team_role                 ENUM('bookkeeper','finance_manager','cfo','reviewer') NOT NULL,
  valid_from                DATE NOT NULL,
  valid_to                  DATE NULL,
  status                    ENUM('active','ended') NOT NULL DEFAULT 'active',
  journl_access             BOOLEAN NOT NULL DEFAULT FALSE,
  replaced_by_assignment_id BIGINT UNSIGNED NULL,
  created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_asg_user (user_id, status),
  KEY ix_asg_client (client_id, status),
  CONSTRAINT fk_asg_client   FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT fk_asg_user     FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
  CONSTRAINT fk_asg_replaced FOREIGN KEY (replaced_by_assignment_id) REFERENCES assignments(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ───────────────────────────── Work ─────────────────────────────
CREATE TABLE task_templates (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  service_id        BIGINT UNSIGNED NOT NULL,
  name              VARCHAR(150) NOT NULL,
  recurrence        ENUM('monthly','quarterly','annual') NOT NULL DEFAULT 'monthly',
  due_day_of_period TINYINT UNSIGNED NOT NULL,
  CONSTRAINT fk_tt_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE RESTRICT,
  CONSTRAINT ck_tt_due_day CHECK (due_day_of_period BETWEEN 1 AND 31)
) ENGINE=InnoDB;

CREATE TABLE task_template_items (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  template_id    BIGINT UNSIGNED NOT NULL,
  title          VARCHAR(200) NOT NULL,
  checklist      JSON NOT NULL COMMENT 'array of strings',
  client_visible BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order     INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_tti_template FOREIGN KEY (template_id) REFERENCES task_templates(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE tasks (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id        BIGINT UNSIGNED NOT NULL,
  engagement_id    BIGINT UNSIGNED NULL,
  template_item_id BIGINT UNSIGNED NULL COMMENT 'set when generated from a template; makes generation idempotent',
  period           CHAR(7) NOT NULL,
  title            VARCHAR(200) NOT NULL,
  checklist        JSON NOT NULL COMMENT 'array of {text, done}',
  created_by       BIGINT UNSIGNED NULL,
  assignee_id      BIGINT UNSIGNED NULL,
  reviewer_id      BIGINT UNSIGNED NULL,
  status           ENUM('todo','in_progress','submitted','returned','approved') NOT NULL DEFAULT 'todo',
  due_date         DATE NULL,
  client_visible   BOOLEAN NOT NULL DEFAULT TRUE,
  submitted_at     DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_task_generated (engagement_id, template_item_id, period),
  KEY ix_task_client_period (client_id, period),
  KEY ix_task_assignee (assignee_id, status),
  KEY ix_task_reviewer (reviewer_id, status),
  CONSTRAINT fk_task_client     FOREIGN KEY (client_id)        REFERENCES clients(id)             ON DELETE CASCADE,
  CONSTRAINT fk_task_engagement FOREIGN KEY (engagement_id)    REFERENCES engagements(id)         ON DELETE SET NULL,
  CONSTRAINT fk_task_item       FOREIGN KEY (template_item_id) REFERENCES task_template_items(id) ON DELETE SET NULL,
  CONSTRAINT fk_task_creator    FOREIGN KEY (created_by)       REFERENCES users(id)               ON DELETE SET NULL,
  CONSTRAINT fk_task_assignee   FOREIGN KEY (assignee_id)      REFERENCES users(id)               ON DELETE SET NULL,
  CONSTRAINT fk_task_reviewer   FOREIGN KEY (reviewer_id)      REFERENCES users(id)               ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE task_reviews (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id           BIGINT UNSIGNED NOT NULL,
  reviewer_id       BIGINT UNSIGNED NULL,
  decision          ENUM('approved','returned') NOT NULL,
  comments          VARCHAR(2000) NULL,
  submission_number INT UNSIGNED NOT NULL DEFAULT 1,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_review_task (task_id),
  CONSTRAINT fk_review_task     FOREIGN KEY (task_id)     REFERENCES tasks(id) ON DELETE CASCADE,
  CONSTRAINT fk_review_reviewer FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE work_logs (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id    BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  minutes    INT UNSIGNED NOT NULL,
  note       VARCHAR(500) NULL,
  logged_on  DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_worklog_user_date (user_id, logged_on),
  CONSTRAINT fk_worklog_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  CONSTRAINT fk_worklog_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT ck_worklog_minutes CHECK (minutes > 0)
) ENGINE=InnoDB;

-- ───────────────────────────── Documents ─────────────────────────────
CREATE TABLE document_requests (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id    BIGINT UNSIGNED NOT NULL,
  task_id      BIGINT UNSIGNED NULL,
  requested_by BIGINT UNSIGNED NULL,
  description  VARCHAR(500) NOT NULL,
  due_date     DATE NULL,
  period       CHAR(7) NULL,
  status       ENUM('open','fulfilled','cancelled') NOT NULL DEFAULT 'open',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_docreq_client (client_id, status),
  CONSTRAINT fk_docreq_client FOREIGN KEY (client_id)    REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT fk_docreq_task   FOREIGN KEY (task_id)      REFERENCES tasks(id)   ON DELETE SET NULL,
  CONSTRAINT fk_docreq_user   FOREIGN KEY (requested_by) REFERENCES users(id)   ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE documents (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id   BIGINT UNSIGNED NOT NULL,
  task_id     BIGINT UNSIGNED NULL,
  request_id  BIGINT UNSIGNED NULL,
  uploaded_by BIGINT UNSIGNED NULL,
  category    ENUM('bank_statement','sales_invoice','purchase_bill','gst','payroll','other') NOT NULL DEFAULT 'other',
  period      CHAR(7) NULL,
  file_path   VARCHAR(500) NOT NULL COMMENT 'private storage key; never a public URL',
  file_name   VARCHAR(255) NOT NULL,
  mime_type   VARCHAR(100) NULL,
  size_bytes  BIGINT UNSIGNED NULL,
  status      ENUM('new','reviewed','rejected') NOT NULL DEFAULT 'new',
  review_note VARCHAR(1000) NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_doc_client (client_id, period),
  CONSTRAINT fk_doc_client   FOREIGN KEY (client_id)   REFERENCES clients(id)           ON DELETE CASCADE,
  CONSTRAINT fk_doc_task     FOREIGN KEY (task_id)     REFERENCES tasks(id)             ON DELETE SET NULL,
  CONSTRAINT fk_doc_request  FOREIGN KEY (request_id)  REFERENCES document_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_doc_uploader FOREIGN KEY (uploaded_by) REFERENCES users(id)             ON DELETE SET NULL,
  CONSTRAINT fk_doc_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id)             ON DELETE SET NULL
) ENGINE=InnoDB;

-- ───────────────────────────── Closing, reports, approvals ─────────────────────────────
CREATE TABLE period_closings (
  id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id BIGINT UNSIGNED NOT NULL,
  period    CHAR(7) NOT NULL,
  status    ENUM('open','ready','closed') NOT NULL DEFAULT 'open',
  closed_by BIGINT UNSIGNED NULL,
  closed_at DATETIME NULL,
  UNIQUE KEY uq_closing (client_id, period),
  CONSTRAINT fk_closing_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT fk_closing_user   FOREIGN KEY (closed_by) REFERENCES users(id)   ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE published_reports (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id      BIGINT UNSIGNED NOT NULL,
  period         CHAR(7) NOT NULL,
  report_type    ENUM('profit_and_loss','balance_sheet','cash_flow','gst_summary','mis','other') NOT NULL,
  file_path      VARCHAR(500) NULL,
  file_name      VARCHAR(255) NULL,
  summary        VARCHAR(2000) NULL,
  prepared_by    BIGINT UNSIGNED NULL,
  approved_by    BIGINT UNSIGNED NULL,
  published_date DATE NULL COMMENT 'NULL = not yet visible to the client',
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_report_client (client_id, period),
  CONSTRAINT fk_report_client   FOREIGN KEY (client_id)   REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT fk_report_preparer FOREIGN KEY (prepared_by) REFERENCES users(id)   ON DELETE SET NULL,
  CONSTRAINT fk_report_approver FOREIGN KEY (approved_by) REFERENCES users(id)   ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE client_approvals (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id       BIGINT UNSIGNED NOT NULL,
  subject         VARCHAR(200) NOT NULL,
  description     VARCHAR(2000) NULL,
  related_task_id BIGINT UNSIGNED NULL,
  requested_by    BIGINT UNSIGNED NULL,
  status          ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  decided_by      BIGINT UNSIGNED NULL,
  decided_at      DATETIME NULL,
  comment         VARCHAR(1000) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_approval_client (client_id, status),
  CONSTRAINT fk_approval_client  FOREIGN KEY (client_id)       REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT fk_approval_task    FOREIGN KEY (related_task_id) REFERENCES tasks(id)   ON DELETE SET NULL,
  CONSTRAINT fk_approval_req     FOREIGN KEY (requested_by)    REFERENCES users(id)   ON DELETE SET NULL,
  CONSTRAINT fk_approval_decider FOREIGN KEY (decided_by)      REFERENCES users(id)   ON DELETE SET NULL
) ENGINE=InnoDB;

-- ───────────────────────────── Communication ─────────────────────────────
CREATE TABLE message_threads (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id  BIGINT UNSIGNED NOT NULL,
  subject    VARCHAR(200) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_thread_client (client_id),
  CONSTRAINT fk_thread_client FOREIGN KEY (client_id)  REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT fk_thread_user   FOREIGN KEY (created_by) REFERENCES users(id)   ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE messages (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  thread_id       BIGINT UNSIGNED NOT NULL,
  author_id       BIGINT UNSIGNED NULL,
  body            TEXT NOT NULL,
  attachment_path VARCHAR(500) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_message_thread (thread_id, created_at),
  CONSTRAINT fk_message_thread FOREIGN KEY (thread_id) REFERENCES message_threads(id) ON DELETE CASCADE,
  CONSTRAINT fk_message_author FOREIGN KEY (author_id) REFERENCES users(id)           ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE meetings (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id    BIGINT UNSIGNED NOT NULL,
  organiser_id BIGINT UNSIGNED NULL,
  title        VARCHAR(200) NOT NULL,
  starts_at    DATETIME NOT NULL,
  ends_at      DATETIME NOT NULL,
  meeting_link VARCHAR(500) NULL,
  KEY ix_meeting_client (client_id, starts_at),
  CONSTRAINT fk_meeting_client    FOREIGN KEY (client_id)    REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT fk_meeting_organiser FOREIGN KEY (organiser_id) REFERENCES users(id)   ON DELETE SET NULL,
  CONSTRAINT ck_meeting_time CHECK (ends_at > starts_at)
) ENGINE=InnoDB;

-- Attendees may be portal users or outside e-mail addresses.
CREATE TABLE meeting_attendees (
  meeting_id BIGINT UNSIGNED NOT NULL,
  email      VARCHAR(255) NOT NULL,
  user_id    BIGINT UNSIGNED NULL,
  PRIMARY KEY (meeting_id, email),
  CONSTRAINT fk_attendee_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_attendee_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE SET NULL
) ENGINE=InnoDB;

-- ───────────────────────────── Finance ─────────────────────────────
-- Client comes from the engagement; paid amount is SUM(service_payments.amount).
CREATE TABLE service_invoices (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  engagement_id  BIGINT UNSIGNED NOT NULL,
  invoice_number VARCHAR(30) NOT NULL,
  period         CHAR(7) NOT NULL,
  amount         DECIMAL(12,2) NOT NULL,
  gst_rate       DECIMAL(5,2)  NOT NULL COMMENT 'rate snapshot at issue time',
  gst_amount     DECIMAL(12,2) NOT NULL,
  total          DECIMAL(12,2) NOT NULL,
  due_date       DATE NOT NULL,
  status         ENUM('issued','paid','void') NOT NULL DEFAULT 'issued',
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_invoice_number (invoice_number),
  UNIQUE KEY uq_invoice_period (engagement_id, period),
  CONSTRAINT fk_invoice_engagement FOREIGN KEY (engagement_id) REFERENCES engagements(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE service_payments (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  invoice_id  BIGINT UNSIGNED NOT NULL,
  amount      DECIMAL(12,2) NOT NULL,
  paid_date   DATE NOT NULL,
  method      ENUM('bank_transfer','upi','cheque','cash','other') NOT NULL,
  reference   VARCHAR(100) NULL,
  recorded_by BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_payment_invoice (invoice_id),
  CONSTRAINT fk_payment_invoice FOREIGN KEY (invoice_id)  REFERENCES service_invoices(id) ON DELETE RESTRICT,
  CONSTRAINT fk_payment_user    FOREIGN KEY (recorded_by) REFERENCES users(id)            ON DELETE SET NULL,
  CONSTRAINT ck_payment_amount CHECK (amount > 0)
) ENGINE=InnoDB;

-- minutes and hourly_rate are snapshots taken when the run is generated.
CREATE TABLE accountant_payouts (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  period      CHAR(7) NOT NULL,
  minutes     INT UNSIGNED NOT NULL,
  hourly_rate DECIMAL(10,2) NOT NULL,
  amount      DECIMAL(12,2) NOT NULL,
  status      ENUM('draft','approved','paid') NOT NULL DEFAULT 'draft',
  approved_by BIGINT UNSIGNED NULL,
  paid_date   DATE NULL,
  method      ENUM('bank_transfer','upi','cheque','cash','other') NOT NULL DEFAULT 'bank_transfer',
  reference   VARCHAR(100) NULL,
  notes       VARCHAR(500) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payout (user_id, period),
  CONSTRAINT fk_payout_user     FOREIGN KEY (user_id)     REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_payout_approver FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ───────────────────────────── Platform ─────────────────────────────
CREATE TABLE integration_connections (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id         BIGINT UNSIGNED NOT NULL,
  provider          ENUM('journl','zoho_books') NOT NULL,
  external_org_id   VARCHAR(100) NULL,
  external_org_name VARCHAR(200) NULL,
  status            ENUM('pending','connected','error') NOT NULL DEFAULT 'pending',
  last_health_check DATETIME NULL,
  last_error        VARCHAR(500) NULL,
  UNIQUE KEY uq_integration (client_id, provider),
  CONSTRAINT fk_integration_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Single-row workspace settings (id is always 1).
CREATE TABLE app_settings (
  id                     TINYINT UNSIGNED PRIMARY KEY DEFAULT 1,
  company_name           VARCHAR(150) NOT NULL DEFAULT 'Accountanz',
  legal_name             VARCHAR(200) NULL,
  gstin                  CHAR(15) NULL,
  pan                    CHAR(10) NULL,
  address                VARCHAR(500) NULL,
  email                  VARCHAR(255) NULL,
  phone                  VARCHAR(30) NULL,
  gst_rate               DECIMAL(5,2) NOT NULL DEFAULT 18.00,
  remind_document_due    BOOLEAN NOT NULL DEFAULT TRUE,
  remind_task_overdue    BOOLEAN NOT NULL DEFAULT TRUE,
  remind_invoice_overdue BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT ck_settings_singleton CHECK (id = 1)
) ENGINE=InnoDB;

CREATE TABLE knowledge_articles (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title      VARCHAR(200) NOT NULL,
  category   VARCHAR(80) NOT NULL,
  summary    VARCHAR(500) NULL,
  body       TEXT NOT NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_article_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- actor_email / actor_role are deliberate snapshots: the log must survive user edits and deletion.
CREATE TABLE audit_logs (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_id    BIGINT UNSIGNED NULL,
  actor_email VARCHAR(255) NULL,
  actor_role  VARCHAR(30) NULL,
  client_id   BIGINT UNSIGNED NULL,
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id   VARCHAR(50) NULL,
  details     VARCHAR(1000) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_audit_created (created_at),
  KEY ix_audit_client (client_id),
  CONSTRAINT fk_audit_actor  FOREIGN KEY (actor_id)  REFERENCES users(id)   ON DELETE SET NULL,
  CONSTRAINT fk_audit_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
) ENGINE=InnoDB;
