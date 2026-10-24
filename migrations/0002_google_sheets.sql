-- Apply this migration after 0001_init.sql; existing Swarna Finance stores are preserved.
CREATE TABLE IF NOT EXISTS sheets_configs (
  owner_id TEXT PRIMARY KEY,
  spreadsheet_id TEXT NOT NULL,
  spreadsheet_url TEXT NOT NULL,
  title TEXT NOT NULL,
  connected_at TEXT NOT NULL
);
ALTER TABLE orders ADD COLUMN sheet_status TEXT NOT NULL DEFAULT 'not-configured';
ALTER TABLE orders ADD COLUMN sheet_started INTEGER;
ALTER TABLE orders ADD COLUMN sheet_synced_at TEXT;
