# Cloudflare deployment — full instructions and troubleshooting

## Before starting

This is a **new staging deployment**. Existing domains, D1 databases, R2 objects and staff account hashes must remain untouched. Back up customer and order records in any existing installation before updating production. GitHub does not automatically keep your D1 records or R2 photo files.

### Step 1: GitHub Codespaces

Unzip the package as shown in `QUICKSTART.md`, install Node dependencies and run `npm run check && npm test`. Both tests run without Cloudflare API calls. They validate code syntax, asset references, a mocked API health request, asset aliases and four SQLite schema migrations.

### Step 2: Wrangler login

```bash
npx wrangler --version
npx wrangler login --device --browser=false
npx wrangler whoami
```

Use the device login flow because Codespaces cannot open `xdg-open` in some environments. If login expires, run it again and approve the **new code within five minutes**. Do not post that code or your credentials.

### Step 3: Create D1 and R2

```bash
npx wrangler d1 create swarna-finance-complete-staging-db
npx wrangler r2 bucket create swarna-finance-complete-staging-photos
npx wrangler d1 list
npx wrangler r2 bucket list
```

In `wrangler.jsonc`, replace `REPLACE_WITH_STAGING_D1_UUID` with the actual new database ID returned from Cloudflare. Keep `DB` and `PHOTOS` binding names unchanged. The `r2_buckets[].bucket_name` must match the bucket you created. Use the correct Cloudflare account for all resources.

If R2 is unavailable on your plan/account, enable R2 in the Cloudflare dashboard before proceeding. **Do not remove the `PHOTOS` binding:** the application expects it.

### Step 4: Master admin and Resend

In `wrangler.jsonc`, replace `MASTER_EMAIL` with a dedicated email you control. `RESEND_FROM` must be an approved sender address for a **verified** domain in Resend. Keep API keys out of this file. You can later set `PUBLIC_ORIGIN` to the final HTTPS origin for activation email links; during staging the Worker uses the request origin.

### Step 5: Apply migrations to the NEW staging D1

```bash
npx wrangler d1 migrations list swarna-finance-complete-staging-db --remote
npx wrangler d1 migrations apply swarna-finance-complete-staging-db --remote
```

Expect four migrations, in order: `0001_init.sql`, `0002_google_sheets.sql`, `0003_email_otp.sql`, `0004_business_onboarding.sql`.

**Existing live D1 warning:** Previous Swarna Finance versions may already have the tables created under different migration names. Never run these four new files against an old live D1 without comparing the `d1_migrations` table and a schema export. Some existing `ALTER TABLE` statements are not idempotent.

For a live backup before *any* change, use your existing database name:

```bash
npx wrangler d1 export YOUR_EXISTING_DB_NAME --remote --output=private-backup.sql
```

Keep that SQL private; `.gitignore` excludes common backup names but not every possible export filename.

### Step 6: First staging deploy and secrets

```bash
npx wrangler deploy --dry-run
npx wrangler deploy
```

The first deployment may show missing-secret errors on API requests until the secrets below are configured. For a **new staging installation only**, generate two different secure peppers:

```bash
node scripts/create-peppers.mjs
npx wrangler secret put PIN_PEPPER
npx wrangler secret put OTP_PEPPER
npx wrangler secret put RESEND_API_KEY
npx wrangler secret list
```

When prompted, paste the corresponding value privately. `PIN_PEPPER` and `OTP_PEPPER` must each have 32 or more characters. Never generate replacements for a live installation using existing staff PINs or active OTPs.

`RESEND_API_KEY` must be active. Resend HTTP 401 indicates the API key was not accepted; verify or rotate the key privately. Do not paste keys or mail OTP codes into chat.

### Step 7: Verify routing

```bash
npm run verify:site -- https://YOUR-STAGING-WORKER.workers.dev
```

Or check manually:

```bash
curl -i https://YOUR-STAGING-WORKER.workers.dev/api/auth/me
```

Expected when not signed in: HTTP **200**, `Content-Type: application/json`, body `{"authenticated":false}`.

- **200 HTML**: static site is shadowing `/api/*`; check `assets.run_worker_first` is true and that the domain uses this Worker.
- **404 HTML**: likely wrong Worker name or route.
- **503 JSON**: missing D1/R2 binding or `PIN_PEPPER`.
- **500 JSON**: inspect migrations or Worker tail logs.
- **502 JSON during OTP**: inspect Resend sender domain and API credentials.

```bash
npx wrangler tail
```

Tail logs can include personal information; redact before sharing externally.

### Step 8: Test all pages and workflows

Navigate to `/`, `/login.html`, `/register.html`, `/reset.html` and `/admin.html` at the *staging Worker*. Test admin OTP and business approval. Enter **fictional customers only** until thoroughly verified. Check R2 stores photos, print dialog previews and optional OAuth.

### Step 9: Optional Google Drive and Sheets

Only required if you enable Google backups. Create an OAuth application in the Google Cloud project operated by the platform. Add the exact redirect URI such as `https://swarnalive.com/api/drive/callback` to its authorized redirect URIs. The request origin and registered Google redirect must match exactly. Configure:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

For a new integration, `TOKEN_ENCRYPTION_KEY` must decode as a **32-byte AES key**. You can generate one with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Use the exact value in the secret. Store a backup securely. Rotating it later makes stored encrypted Google refresh tokens unreadable without a migration. Change `GOOGLE_REDIRECT_URI` in Wrangler vars to your registered callback and redeploy.

Google Drive folder and Google Sheets URLs alone are not permission grants: the owner must complete OAuth authorization. Google service permissions, testing mode, account eligibility and quotas may require configuration outside this repository.

### Step 10: Production cutover (ONLY AFTER staging works)

1. Back up existing D1, R2 data and GitHub branch. Compare schemas and migration history, do not assume a fresh staging database equals your live customer database.
2. Review `wrangler.production.example.jsonc` and copy/adapt the values into a separate production configuration **only after** verifying the actual production Worker name, D1 database ID and R2 bucket. The example file is not auto-loaded by Wrangler.
3. Reuse existing live `PIN_PEPPER`, `OTP_PEPPER` and `TOKEN_ENCRYPTION_KEY` values for an in-place migration. Changing them will break PIN verification or Google connections.
4. Deploy to your chosen production Worker after QA; confirm `https://swarnalive.com/api/auth/me` returns JSON. In Cloudflare Workers & Pages > your Worker > Settings > Domains & Routes, assign the correct hostname. Do not point two competing Workers at the same hostname.
5. Optional: map `admin.swarnalive.com` to the same Worker. It serves the separate admin landing page on that hostname. Master admin OTP still protects sensitive operations.
6. Verify registration, owner OTP, PIN, order search, photo retrieval, printing and backups again, with a rollback plan ready.

## Known limitations

The cropped reference photographs are not high-resolution masters. Printing uses the device's browser print dialogs, rather than automatic assignment to distinct printers. Live India gold pricing is not provisioned here. Financial and legal requirements should be reviewed before storing actual customer identity and gold-pawn transaction data.
