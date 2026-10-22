
CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  business TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','employee')),
  pin_hash TEXT NOT NULL,
  pin_sig TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(owner_id, pin_sig)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_owner_profile
ON staff(owner_id) WHERE role='owner';

CREATE INDEX IF NOT EXISTS idx_staff_owner
ON staff(owner_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  staff_id TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  customer TEXT NOT NULL,
  phone TEXT NOT NULL,
  item TEXT NOT NULL,
  description TEXT NOT NULL,
  weight REAL NOT NULL,
  rate REAL NOT NULL,
  percent REAL NOT NULL,
  amount REAL NOT NULL,
  photo_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  backup_status TEXT NOT NULL DEFAULT 'pending',
  backup_started INTEGER,
  drive_json_id TEXT,
  drive_photo_id TEXT,
  backed_up_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_owner_phone
ON orders(owner_id,phone);

CREATE INDEX IF NOT EXISTS idx_orders_owner_date
ON orders(owner_id,created_at DESC);

CREATE TABLE IF NOT EXISTS drive_accounts (
  owner_id TEXT PRIMARY KEY,
  refresh_encrypted TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  connected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
