-- Allow the client to set their own JournL module grant per accountant assignment,
-- separate from Accountanz's admin grant. Effective access = accountanz grant ∩ client grant.
ALTER TABLE assignment_module_permissions
  ADD COLUMN grant_source ENUM('accountanz','client') NOT NULL DEFAULT 'accountanz' AFTER module_key,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (assignment_id, module_key, grant_source);

-- Backfill existing rows as accountanz grants.
UPDATE assignment_module_permissions SET grant_source = 'accountanz' WHERE grant_source IS NULL;
