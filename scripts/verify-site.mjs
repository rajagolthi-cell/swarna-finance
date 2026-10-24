#!/usr/bin/env node
const origin = process.argv[2];
if (!origin || !/^https:\/\//.test(origin)) {
  console.error('Usage: npm run verify:site -- https://YOUR-WORKER.workers.dev');
  process.exit(2);
}
const url = new URL('/api/auth/me', origin);
try {
  const r = await fetch(url, {redirect:'manual',headers:{accept:'application/json'}});
  const ct = r.headers.get('content-type') || '';
  const body = await r.text();
  console.log('URL:',url.toString());
  console.log('HTTP:',r.status);
  console.log('Content-Type:',ct);
  if (!ct.toLowerCase().includes('application/json')) {
    console.error('FAIL: /api/auth/me returned non-JSON. Check Worker/custom-domain routing.');
    process.exit(1);
  }
  const j=JSON.parse(body);
  if (r.status===200 && typeof j.authenticated==='boolean') {
    console.log('PASS: Worker authentication API is responding');
  } else {
    console.error('API response:',JSON.stringify(j));
    console.error('FAIL: Check secrets, D1/R2 bindings and migrations.');
    process.exit(1);
  }
} catch(e) { console.error('FAIL:',e.message);process.exit(1); }
