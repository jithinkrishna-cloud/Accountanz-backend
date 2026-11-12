-- Align status / category values with the existing Accountanz app.

-- Invoices: draft, issued, paid, overdue, cancelled ('void' becomes 'cancelled').
ALTER TABLE service_invoices MODIFY status ENUM('draft','issued','paid','void','overdue','cancelled') NOT NULL DEFAULT 'issued';
UPDATE service_invoices SET status = 'cancelled' WHERE status = 'void';
ALTER TABLE service_invoices MODIFY status ENUM('draft','issued','paid','overdue','cancelled') NOT NULL DEFAULT 'issued';

-- Documents: the app's categories ('payroll' was never offered; it maps to 'other').
ALTER TABLE documents MODIFY category ENUM('bank_statement','sales_invoice','purchase_bill','gst','payroll','receipt','other') NOT NULL DEFAULT 'other';
UPDATE documents SET category = 'other' WHERE category = 'payroll';
ALTER TABLE documents MODIFY category ENUM('sales_invoice','purchase_bill','receipt','bank_statement','gst','other') NOT NULL DEFAULT 'other';

-- Integrations: add 'disconnected'.
ALTER TABLE integration_connections MODIFY status ENUM('pending','connected','error','disconnected') NOT NULL DEFAULT 'pending';
