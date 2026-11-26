-- Online invoice payments through Easebuzz.
-- One gateway_transactions row per "Pay now" attempt; a successful one creates a service_payments row (method 'easebuzz').

ALTER TABLE service_payments
  MODIFY method ENUM('bank_transfer','upi','cheque','cash','other','easebuzz') NOT NULL;

CREATE TABLE gateway_transactions (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  txnid         VARCHAR(40)  NOT NULL COMMENT 'our id sent to Easebuzz',
  invoice_id    BIGINT UNSIGNED NOT NULL,
  client_id     BIGINT UNSIGNED NOT NULL,
  initiated_by  BIGINT UNSIGNED NULL,
  amount        DECIMAL(12,2) NOT NULL COMMENT 'invoice balance when the attempt started',
  status        ENUM('initiated','success','failure','cancelled','pending') NOT NULL DEFAULT 'initiated',
  easepayid     VARCHAR(50)  NULL,
  error_message VARCHAR(255) NULL,
  payment_id    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_gw_txnid (txnid),
  KEY ix_gw_invoice (invoice_id),
  CONSTRAINT fk_gw_invoice FOREIGN KEY (invoice_id)   REFERENCES service_invoices(id) ON DELETE RESTRICT,
  CONSTRAINT fk_gw_client  FOREIGN KEY (client_id)    REFERENCES clients(id)          ON DELETE RESTRICT,
  CONSTRAINT fk_gw_user    FOREIGN KEY (initiated_by) REFERENCES users(id)            ON DELETE SET NULL,
  CONSTRAINT fk_gw_payment FOREIGN KEY (payment_id)   REFERENCES service_payments(id) ON DELETE SET NULL
) ENGINE=InnoDB;
