#!/usr/bin/env python3
import sqlite3, pathlib
root=pathlib.Path(__file__).resolve().parent.parent
files=sorted((root/'migrations').glob('*.sql'))
expected=['0001_init.sql','0002_google_sheets.sql','0003_email_otp.sql','0004_business_onboarding.sql']
assert [f.name for f in files]==expected, [f.name for f in files]
db=sqlite3.connect(':memory:')
for f in files:
    db.executescript(f.read_text())
    print('APPLIED',f.name)
names={r[0] for r in db.execute('SELECT name FROM sqlite_master WHERE type="table"')}
required={'owners','staff','sessions','orders','drive_accounts','sheets_configs','login_otp_challenges','business_applications','master_admin_sessions','account_recovery_challenges','email_change_requests','platform_audit_log'}
assert required<=names, required-names
columns={r[1] for r in db.execute('PRAGMA table_info(orders)')}
assert {'sheet_status','photo_key','backup_status','amount','phone'} <= columns
print('PASS: all four migrations and key database tables/columns')
