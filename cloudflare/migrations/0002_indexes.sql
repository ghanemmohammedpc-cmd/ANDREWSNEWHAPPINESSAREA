CREATE INDEX IF NOT EXISTS request_limits_expiry ON request_limits(expires_at);
CREATE INDEX IF NOT EXISTS versions_hash ON versions(sha256);
