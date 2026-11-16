-- One permission per JournL feature (Bizpole-Books-Client src/constants/FeatureIds.ts, ids 1-42) instead of
-- grouped "modules". Owners and admins grant e.g. Sales Return or Day Book on their own; group_key is the area
-- (Sales, Purchases, ...) used for display and as the staff JournL workspace page.
--
-- Existing grants carry over: an active grant on an old module becomes the same grant on every feature that module
-- contained (e.g. Sales -> Sales, Sales Return, Receipt, Estimate), so nobody gains or loses access. Features no old
-- module contained (Day Book, Register Reports, Group Summary, ...) start ungranted. Id 43 (in the old Banking module)
-- isn't a JournL feature and is dropped.

ALTER TABLE journl_modules ADD COLUMN group_key VARCHAR(50) NULL AFTER label;

INSERT INTO journl_modules (module_key, label, group_key, sort_order, default_policy, journl_module_id, verified_at) VALUES
  ('f_sales', 'Sales', 'sales', 110, 'configurable', '14', UTC_TIMESTAMP()),
  ('f_sales_return', 'Sales Return', 'sales', 120, 'configurable', '15', UTC_TIMESTAMP()),
  ('f_receipt', 'Receipt', 'sales', 130, 'configurable', '12', UTC_TIMESTAMP()),
  ('f_estimate', 'Estimate', 'sales', 140, 'configurable', '18', UTC_TIMESTAMP()),
  ('f_salesmen', 'Salesmen', 'sales', 150, 'configurable', '10', UTC_TIMESTAMP()),
  ('f_purchase', 'Purchase', 'purchases', 210, 'configurable', '16', UTC_TIMESTAMP()),
  ('f_purchase_return', 'Purchase Return', 'purchases', 220, 'configurable', '17', UTC_TIMESTAMP()),
  ('f_payment', 'Payment', 'purchases', 230, 'configurable', '11', UTC_TIMESTAMP()),
  ('f_expense_booking', 'Expense Booking', 'expenses', 310, 'configurable', '20', UTC_TIMESTAMP()),
  ('f_customers', 'Customers', 'customers', 410, 'configurable', '3', UTC_TIMESTAMP()),
  ('f_customer_frequency', 'Customer Frequency', 'customers', 420, 'configurable', '25', UTC_TIMESTAMP()),
  ('f_suppliers', 'Suppliers', 'vendors', 510, 'configurable', '4', UTC_TIMESTAMP()),
  ('f_ledger_groups', 'Ledger Groups', 'accounting', 610, 'configurable', '1', UTC_TIMESTAMP()),
  ('f_general_ledgers', 'General Ledgers', 'accounting', 620, 'configurable', '2', UTC_TIMESTAMP()),
  ('f_journal', 'Journal', 'accounting', 630, 'configurable', '13', UTC_TIMESTAMP()),
  ('f_ledger_statement', 'Ledger Statement', 'accounting', 640, 'configurable', '26', UTC_TIMESTAMP()),
  ('f_chart_of_accounts', 'Chart of Accounts', 'accounting', 650, 'configurable', '31', UTC_TIMESTAMP()),
  ('f_voucher_types', 'Voucher Types', 'accounting', 660, 'configurable', '9', UTC_TIMESTAMP()),
  ('f_payment_modes', 'Payment Modes', 'accounting', 670, 'configurable', '42', UTC_TIMESTAMP()),
  ('f_revoke_bin', 'Revoke Bin', 'accounting', 680, 'configurable', '41', UTC_TIMESTAMP()),
  ('f_stock_items', 'Stock Items', 'inventory', 710, 'configurable', '8', UTC_TIMESTAMP()),
  ('f_units', 'Units', 'inventory', 720, 'configurable', '5', UTC_TIMESTAMP()),
  ('f_stock_groups', 'Stock Groups', 'inventory', 730, 'configurable', '6', UTC_TIMESTAMP()),
  ('f_stock_categories', 'Stock Categories', 'inventory', 740, 'configurable', '7', UTC_TIMESTAMP()),
  ('f_stock_journal', 'Stock Journal', 'inventory', 750, 'configurable', '19', UTC_TIMESTAMP()),
  ('f_closing_stock', 'Closing Stock', 'inventory', 760, 'configurable', '28', UTC_TIMESTAMP()),
  ('f_stock_item_statement', 'Stock Item Statement', 'inventory', 770, 'configurable', '29', UTC_TIMESTAMP()),
  ('f_gstr1', 'GSTR-1', 'gst', 810, 'configurable', '39', UTC_TIMESTAMP()),
  ('f_gstr2b', 'GSTR-2B', 'gst', 820, 'configurable', '40', UTC_TIMESTAMP()),
  ('f_trial_balance', 'Trial Balance', 'financial_reports', 910, 'configurable', '21', UTC_TIMESTAMP()),
  ('f_profit_loss', 'Profit & Loss', 'financial_reports', 920, 'configurable', '22', UTC_TIMESTAMP()),
  ('f_balance_sheet', 'Balance Sheet', 'financial_reports', 930, 'configurable', '23', UTC_TIMESTAMP()),
  ('f_cash_flow', 'Cash Flow Statement', 'financial_reports', 940, 'configurable', '30', UTC_TIMESTAMP()),
  ('f_day_book', 'Day Book', 'financial_reports', 950, 'configurable', '24', UTC_TIMESTAMP()),
  ('f_register_reports', 'Register Reports', 'financial_reports', 960, 'configurable', '27', UTC_TIMESTAMP()),
  ('f_group_summary', 'Group Summary', 'financial_reports', 970, 'configurable', '38', UTC_TIMESTAMP()),
  ('f_payable_ageing', 'Payable Ageing', 'financial_reports', 980, 'configurable', '36', UTC_TIMESTAMP()),
  ('f_receivable_ageing', 'Receivable Ageing', 'financial_reports', 990, 'configurable', '37', UTC_TIMESTAMP()),
  ('f_users', 'Users', 'settings', 1010, 'restricted', '32', UTC_TIMESTAMP()),
  ('f_branches', 'Branches', 'settings', 1020, 'restricted', '33', UTC_TIMESTAMP()),
  ('f_audit_log', 'Audit Log', 'settings', 1030, 'restricted', '34', UTC_TIMESTAMP()),
  ('f_invoice_templates', 'Invoice Templates', 'settings', 1040, 'restricted', '35', UTC_TIMESTAMP())
ON DUPLICATE KEY UPDATE label = VALUES(label), group_key = VALUES(group_key), sort_order = VALUES(sort_order),
  default_policy = VALUES(default_policy), journl_module_id = VALUES(journl_module_id), verified_at = VALUES(verified_at);

INSERT IGNORE INTO journl_module_actions (module_key, action_key, label, journl_action_id, verified_at)
  SELECT module_key, 'view', 'View (read-only)', 'view', UTC_TIMESTAMP() FROM journl_modules WHERE group_key IS NOT NULL;

-- Carry active grants (both Accountanz's and the client's) from each old module to its features.
INSERT IGNORE INTO assignment_module_permissions (assignment_id, module_key, grant_source, allowed_actions, status, granted_by, granted_at)
  SELECT p.assignment_id, f.module_key, p.grant_source, p.allowed_actions, p.status, p.granted_by, p.granted_at
    FROM assignment_module_permissions p
    JOIN journl_modules old ON old.module_key = p.module_key AND old.group_key IS NULL
    JOIN journl_modules f ON f.group_key IS NOT NULL AND f.default_policy <> 'restricted'
     AND FIND_IN_SET(f.journl_module_id, REPLACE(old.journl_module_id, ' ', '')) > 0
   WHERE p.status = 'active';

-- Remove the old grouped modules (grants first: the module foreign key restricts deletes).
DELETE p FROM assignment_module_permissions p JOIN journl_modules old ON old.module_key = p.module_key AND old.group_key IS NULL;
DELETE a FROM journl_module_actions a JOIN journl_modules old ON old.module_key = a.module_key AND old.group_key IS NULL;
DELETE FROM journl_modules WHERE group_key IS NULL;

ALTER TABLE journl_modules MODIFY group_key VARCHAR(50) NOT NULL;
