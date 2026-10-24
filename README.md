# Swarna Finance — complete GitHub + Cloudflare repository

This is a **standalone source repository** assembled from the supplied Swarna Finance website and its Cloudflare repair, retaining the uploaded visual design and jewellery image assets. It includes the Worker API, moderated business registration, owner email OTP, six-digit staff PINs, finance records, print screens, Google Drive/Sheets integration points, database migrations and the admin portal.

**This source has not been deployed into your Cloudflare account, nor security-audited for real customer or financial production use.** The provided sample image crops came from a single reference board, not full-resolution originals. Existing customer data is **not** included in the ZIP.

## Project contents

```
swarna-finance-complete-repository/
├── public/
│   ├── index.html                  Public landing screen
│   ├── login.html                  Owner login + PIN + finance dashboard
│   ├── register.html               Business application
│   ├── reset.html                  OTP account activation/recovery
│   ├── admin.html                  Platform master admin
│   ├── assets/                     Three jewellery reference photo crops
│   ├── app.js                      Owner / employee frontend
│   ├── platform.js                 Registration and master admin frontend
│   └── *.css                       Complete reference styles
├── src/
│   ├── worker.js                   Worker API, auth, finance and backups
│   └── onboarding.js               Registration approvals and account recovery
├── migrations/
│   ├── 0001_init.sql
│   ├── 0002_google_sheets.sql
│   ├── 0003_email_otp.sql
│   └── 0004_business_onboarding.sql
├── .github/workflows/verify.yml        GitHub Actions verification
├── scripts/
│   ├── create-peppers.mjs
│   ├── test-worker.mjs
│   ├── test-schema.py
│   └── verify-site.mjs
├── docs/design-reference.png      Your uploaded design board
├── wrangler.jsonc                  Safe staging Worker config
├── wrangler.production.example.jsonc  Production reference; not auto-used
├── .dev.vars.example              Local-development secret name reference
├── QUICKSTART.md                  Short GitHub Codespaces checklist
├── DEPLOYMENT.md                  Detailed deployment and migration safety
├── package.json
└── .gitignore
```

## Quick start in GitHub Codespaces

1. Create a **private GitHub repository** named `swarna-finance-complete`. Open a new Codespace.
2. Upload `Swarna_Finance_Complete_GitHub_Repository.zip` through Codespaces Explorer. In the terminal at the root of your new repo:

```bash
unzip Swarna_Finance_Complete_GitHub_Repository.zip -d /tmp/swarna-package
cp -a /tmp/swarna-package/swarna-finance-complete-repository/. .
npm install
npm run check
npm test
```

3. Follow **[DEPLOYMENT.md](DEPLOYMENT.md)** for the mandatory D1/R2 creation, secrets and domain setup.
4. To commit and push, after reviewing what you are committing:

```bash
git add .
git commit -m "Build complete Swarna Finance website"
git push origin main
```

**Never commit** `.dev.vars`, raw customer photos, exported database backups, API secrets or password/PIN values.

## URLs after deployment

- `/` — public landing page
- `/login.html` or `/login` — owner sign-in, OTP, PIN and dashboard
- `/register.html` or `/register` — business onboarding request
- `/reset.html` or `/reset` — owner recovery and activation
- `/admin.html` — administrator login (email OTP protected)
- `/api/auth/me` — JSON health/signed-in-session check
- `admin.swarnalive.com` — optional master admin hostname after custom-domain setup

For a healthy unauthenticated Worker:

```bash
npm run verify:site -- https://YOUR-STAGING-WORKER.workers.dev
```

The endpoint must return JSON with `{"authenticated":false}`. HTML at `/api/auth/me` means a routing/deployment issue; a JSON 503 means missing D1, R2 or `PIN_PEPPER`.

## Existing production installations

The default Wrangler file **does not target your existing site**. It intentionally deploys as `swarna-finance-complete-staging`. **Never overwrite** the live Worker or apply new migrations to your current D1 without reviewing the current schema and export backup. Earlier builds had different migration filenames, so production migration history needs manual reconciliation. The SQL migrations in this ZIP are designed for a **new empty staging database**.

## Configuration

Required for this source:

- D1 database binding: `DB`
- Private R2 bucket binding: `PHOTOS`
- Worker secret `PIN_PEPPER` — at least 32 characters; never change if live PINs already exist
- Worker secret `OTP_PEPPER` — at least 32 characters
- Worker secret `RESEND_API_KEY` — Resend sender API key; verify sender domain first
- Wrangler **variable** `RESEND_FROM` — verified sender, e.g. `Swarna Finance <otp@swarnalive.com>`
- Wrangler **variable** `MASTER_EMAIL` — private platform administrator mailbox
- Optional Google secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` (must decode to a 32-byte AES key); `GOOGLE_REDIRECT_URI` must exactly match the Google OAuth registration.

Do not confuse `MASTER_EMAIL` (platform admin) with an individual store owner login.

## Features / practical limitations

- Employees have restricted operations; the owner unlocks management functions with their personal PIN.
- The page can print the receipt and compact label using browser print dialogs. **Automatically routing each output to a separate printer is not implemented** by browsers alone.
- Gold prices are entered manually for finance quotes in this source; there is no guaranteed live Visakhapatnam pricing feed.
- Google links alone do **not** authorize Drive/Sheets access; the authenticated OAuth connection is needed.
- Existing order numbers in the supplied backend use `SF-YYYYMMDD-xxxxxxxx` rather than the previously discussed store-specific `YY-NNNN` format; changing this safely requires a separate schema and workflow update.
- The uploaded backend currently stores one primary JPEG product photo per order; a separate scale-reading image field is not end-to-end implemented.
- Image fidelity is limited by reference-board crops. Only full-resolution original photos can match the original images at every viewport size.
- Financial handling (amount limits, redemptions, interest, printer models, regulatory compliance) needs additional independent production QA before real financial use.
