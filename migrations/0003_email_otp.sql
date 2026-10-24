-- Owner email OTP second factor for Swarna Finance login.
-- A challenge is tied to an HttpOnly short-lived cookie, not to an already authenticated session.
CREATE TABLE IF NOT EXISTS login_otp_challenges (
  challenge_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  resend_count INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_expiry
  ON login_otp_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_otp_owner
  ON login_otp_challenges(owner_id);
