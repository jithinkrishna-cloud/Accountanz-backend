-- The JournL integration is gone: clients invite accountants to JournL directly, and Accountanz only links to it.
-- Drops the integration's tables (connections, Bizpole tokens, corrections, JournL feature permissions, access
-- to-dos) and the per-assignment "JournL access" flags. clients.accounting_software stays: it records which
-- software a client uses. Children before parents, so foreign keys never block a drop.

DROP TABLE IF EXISTS journl_correction_events;
DROP TABLE IF EXISTS journl_corrections;
DROP TABLE IF EXISTS assignment_module_permissions;
DROP TABLE IF EXISTS journl_module_actions;
DROP TABLE IF EXISTS journl_modules;
DROP TABLE IF EXISTS journl_access_tasks;
DROP TABLE IF EXISTS integration_connections;

ALTER TABLE assignments DROP COLUMN journl_access;
ALTER TABLE staff_group_members DROP COLUMN journl_access;
