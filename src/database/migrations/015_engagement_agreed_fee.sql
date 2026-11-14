-- The fee agreed for an engagement. Proposals can quote a fee different from the package's list price
-- (e.g. ₹45,000 on a ₹48,000 package); invoices must bill what was agreed. NULL = the package's list price.

ALTER TABLE engagements
  ADD COLUMN monthly_fee DECIMAL(12,2) NULL COMMENT 'agreed monthly fee; NULL = package list price' AFTER package_id;

-- Engagements opened from an accepted proposal take the proposed fee, if it differs from the list price.
UPDATE engagements e
  JOIN onboarding_cases oc ON oc.client_id = e.client_id AND oc.stage = 'accepted' AND oc.suggested_package_id = e.package_id
  JOIN packages p ON p.id = e.package_id
   SET e.monthly_fee = oc.suggested_monthly_fee
 WHERE e.monthly_fee IS NULL AND oc.suggested_monthly_fee IS NOT NULL AND oc.suggested_monthly_fee <> p.monthly_fee;
