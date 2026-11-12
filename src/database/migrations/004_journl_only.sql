-- JournL is the only supported accounting software.
-- Zoho Books connections are removed (they were never wired to a live API) and clients on Zoho Books
-- fall back to 'none' until they connect JournL.
DELETE FROM integration_connections WHERE provider = 'zoho_books';
ALTER TABLE integration_connections MODIFY provider ENUM('journl') NOT NULL DEFAULT 'journl';

UPDATE clients SET accounting_software = 'none' WHERE accounting_software = 'zoho_books';
ALTER TABLE clients MODIFY accounting_software ENUM('journl','none') NOT NULL DEFAULT 'none';
