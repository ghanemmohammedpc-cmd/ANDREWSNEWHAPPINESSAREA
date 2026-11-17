ALTER TABLE download_tickets ADD COLUMN lease_expires_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX download_active_leases ON download_tickets(lease_expires_at) WHERE completed_at IS NULL AND transferred_at IS NULL;
