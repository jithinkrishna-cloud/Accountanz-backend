-- Leads added from Clients → New client used to get no onboarding case, so they never showed in Prospects.
-- Open a "registered" case for every lead that has none. New leads get one on creation (client.service).
INSERT INTO onboarding_cases (client_id, stage)
SELECT c.id, 'registered'
  FROM clients c
 WHERE c.status = 'lead'
   AND NOT EXISTS (SELECT 1 FROM onboarding_cases oc WHERE oc.client_id = c.id);
