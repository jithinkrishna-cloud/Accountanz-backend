-- Replace the provisional JournL module list with modules mapped to JournL's real feature catalogue.
--
-- journl_module_id holds JournL's user-permission feature ids (Bizpole-Books-Client src/constants/FeatureIds.ts,
-- the same ids JournL returns as permissionData at login), comma-separated. Mapped from JournL's source code;
-- JournL has no published partner API. Not in JournL, so not offered: fixed assets, GSTR-3B, bank reconciliation.
--
-- One action for now: "view" (read-only, live from JournL). Add/edit actions come with JournL write access.

INSERT INTO journl_modules (module_key, label, sort_order, default_policy, journl_module_id, verified_at) VALUES
  ('sales',             'Sales',                     10,  'configurable', '14,15,12,18',     UTC_TIMESTAMP()),
  ('purchases',         'Purchases',                 20,  'configurable', '16,17,11',        UTC_TIMESTAMP()),
  ('expenses',          'Expenses',                  30,  'configurable', '20',              UTC_TIMESTAMP()),
  ('accounting',        'Accounting & Ledgers',      40,  'configurable', '1,2,13,26,31',    UTC_TIMESTAMP()),
  ('customers',         'Customers',                 50,  'configurable', '3',               UTC_TIMESTAMP()),
  ('vendors',           'Vendors',                   60,  'configurable', '4',               UTC_TIMESTAMP()),
  ('banking',           'Banking',                   70,  'configurable', '2,26,43',         UTC_TIMESTAMP()),
  ('inventory',         'Inventory',                 80,  'configurable', '8,19,28,29',      UTC_TIMESTAMP()),
  ('gst',               'GST & Tax',                 90,  'configurable', '39,40',           UTC_TIMESTAMP()),
  ('financial_reports', 'Financial Reports',         100, 'configurable', '21,22,23,30,36,37', UTC_TIMESTAMP()),
  ('settings',          'Settings / Administration', 110, 'restricted',   '32,33,34,35',     UTC_TIMESTAMP())
ON DUPLICATE KEY UPDATE label = VALUES(label), sort_order = VALUES(sort_order), default_policy = VALUES(default_policy),
  journl_module_id = VALUES(journl_module_id), verified_at = VALUES(verified_at);

INSERT IGNORE INTO journl_module_actions (module_key, action_key, label, journl_action_id, verified_at)
  SELECT module_key, 'view', 'View (read-only)', 'view', UTC_TIMESTAMP() FROM journl_modules;

-- Carry existing grants over to the mapped modules (read-only "view").
INSERT IGNORE INTO assignment_module_permissions (assignment_id, module_key, allowed_actions, status, granted_by, granted_at)
  SELECT p.assignment_id, m.new_key, JSON_ARRAY('view'), p.status, p.granted_by, p.granted_at
    FROM assignment_module_permissions p
    JOIN (
      SELECT 'transactions' AS old_key, 'accounting' AS new_key
      UNION ALL SELECT 'chart_of_accounts', 'accounting'
      UNION ALL SELECT 'journal_entries', 'accounting'
      UNION ALL SELECT 'contacts', 'customers'
      UNION ALL SELECT 'contacts', 'vendors'
      UNION ALL SELECT 'reports', 'financial_reports'
      UNION ALL SELECT 'reports', 'gst'
      UNION ALL SELECT 'purchases', 'expenses'
    ) m ON m.old_key = p.module_key
   WHERE p.status = 'active';

UPDATE assignment_module_permissions SET allowed_actions = JSON_ARRAY('view')
 WHERE module_key IN ('sales', 'purchases', 'banking', 'settings') AND JSON_LENGTH(allowed_actions) > 0;

DELETE FROM assignment_module_permissions
 WHERE module_key IN ('dashboard', 'transactions', 'contacts', 'chart_of_accounts', 'journal_entries', 'reports', 'documents');
DELETE FROM journl_modules
 WHERE module_key IN ('dashboard', 'transactions', 'contacts', 'chart_of_accounts', 'journal_entries', 'reports', 'documents');
DELETE FROM journl_module_actions WHERE action_key = 'access';
