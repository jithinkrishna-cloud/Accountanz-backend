-- Backfill company_tax_details from the PAN/GSTIN already stored on clients, so existing clients
-- don't show "Tax/registration details" as missing. company_tax_details is the source of truth from here;
-- the app mirrors pan/gstin between the two on every save. Existing tax rows are never overwritten.
INSERT INTO company_tax_details (client_id, pan_number, gstin)
SELECT c.id, c.pan, c.gstin
  FROM clients c
 WHERE c.pan IS NOT NULL OR c.gstin IS NOT NULL
ON DUPLICATE KEY UPDATE
  pan_number = COALESCE(company_tax_details.pan_number, VALUES(pan_number)),
  gstin      = COALESCE(company_tax_details.gstin, VALUES(gstin));
