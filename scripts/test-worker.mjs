import assert from 'node:assert/strict';
import { readFileSync,existsSync } from 'node:fs';
import path from 'node:path';
import worker from '../src/worker.js';
const root = new URL('../',import.meta.url);
function present(f){assert.ok(existsSync(new URL(f,root)), `Missing file ${f}`)}
for (const f of ['public/index.html','public/login.html','public/register.html','public/admin.html','public/reset.html',
'public/app.js','public/styles.css','public/platform.js','public/platform.css',
'public/assets/hero-jewellery.jpg','public/assets/login-jewellery.jpg','public/assets/registration-jewellery.jpg',
'src/worker.js','src/onboarding.js','wrangler.jsonc',
'migrations/0001_init.sql','migrations/0002_google_sheets.sql',
'migrations/0003_email_otp.sql','migrations/0004_business_onboarding.sql']) present(f);
const env={DB:{},PHOTOS:{},PIN_PEPPER:'x'.repeat(64),OTP_PEPPER:'y'.repeat(64),ASSETS:{fetch: async(req)=>new Response('asset:'+new URL(req.url).pathname)}};
const ctx={waitUntil() {}};
let r=await worker.fetch(new Request('https://example.workers.dev/api/auth/me'),env,ctx);
assert.equal(r.status,200);
assert.deepEqual(await r.json(),{authenticated:false});
r=await worker.fetch(new Request('https://example.workers.dev/api/auth/me'),{...env,DB:null},ctx);
assert.equal(r.status,503);
assert.match((await r.json()).error,/Configure D1/);
r=await worker.fetch(new Request('https://example.workers.dev/login'),env,ctx);
assert.equal(await r.text(),'asset:/login.html');
r=await worker.fetch(new Request('https://admin.swarnalive.com/'),env,ctx);
assert.equal(await r.text(),'asset:/admin.html');
r=await worker.fetch(new Request('https://admin.swarnalive.com/secret-page'),env,ctx);
assert.equal(r.status,404);
const cfg = JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8').replace(/^\s*\/\/.*$/gm,''));
assert.equal(cfg.assets.run_worker_first,true);
assert.equal(cfg.d1_databases[0].binding,'DB');
assert.equal(cfg.r2_buckets[0].binding,'PHOTOS');
assert.ok(cfg.d1_databases[0].database_id.startsWith('REPLACE_'));
console.log('PASS: file layout, auth health endpoint, friendly aliases, admin route, config bindings');
