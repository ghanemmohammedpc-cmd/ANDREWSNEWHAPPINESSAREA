CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,mod_id TEXT NOT NULL REFERENCES mods(id),user_id TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS reports_inbox ON reports(status,updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS reports_open_member ON reports(mod_id,user_id) WHERE status='open';
