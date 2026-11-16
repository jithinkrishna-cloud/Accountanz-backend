-- Progressive onboarding foundation (Phase 1): additive, nullable/defaulted fields and related entities.
-- Keeps existing clients/onboarding flows intact; new fields optional for legacy rows.

-- 1) Extend clients with lightweight registration/profile fields
ALTER TABLE clients
  ADD COLUMN business_type ENUM('private_limited','public_limited','llp','partnership','proprietorship','opc') NULL AFTER trade_name,
  ADD COLUMN date_of_establishment DATE NULL AFTER business_type,
  ADD COLUMN primary_contact_name VARCHAR(150) NULL AFTER address,
  ADD COLUMN primary_contact_email VARCHAR(255) NULL AFTER primary_contact_name,
  ADD COLUMN primary_contact_phone VARCHAR(30) NULL AFTER primary_contact_email;

-- 2) Structured tax / registration details (1:1 per client)
CREATE TABLE company_tax_details (
  client_id     BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  pan_number    CHAR(10) NULL,
  pan_status    ENUM('not_registered','applied','registered') NULL,
  tan_number    VARCHAR(10) NULL,
  tan_status    ENUM('not_registered','applied','registered') NULL,
  gstin         CHAR(15) NULL,
  gstin_status  ENUM('not_registered','applied','registered') NULL,
  cin           VARCHAR(21) NULL,
  cin_status    ENUM('not_registered','applied','registered') NULL,
  llpin         VARCHAR(8) NULL,
  llpin_status  ENUM('not_registered','applied','registered') NULL,
  msme_udyam_number VARCHAR(19) NULL,
  msme_status   ENUM('not_registered','applied','registered') NULL,
  professional_tax_registration VARCHAR(50) NULL,
  professional_tax_status ENUM('not_registered','applied','registered') NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_tax_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 3) Unified stakeholders (directors/partners/shareholders/proprietor)
CREATE TABLE company_stakeholders (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id          BIGINT UNSIGNED NOT NULL,
  stakeholder_type   ENUM('director','partner','owner','proprietor') NOT NULL,
  full_name          VARCHAR(150) NOT NULL,
  email              VARCHAR(255) NULL,
  phone              VARCHAR(30) NULL,
  designation        VARCHAR(100) NULL,
  ownership_percentage DECIMAL(5,2) NULL,
  pan_number         CHAR(10) NULL,
  din_number         VARCHAR(20) NULL,
  address            VARCHAR(500) NULL,
  is_primary         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_stakeholder_client (client_id),
  CONSTRAINT fk_stakeholder_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 4) Company financial/profile snapshot (1:1 per client)
CREATE TABLE company_financial_profile (
  client_id                BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  financial_year_start_month TINYINT UNSIGNED NULL,
  annual_turnover          DECIMAL(15,2) NULL,
  monthly_transaction_volume INT UNSIGNED NULL,
  employee_count           INT UNSIGNED NULL,
  monthly_invoice_count    INT UNSIGNED NULL,
  current_accounting_software VARCHAR(100) NULL,
  notes                    VARCHAR(1000) NULL,
  created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_fin_profile_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5) Service requirements captured during onboarding (1:1 per onboarding case)
CREATE TABLE onboarding_service_requirements (
  case_id        BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  bookkeeping    BOOLEAN NOT NULL DEFAULT FALSE,
  gst_filing     BOOLEAN NOT NULL DEFAULT FALSE,
  income_tax_filing BOOLEAN NOT NULL DEFAULT FALSE,
  payroll        BOOLEAN NOT NULL DEFAULT FALSE,
  audit_support  BOOLEAN NOT NULL DEFAULT FALSE,
  other_services VARCHAR(500) NULL,
  notes          VARCHAR(1000) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_req_case FOREIGN KEY (case_id) REFERENCES onboarding_cases(id) ON DELETE CASCADE
) ENGINE=InnoDB;
