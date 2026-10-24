# Codespaces — do these steps in order

1. Create a new **private** GitHub repository called `swarna-finance-complete` and open Codespaces.
2. Upload the downloaded ZIP using the VS Code Explorer. Open Terminal:

```bash
unzip Swarna_Finance_Complete_GitHub_Repository.zip -d /tmp/swarna-package
cp -a /tmp/swarna-package/swarna-finance-complete-repository/. .
npm install
npm run check
npm test
```

3. Sign into your Cloudflare account (Wrangler 4.119.0+):

```bash
npx wrangler login --device --browser=false
npx wrangler whoami
```

Open **https://dash.cloudflare.com/oauth2/device** separately, enter the fresh code and approve within five minutes. If Wrangler shows its help screen instead of device login, run `npm install -D wrangler@latest`, check `npx wrangler --version`, and retry.

4. Create new **staging** Cloudflare resources:

```bash
npx wrangler d1 create swarna-finance-complete-staging-db
npx wrangler r2 bucket create swarna-finance-complete-staging-photos
```

5. In `wrangler.jsonc`: paste the real `database_id` returned in step 4; replace `MASTER_EMAIL` with your private admin email; verify `RESEND_FROM` is authorized in Resend.

6. Initialize **only the new staging database**, then deploy:

```bash
npx wrangler d1 migrations apply swarna-finance-complete-staging-db --remote
npx wrangler deploy
```

7. In a private terminal run `node scripts/create-peppers.mjs` and store the two different values safely. Add secrets **one at a time**, pasting a matching value privately when prompted:

```bash
npx wrangler secret put PIN_PEPPER
npx wrangler secret put OTP_PEPPER
npx wrangler secret put RESEND_API_KEY
npx wrangler secret list
```

8. Verify the deployed API. Replace the URL with the one printed by `wrangler deploy`:

```bash
npm run verify:site -- https://YOUR-WORKER.workers.dev
```

9. Open staging `/`, `/login.html`, `/register.html`, `/reset.html`, `/admin.html`. Submit a test business application; sign into master admin using your configured `MASTER_EMAIL`; approve; activate the test owner; test OTP, PIN, order, photo and printing with **fictional data only**.

10. Once verified, see `DEPLOYMENT.md` before connecting `swarnalive.com` or the admin subdomain. **Do not copy staging databases over production, rotate production peppers or blindly run migrations on an existing live D1.**
