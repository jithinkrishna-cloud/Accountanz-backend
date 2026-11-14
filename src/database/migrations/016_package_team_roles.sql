-- What team a package includes (e.g. Growth = bookkeeper + finance manager + CFO). The package says which roles
-- the client gets; assignments say which people fill them, so people can change without touching the package.

ALTER TABLE packages
  ADD COLUMN team_roles JSON NOT NULL DEFAULT (JSON_ARRAY('bookkeeper', 'finance_manager'))
    COMMENT 'roles included: bookkeeper, finance_manager, cfo' AFTER scope_notes;

-- Packages that already promise CFO time include the CFO role.
UPDATE packages SET team_roles = JSON_ARRAY('bookkeeper', 'finance_manager', 'cfo') WHERE scope_notes LIKE '%CFO%';
