import { onboarding } from './onboarding.js';

const E = new TextEncoder();

const now = () => Date.now();
const today = () => new Date().toISOString();
const id = () => crypto.randomUUID();

const hex = bytes => [...new Uint8Array(bytes)]
  .map(x => x.toString(16).padStart(2,"0")).join("");

const sha = async value =>
  hex(await crypto.subtle.digest("SHA-256", E.encode(value)));

const token = () =>
  hex(crypto.getRandomValues(new Uint8Array(32)));

const bad = (message,status=400) =>
  Object.assign(new Error(message),{status});

const reply = (value,status=200,headers={}) =>
  new Response(JSON.stringify(value),{
    status,
    headers:{
      "Content-Type":"application/json",
      "Cache-Control":"no-store",
      ...headers
    }
  });

const txt = (v,max) =>
  typeof v==="string" ? v.trim().slice(0,max+1) : "";

const pinOK = v =>
  typeof v==="string" && /^\d{6}$/.test(v);

const emailOK = v =>
  typeof v==="string" &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) &&
  v.length<=150;

const phoneOK = v => /^\d{10}$/.test(v);

function normPhone(p) {
  let s=String(p||"").replace(/\D/g,"");
  return s.length===12 && s.startsWith("91") ? s.slice(2) : s;
}

async function parse(req) {
  try {
    const v=await req.json();
    if(!v || typeof v!=="object" || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw bad("Invalid JSON");
  }
}

// PASSWORD AND PIN HASHING

async function pbk(secret,salt) {
  const bytes=salt
    ? Uint8Array.from(salt.match(/../g),h=>parseInt(h,16))
    : crypto.getRandomValues(new Uint8Array(16));

  const key=await crypto.subtle.importKey(
    "raw",E.encode(secret),"PBKDF2",false,["deriveBits"]
  );

  const hash=await crypto.subtle.deriveBits({
    name:"PBKDF2",
    salt:bytes,
    iterations: 100000,
    hash:"SHA-256"
  },key,256);

  return hex(bytes)+":"+hex(hash);
}

async function check(secret,stored) {
  if(!stored || !/^[a-f0-9]{32}:[a-f0-9]{64}$/.test(stored)) {
    return false;
  }
  return (await pbk(secret,stored.split(":")[0]))===stored;
}

async function pinSig(pin,owner,pepper) {
  const key=await crypto.subtle.importKey(
    "raw",
    E.encode(pepper),
    {name:"HMAC",hash:"SHA-256"},
    false,
    ["sign"]
  );

  return hex(await crypto.subtle.sign(
    "HMAC",key,E.encode(owner+":"+pin)
  ));
}

// COOKIE SESSIONS

function cookie(t,req) {
  const secure=new URL(req.url).protocol==="https:" ? "; Secure" : "";

  return `sf_session=${t||""}; HttpOnly; SameSite=Lax; `+
    `Path=/; Max-Age=${t?604800:0}${secure}`;
}

function pendingCookie(t,req) {
  const secure=new URL(req.url).protocol==="https:" ? "; Secure" : "";

  return `sf_pending=${t||""}; HttpOnly; SameSite=Strict; `+
    `Path=/; Max-Age=${t?600:0}${secure}`;
}

function pendingToken(req) {
  const value=req.headers.get("Cookie")||"";

  return value.match(
    /(?:^|;\s*)sf_pending=([0-9a-f]{64})(?:;|$)/
  )?.[1]||null;
}

async function pendingOTP(req,env) {
  const t=pendingToken(req);
  if(!t) return null;

  return env.DB.prepare(`
    SELECT * FROM login_otp_challenges
    WHERE challenge_hash=?
      AND consumed_at IS NULL
      AND expires_at>?
  `).bind(await sha(t),now()).first();
}

function makeOTP() {
  const bytes=crypto.getRandomValues(new Uint32Array(1));
  return String(bytes[0]%1000000).padStart(6,"0");
}

async function otpHash(env,challengeHash,code) {
  const key=await crypto.subtle.importKey(
    "raw",
    E.encode(env.OTP_PEPPER),
    {name:"HMAC",hash:"SHA-256"},
    false,
    ["sign"]
  );

  return hex(await crypto.subtle.sign(
    "HMAC",key,E.encode(challengeHash+":"+code)
  ));
}

function maskedEmail(email) {
  const [local,domain]=email.split("@");
  return local.slice(0,2)+"*****@"+domain;
}

// SEND OTP THROUGH RESEND

async function sendLoginOTP(env,recipient,code) {
  if(
    !env.RESEND_API_KEY ||
    !env.RESEND_FROM ||
    !env.OTP_PEPPER ||
    env.OTP_PEPPER.length<32
  ) {
    throw bad("Email OTP is not configured",503);
  }

  const response=await fetch("https://api.resend.com/emails",{
    method:"POST",
    headers:{
      "Authorization":"Bearer "+env.RESEND_API_KEY,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      from:env.RESEND_FROM,
      to:[recipient],
      subject:"Your Swarna Finance sign-in code",
      text:
        "Your Swarna Finance verification code is "+
        code+
        ". It expires in 10 minutes. Never share this code.",
      html:
        `<div style="font-family:Arial;padding:30px;color:#173d32">`+
        `<h2>✦ Swarna Finance</h2>`+
        `<p>Enter this code to complete your sign-in:</p>`+
        `<p style="font-size:36px;letter-spacing:8px"><b>${code}</b></p>`+
        `<p>The code expires in 10 minutes. Do not share it.</p>`+
        `</div>`
    })
  });

  if(!response.ok) {
    console.error("Resend request failed:",response.status);
    throw bad("Could not send email OTP",502);
  }
}

function startPendingResponse(data,req,pending) {
  const headers=new Headers({
    "Content-Type":"application/json",
    "Cache-Control":"no-store"
  });

  headers.append("Set-Cookie",cookie(null,req));
  headers.append("Set-Cookie",pendingCookie(pending,req));

  return new Response(JSON.stringify(data),{
    status:200,
    headers
  });
}

function authWithCookies(data,req,sessionToken) {
  const headers=new Headers({
    "Content-Type":"application/json",
    "Cache-Control":"no-store"
  });

  headers.append("Set-Cookie",cookie(sessionToken,req));
  headers.append("Set-Cookie",pendingCookie(null,req));

  return new Response(JSON.stringify(data),{
    status:200,
    headers
  });
}

async function auth(req,env) {
  const match=(req.headers.get("Cookie")||"").match(
    /(?:^|;\s*)sf_session=([a-f0-9]{64})(?:;|$)/
  );

  if(!match) return null;

  const hash=await sha(match[1]);

  const session=await env.DB.prepare(`
    SELECT
      se.token_hash,
      se.owner_id,
      se.staff_id,
      se.expires_at,
      o.name AS owner_name,
      o.business,
      o.email,
      st.name AS staff_name,
      st.role,
      st.active
    FROM sessions se
    JOIN owners o ON o.id=se.owner_id
    LEFT JOIN staff st ON st.id=se.staff_id
    WHERE se.token_hash=?
  `).bind(hash).first();

  if(!session || session.expires_at<now()) return null;

  if(session.staff_id && !session.active) {
    session.staff_id=null;
    session.role=null;
    session.staff_name=null;
  }

  return session;
}

function requireLogin(s) {
  if(!s) throw bad("Please sign in",401);
  return s;
}

function requireStaff(s) {
  requireLogin(s);
  if(!s.staff_id) throw bad("Enter staff PIN first",403);
  return s;
}

function requireOwner(s) {
  requireStaff(s);
  if(s.role!=="owner") throw bad("Owner access only",403);
  return s;
}

// ATTEMPT LIMITS

async function throttle(env,key) {
  const row=await env.DB.prepare(
    "SELECT * FROM attempts WHERE key=?"
  ).bind(key).first();

  if(row && row.locked_until>now()) {
    throw bad("Too many attempts. Retry in 15 minutes.",429);
  }
}

async function fail(env,key) {
  const old=await env.DB.prepare(
    "SELECT * FROM attempts WHERE key=?"
  ).bind(key).first();

  const count=
    old && old.last_at>now()-900000
      ? old.failures+1
      : 1;

  await env.DB.prepare(`
    INSERT INTO attempts
      (key,failures,last_at,locked_until)
    VALUES(?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET
      failures=excluded.failures,
      last_at=excluded.last_at,
      locked_until=excluded.locked_until
  `).bind(
    key,
    count,
    now(),
    count>=6?now()+900000:0
  ).run();
}

async function clearFail(env,key) {
  await env.DB.prepare(
    "DELETE FROM attempts WHERE key=?"
  ).bind(key).run();
}

async function verifyPIN(env,staff,pin) {
  if(!pinOK(pin)) throw bad("Enter a six-digit PIN");

  const key="pin:"+staff.id;
  await throttle(env,key);

  const correct=await check(
    pin+env.PIN_PEPPER,
    staff.pin_hash
  );

  if(!correct) {
    await fail(env,key);
    throw bad("Incorrect PIN",401);
  }

  await clearFail(env,key);
}

function publicOrder(x) {
  return {
    id:x.id,
    number:x.number,
    customer:x.customer,
    phone:x.phone,
    item:x.item,
    description:x.description,
    weight:x.weight,
    rate:x.rate,
    percent:x.percent,
    amount:x.amount,
    created_at:x.created_at,
    staff_name:x.staff_name||"",
    backup_status:x.backup_status,
    sheet_status:x.sheet_status
  };
}

// GOOGLE TOKEN ENCRYPTION

function b64(bytes) {
  let value="";
  for(const b of bytes) value+=String.fromCharCode(b);
  return btoa(value);
}

function unb64(s) {
  return Uint8Array.from(atob(s),c=>c.charCodeAt(0));
}

async function aesKey(env) {
  const key=unb64(env.TOKEN_ENCRYPTION_KEY);

  if(key.length!==32) {
    throw bad("Invalid TOKEN_ENCRYPTION_KEY",503);
  }

  return crypto.subtle.importKey(
    "raw",key,"AES-GCM",false,["encrypt","decrypt"]
  );
}

async function encrypt(env,value) {
  const iv=crypto.getRandomValues(new Uint8Array(12));

  const encrypted=await crypto.subtle.encrypt(
    {name:"AES-GCM",iv},
    await aesKey(env),
    E.encode(value)
  );

  return b64(iv)+"."+b64(new Uint8Array(encrypted));
}

async function decrypt(env,value) {
  const [iv,payload]=value.split(".");

  const decrypted=await crypto.subtle.decrypt(
    {name:"AES-GCM",iv:unb64(iv)},
    await aesKey(env),
    unb64(payload)
  );

  return new TextDecoder().decode(decrypted);
}

// GOOGLE OAUTH

async function tokenResponse(data) {
  const response=await fetch("https://oauth2.googleapis.com/token",{
    method:"POST",
    headers:{
      "Content-Type":"application/x-www-form-urlencoded"
    },
    body:new URLSearchParams(data)
  });

  const result=await response.json();

  if(!response.ok || !result.access_token) {
    throw bad("Google authorization failed. Reconnect Google.",502);
  }

  return result;
}

async function googleAccess(env,ownerId) {
  const connection=await env.DB.prepare(`
    SELECT * FROM drive_accounts WHERE owner_id=?
  `).bind(ownerId).first();

  if(!connection) {
    throw bad("Google Drive is not connected",409);
  }

  const refresh=await decrypt(
    env,
    connection.refresh_encrypted
  );

  const result=await tokenResponse({
    client_id:env.GOOGLE_CLIENT_ID,
    client_secret:env.GOOGLE_CLIENT_SECRET,
    refresh_token:refresh,
    grant_type:"refresh_token"
  });

  return {
    access:result.access_token,
    folder:connection.folder_id
  };
}

async function driveFolder(access,name) {
  const response=await fetch(
    "https://www.googleapis.com/drive/v3/files?fields=id,name",
    {
      method:"POST",
      headers:{
        Authorization:"Bearer "+access,
        "Content-Type":"application/json"
      },
      body:JSON.stringify({
        name,
        mimeType:"application/vnd.google-apps.folder"
      })
    }
  );

  const result=await response.json();

  if(!response.ok || !result.id) {
    throw bad("Could not create Google Drive folder",502);
  }

  return result.id;
}

async function driveUpload(access,folder,name,content,mime) {
  const boundary="sf"+id().replaceAll("-","");

  const meta=JSON.stringify({
    name,
    parents:[folder]
  });

  const payload=new Blob([
    `--${boundary}\r\n`+
    "Content-Type: application/json; charset=UTF-8\r\n\r\n"+
    meta+"\r\n",
    `--${boundary}\r\n`+
    `Content-Type: ${mime}\r\n\r\n`,
    content,
    `\r\n--${boundary}--\r\n`
  ]);

  const response=await fetch(
    "https://www.googleapis.com/upload/drive/v3/files"+
    "?uploadType=multipart&fields=id,name",
    {
      method:"POST",
      headers:{
        Authorization:"Bearer "+access,
        "Content-Type":"multipart/related; boundary="+boundary
      },
      body:payload
    }
  );

  const result=await response.json();

  if(!response.ok || !result.id) {
    throw bad("Google Drive upload failed",502);
  }

  return result.id;
}

// DRIVE ORDER BACKUP

async function syncOne(env,ownerId,orderId) {
  const claim=await env.DB.prepare(`
    UPDATE orders
    SET backup_status='syncing',backup_started=?
    WHERE id=? AND owner_id=?
      AND backup_status!='synced'
      AND (
        backup_status!='syncing'
        OR backup_started<?
      )
  `).bind(
    now(),orderId,ownerId,now()-600000
  ).run();

  if(claim.meta.changes!==1) return false;

  try {
    const row=await env.DB.prepare(`
      SELECT * FROM orders
      WHERE id=? AND owner_id=?
    `).bind(orderId,ownerId).first();

    const {access,folder}=await googleAccess(env,ownerId);

    let jsonId=row.drive_json_id;
    let photoId=row.drive_photo_id;

    if(!jsonId) {
      const {
        photo_key,
        drive_json_id,
        drive_photo_id,
        backup_started,
        backed_up_at,
        backup_status,
        ...record
      }=row;

      jsonId=await driveUpload(
        access,
        folder,
        row.number+".json",
        JSON.stringify({
          format:"swarna-finance-order-v1",
          order:record
        },null,2),
        "application/json"
      );

      await env.DB.prepare(`
        UPDATE orders SET drive_json_id=?
        WHERE id=?
      `).bind(jsonId,orderId).run();
    }

    if(!photoId) {
      const image=await env.PHOTOS.get(row.photo_key);

      if(!image) throw bad("Original image missing",404);

      photoId=await driveUpload(
        access,
        folder,
        row.number+".jpg",
        await image.arrayBuffer(),
        "image/jpeg"
      );

      await env.DB.prepare(`
        UPDATE orders SET drive_photo_id=?
        WHERE id=?
      `).bind(photoId,orderId).run();
    }

    await env.DB.prepare(`
      UPDATE orders
      SET backup_status='synced',backed_up_at=?
      WHERE id=?
    `).bind(today(),orderId).run();

    return true;
  } catch(error) {
    await env.DB.prepare(`
      UPDATE orders SET backup_status='failed'
      WHERE id=?
    `).bind(orderId).run();

    console.error("Google Drive backup error",String(error));
    return false;
  }
}

// GOOGLE SHEETS

const SHEET_COLUMNS=[
  "Order number",
  "Created at",
  "Customer",
  "Customer phone",
  "Item",
  "Description",
  "Weight (g)",
  "Gold rate (INR/g)",
  "Finance %",
  "Amount (INR)",
  "Employee",
  "Photo Drive URL",
  "Order ID"
];

function sheetIdFromURL(url) {
  if(typeof url!=="string") {
    throw bad("Paste Google Sheets URL");
  }

  let parsed;
  try {
    parsed=new URL(url);
  } catch {
    throw bad("Invalid spreadsheet URL");
  }

  if(
    parsed.protocol!=="https:" ||
    parsed.hostname!=="docs.google.com"
  ) {
    throw bad("Use a Google Sheets URL");
  }

  const match=parsed.pathname.match(
    /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})\/?/
  );

  if(!match) throw bad("Invalid Google Sheets URL");

  return match[1];
}

async function sheetRequest(
  access,spreadsheetId,range,method="GET",body
) {
  const path=
    "https://sheets.googleapis.com/v4/spreadsheets/"+
    encodeURIComponent(spreadsheetId)+
    "/values/"+
    encodeURIComponent(range);

  const suffix=method==="POST"
    ? ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS"
    : method==="PUT"
      ? "?valueInputOption=RAW"
      : "";

  const response=await fetch(path+suffix,{
    method,
    headers:{
      Authorization:"Bearer "+access,
      ...(body?{"Content-Type":"application/json"}:{})
    },
    ...(body?{body:JSON.stringify(body)}:{})
  });

  const data=await response.json().catch(()=>({}));

  if(!response.ok) {
    throw bad(
      "Google Sheets API error "+response.status,
      502
    );
  }

  return data;
}

async function ensureSheetHeader(access,sheetId) {
  const first=await sheetRequest(
    access,sheetId,"A1:M1"
  );

  if(
    !(first.values||[]).length ||
    !first.values[0]?.length
  ) {
    await sheetRequest(
      access,
      sheetId,
      "A1:M1",
      "PUT",
      {
        majorDimension:"ROWS",
        values:[SHEET_COLUMNS]
      }
    );
  } else if(first.values[0][0]!==SHEET_COLUMNS[0]) {
    throw bad(
      "Spreadsheet contains other data. Use an empty sheet.",
      409
    );
  }
}

async function syncSheetOne(env,ownerId,orderId) {
  const claim=await env.DB.prepare(`
    UPDATE orders
    SET sheet_status='syncing',sheet_started=?
    WHERE id=? AND owner_id=?
      AND sheet_status!='synced'
      AND (
        sheet_status!='syncing'
        OR sheet_started<?
      )
  `).bind(
    now(),orderId,ownerId,now()-600000
  ).run();

  if(claim.meta.changes!==1) return false;

  try {
    const sheet=await env.DB.prepare(`
      SELECT * FROM sheets_configs
      WHERE owner_id=?
    `).bind(ownerId).first();

    if(!sheet) throw bad("Spreadsheet not configured",409);

    const row=await env.DB.prepare(`
      SELECT o.*,st.name AS staff_name
      FROM orders o
      JOIN staff st ON st.id=o.staff_id
      WHERE o.id=? AND o.owner_id=?
    `).bind(orderId,ownerId).first();

    if(!row?.drive_photo_id) {
      throw bad("Photo Drive backup not completed",409);
    }

    const {access}=await googleAccess(env,ownerId);

    await ensureSheetHeader(
      access,
      sheet.spreadsheet_id
    );

    const existing=await sheetRequest(
      access,
      sheet.spreadsheet_id,
      "A2:A"
    );

    const found=(existing.values||[])
      .some(v=>v[0]===row.number);

    if(!found) {
      const values=[
        row.number,
        row.created_at,
        row.customer,
        row.phone,
        row.item,
        row.description,
        row.weight,
        row.rate,
        row.percent,
        row.amount,
        row.staff_name,
        "https://drive.google.com/file/d/"+
          row.drive_photo_id+"/view",
        row.id
      ];

      await sheetRequest(
        access,
        sheet.spreadsheet_id,
        "A:M",
        "POST",
        {
          majorDimension:"ROWS",
          values:[values]
        }
      );
    }

    await env.DB.prepare(`
      UPDATE orders
      SET sheet_status='synced',
          sheet_synced_at=?
      WHERE id=?
    `).bind(today(),row.id).run();

    return true;
  } catch(error) {
    await env.DB.prepare(`
      UPDATE orders SET sheet_status='failed'
      WHERE id=?
    `).bind(orderId).run();

    console.error("Google Sheets error",String(error));
    return false;
  }
}

// MAIN API ROUTER

async function handler(req,env,ctx) {
  if(
    !env.DB ||
    !env.PHOTOS ||
    !env.PIN_PEPPER ||
    env.PIN_PEPPER.length<32
  ) {
    throw bad(
      "Configure D1, R2 and PIN_PEPPER in Cloudflare",
      503
    );
  }

  const u=new URL(req.url);
  const path=u.pathname;
  const method=req.method;

  if(method!=="GET") {
    if(method!=="POST") {
      throw bad("Method not allowed",405);
    }

    if(
      req.headers.get("Origin") &&
      req.headers.get("Origin")!==u.origin
    ) {
      throw bad("Invalid origin",403);
    }

    if(req.headers.get("Sec-Fetch-Site")==="cross-site") {
      throw bad("Cross-site request denied",403);
    }
  }

  if(path.startsWith('/api/platform/')) {
    return await onboarding(req,env);
  }

  const s=await auth(req,env);

  // Public self-service signup is disabled: admin approval required.
  if(path==="/api/auth/signup") {
    throw bad("Use the business registration request form",403);
  }

  // PASSWORD LOGIN STARTS OTP CHALLENGE
  if(path==="/api/auth/login" && method==="POST") {
    const v=await parse(req);
    const email=txt(v.email,150).toLowerCase();

    if(!emailOK(email) || typeof v.password!=="string") {
      throw bad("Invalid credentials",401);
    }

    const key="login:"+await sha(email);
    await throttle(env,key);

    const owner=await env.DB.prepare(`
      SELECT * FROM owners WHERE email=?
    `).bind(email).first();

    if(
      !owner ||
      !(await check(v.password,owner.password_hash))
    ) {
      await fail(env,key);
      throw bad("Invalid credentials",401);
    }

    await clearFail(env,key);

    const recent=await env.DB.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(MAX(last_sent_at),0) AS last_sent_at
      FROM login_otp_challenges
      WHERE owner_id=? AND last_sent_at>?
    `).bind(owner.id,now()-3600000).first();

    if(
      recent.total>=10 ||
      recent.last_sent_at>now()-60000
    ) {
      throw bad("Wait before requesting another OTP",429);
    }

    if(
      !env.RESEND_API_KEY ||
      !env.RESEND_FROM ||
      !env.OTP_PEPPER ||
      env.OTP_PEPPER.length<32
    ) {
      throw bad("Email OTP is not configured",503);
    }

    const pending=token();
    const challengeHash=await sha(pending);
    const code=makeOTP();
    const timestamp=now();

    await env.DB.prepare(`
      INSERT INTO login_otp_challenges
      (
        challenge_hash,owner_id,code_hash,
        attempts,resend_count,last_sent_at,
        expires_at,created_at
      )
      VALUES(?,?,?,0,0,?,?,?)
    `).bind(
      challengeHash,
      owner.id,
      await otpHash(env,challengeHash,code),
      timestamp,
      timestamp+600000,
      today()
    ).run();

    try {
      await sendLoginOTP(env,owner.email,code);
    } catch(error) {
      await env.DB.prepare(`
        DELETE FROM login_otp_challenges
        WHERE challenge_hash=?
      `).bind(challengeHash).run();

      throw error;
    }

    if(s) {
      await env.DB.prepare(`
        DELETE FROM sessions WHERE token_hash=?
      `).bind(s.token_hash).run();
    }

    return startPendingResponse({
      ok:true,
      otp_required:true,
      email_masked:maskedEmail(owner.email)
    },req,pending);
  }

  // VERIFY EMAIL OTP
  if(path==="/api/auth/otp/verify" && method==="POST") {
    const pending=await pendingOTP(req,env);

    if(!pending) {
      return reply(
        {error:"Code expired. Sign in again."},
        401,
        {"Set-Cookie":pendingCookie(null,req)}
      );
    }

    if(pending.attempts>=5) {
      throw bad("Too many incorrect attempts",429);
    }

    const v=await parse(req);
    if(!pinOK(v.code)) {
      throw bad("Enter six-digit email OTP");
    }

    const actual=await otpHash(
      env,pending.challenge_hash,v.code
    );

    if(actual!==pending.code_hash) {
      await env.DB.prepare(`
        UPDATE login_otp_challenges
        SET attempts=attempts+1
        WHERE challenge_hash=?
          AND consumed_at IS NULL
          AND attempts<5
      `).bind(pending.challenge_hash).run();

      throw bad("Incorrect email OTP",401);
    }

    const claimed=await env.DB.prepare(`
      UPDATE login_otp_challenges
      SET consumed_at=?
      WHERE challenge_hash=?
        AND consumed_at IS NULL
        AND attempts<5
        AND expires_at>?
    `).bind(
      now(),
      pending.challenge_hash,
      now()
    ).run();

    if(claimed.meta.changes!==1) {
      throw bad("OTP already used or expired",401);
    }

    const sessionToken=token();

    await env.DB.prepare(`
      INSERT INTO sessions
      (token_hash,owner_id,staff_id,expires_at)
      VALUES(?,?,NULL,?)
    `).bind(
      await sha(sessionToken),
      pending.owner_id,
      now()+604800000
    ).run();

    await env.DB.prepare(`
      DELETE FROM login_otp_challenges
      WHERE challenge_hash=?
    `).bind(pending.challenge_hash).run();

    return authWithCookies(
      {ok:true},
      req,
      sessionToken
    );
  }

  // RESEND EMAIL OTP
  if(path==="/api/auth/otp/resend" && method==="POST") {
    const pending=await pendingOTP(req,env);

    if(!pending) throw bad("OTP expired",401);
    if(pending.attempts>=5) throw bad("Attempt limit reached",429);
    if(pending.resend_count>=3) throw bad("Resend limit reached",429);
    if(pending.last_sent_at>now()-60000) {
      throw bad("Wait 60 seconds before resending",429);
    }

    const code=makeOTP();
    const timestamp=now();

    const result=await env.DB.prepare(`
      UPDATE login_otp_challenges
      SET resend_count=resend_count+1,
          last_sent_at=?,
          expires_at=?,
          code_hash=?
      WHERE challenge_hash=?
        AND consumed_at IS NULL
        AND expires_at>?
        AND resend_count<3
        AND last_sent_at<=?
        AND attempts<5
    `).bind(
      timestamp,
      timestamp+600000,
      await otpHash(env,pending.challenge_hash,code),
      pending.challenge_hash,
      timestamp,
      timestamp-60000
    ).run();

    if(result.meta.changes!==1) {
      throw bad("Try again later",429);
    }

    const owner=await env.DB.prepare(`
      SELECT email FROM owners WHERE id=?
    `).bind(pending.owner_id).first();

    if(!owner) throw bad("Owner account missing",404);

    await sendLoginOTP(env,owner.email,code);

    return reply({
      ok:true,
      message:"New OTP sent to your email."
    });
  }

  // CANCEL OTP
  if(path==="/api/auth/otp/cancel" && method==="POST") {
    const pending=pendingToken(req);

    if(pending) {
      await env.DB.prepare(`
        DELETE FROM login_otp_challenges
        WHERE challenge_hash=?
      `).bind(await sha(pending)).run();
    }

    return reply(
      {ok:true},
      200,
      {"Set-Cookie":pendingCookie(null,req)}
    );
  }

  // LOGOUT
  if(path==="/api/auth/logout" && method==="POST") {
    if(s) {
      await env.DB.prepare(`
        DELETE FROM sessions WHERE token_hash=?
      `).bind(s.token_hash).run();
    }

    const pending=pendingToken(req);

    if(pending) {
      await env.DB.prepare(`
        DELETE FROM login_otp_challenges
        WHERE challenge_hash=?
      `).bind(await sha(pending)).run();
    }

    return authWithCookies({ok:true},req,null);
  }

  // CURRENT USER SESSION
  if(path==="/api/auth/me" && method==="GET") {
    if(!s) {
      const pending=await pendingOTP(req,env);

      if(!pending) return reply({authenticated:false});

      const owner=await env.DB.prepare(`
        SELECT email FROM owners WHERE id=?
      `).bind(pending.owner_id).first();

      return reply({
        authenticated:false,
        otp_pending:true,
        email_masked:owner?maskedEmail(owner.email):"",
        expires_in_seconds:Math.max(
          0,
          Math.floor((pending.expires_at-now())/1000)
        )
      });
    }

    const ownerPIN=await env.DB.prepare(`
      SELECT id FROM staff
      WHERE owner_id=? AND role='owner'
    `).bind(s.owner_id).first();

    return reply({
      authenticated:true,
      owner:{
        business:s.business,
        name:s.owner_name,
        email:s.email
      },
      has_owner_pin:!!ownerPIN,
      staff:s.staff_id
        ? {
            id:s.staff_id,
            name:s.staff_name,
            role:s.role
          }
        : null
    });
  }

  // INITIAL OWNER PIN
  if(path==="/api/auth/owner-pin" && method==="POST") {
    requireLogin(s);

    const existing=await env.DB.prepare(`
      SELECT id FROM staff
      WHERE owner_id=? AND role='owner'
    `).bind(s.owner_id).first();

    if(existing) throw bad("Owner PIN already created",409);

    const v=await parse(req);

    if(!pinOK(v.pin)) {
      throw bad("Enter six-digit owner PIN");
    }

    const signature=await pinSig(
      v.pin,s.owner_id,env.PIN_PEPPER
    );

    await env.DB.prepare(`
      INSERT INTO staff
      (id,owner_id,name,role,pin_hash,pin_sig,created_at)
      VALUES(?,?,?,?,?,?,?)
    `).bind(
      id(),
      s.owner_id,
      s.owner_name,
      "owner",
      await pbk(v.pin+env.PIN_PEPPER),
      signature,
      today()
    ).run();

    return reply({ok:true});
  }

  // STAFF LIST
  if(path==="/api/staff" && method==="GET") {
    requireLogin(s);

    const result=await env.DB.prepare(`
      SELECT id,name,role,active
      FROM staff
      WHERE owner_id=?
      ORDER BY role DESC,created_at
    `).bind(s.owner_id).all();

    return reply({staff:result.results});
  }

  // UNLOCK STAFF PROFILE
  if(path==="/api/auth/unlock" && method==="POST") {
    requireLogin(s);

    const v=await parse(req);

    const staff=await env.DB.prepare(`
      SELECT * FROM staff
      WHERE id=? AND owner_id=? AND active=1
    `).bind(v.id,s.owner_id).first();

    if(!staff) throw bad("Profile unavailable",404);

    await verifyPIN(env,staff,v.pin);

    await env.DB.prepare(`
      UPDATE sessions
      SET staff_id=?
      WHERE token_hash=?
    `).bind(staff.id,s.token_hash).run();

    return reply({ok:true});
  }

  // SWITCH PROFILE
  if(path==="/api/auth/lock" && method==="POST") {
    requireLogin(s);

    await env.DB.prepare(`
      UPDATE sessions SET staff_id=NULL
      WHERE token_hash=?
    `).bind(s.token_hash).run();

    return reply({ok:true});
  }

  // CREATE EMPLOYEE
  if(path==="/api/staff" && method==="POST") {
    requireOwner(s);

    const v=await parse(req);
    const name=txt(v.name,80);

    if(name.length<2 || name.length>80 || !pinOK(v.pin)) {
      throw bad("Enter employee name and six-digit PIN");
    }

    const signature=await pinSig(
      v.pin,s.owner_id,env.PIN_PEPPER
    );

    const exists=await env.DB.prepare(`
      SELECT id FROM staff
      WHERE owner_id=? AND pin_sig=?
    `).bind(s.owner_id,signature).first();

    if(exists) throw bad("PIN is already assigned",409);

    await env.DB.prepare(`
      INSERT INTO staff
      (id,owner_id,name,role,pin_hash,pin_sig,created_at)
      VALUES(?,?,?,?,?,?,?)
    `).bind(
      id(),
      s.owner_id,
      name,
      "employee",
      await pbk(v.pin+env.PIN_PEPPER),
      signature,
      today()
    ).run();

    return reply({ok:true},201);
  }

  // DISABLE EMPLOYEE
  const disable=path.match(
    /^\/api\/staff\/([a-f0-9-]+)\/disable$/
  );

  if(disable && method==="POST") {
    requireOwner(s);

    await env.DB.prepare(`
      UPDATE staff SET active=0
      WHERE id=? AND owner_id=? AND role='employee'
    `).bind(disable[1],s.owner_id).run();

    await env.DB.prepare(`
      UPDATE sessions SET staff_id=NULL
      WHERE staff_id=? AND owner_id=?
    `).bind(disable[1],s.owner_id).run();

    return reply({ok:true});
  }

  // HOME SUMMARY
  if(path==="/api/summary" && method==="GET") {
    requireStaff(s);

    const totals=await env.DB.prepare(`
      SELECT
        COUNT(*) AS n,
        COALESCE(SUM(amount),0) AS amount
      FROM orders WHERE owner_id=?
    `).bind(s.owner_id).first();

    const recent=await env.DB.prepare(`
      SELECT o.*,st.name AS staff_name
      FROM orders o
      JOIN staff st ON st.id=o.staff_id
      WHERE o.owner_id=?
      ORDER BY o.created_at DESC
      LIMIT 6
    `).bind(s.owner_id).all();

    const backups=await env.DB.prepare(`
      SELECT COUNT(*) AS n FROM orders
      WHERE owner_id=? AND backup_status='synced'
    `).bind(s.owner_id).first();

    return reply({
      total:Number(totals.n),
      amount:Number(totals.amount),
      backed_up:Number(backups.n),
      recent:recent.results.map(publicOrder)
    });
  }

  // LOOKUP ALL ORDERS BY PHONE
  if(path==="/api/orders" && method==="GET") {
    requireStaff(s);

    const phone=normPhone(
      u.searchParams.get("phone")
    );

    if(!phoneOK(phone)) {
      throw bad("Enter valid 10-digit mobile number");
    }

    const rows=await env.DB.prepare(`
      SELECT o.*,st.name AS staff_name
      FROM orders o
      JOIN staff st ON st.id=o.staff_id
      WHERE o.owner_id=? AND o.phone=?
      ORDER BY o.created_at DESC
      LIMIT 100
    `).bind(s.owner_id,phone).all();

    return reply({
      orders:rows.results.map(publicOrder)
    });
  }

  // CREATE NEW GOLD FINANCE ORDER
  if(path==="/api/orders" && method==="POST") {
    requireStaff(s);

    if(
      Number(req.headers.get("content-length")||0)>2400000
    ) {
      throw bad("Image upload too large",413);
    }

    let form;
    try {
      form=await req.formData();
    } catch {
      throw bad("Invalid finance form");
    }

    const customer=txt(form.get("customer"),80);
    const phone=normPhone(form.get("phone"));
    const item=txt(form.get("item"),80);
    const description=txt(
      form.get("description")||"",400
    );

    const weight=Number(form.get("weight"));
    const rate=Number(form.get("rate"));
    const percent=Number(form.get("percent"));

    const photo=form.get("photo");
    const pin=form.get("pin");

    if(
      customer.length<2 || customer.length>80 ||
      !phoneOK(phone) ||
      !item || item.length>80 ||
      description.length>400
    ) {
      throw bad("Customer details invalid");
    }

    if(
      !Number.isFinite(weight) ||
      weight<=0 || weight>10000 ||
      !Number.isFinite(rate) ||
      rate<=0 || rate>1000000 ||
      !Number.isFinite(percent) ||
      percent<=0 || percent>100
    ) {
      throw bad("Invalid weight, rate or percentage");
    }

    if(form.get("accepted")!=="yes") {
      throw bad("Customer agreement is required");
    }

    if(
      !(photo instanceof File) ||
      photo.type!=="image/jpeg" ||
      photo.size<3 ||
      photo.size>2000000
    ) {
      throw bad("JPEG photo under 2 MB required");
    }

    const imageBytes=new Uint8Array(
      await photo.arrayBuffer()
    );

    if(
      imageBytes[0]!==255 ||
      imageBytes[1]!==216 ||
      imageBytes[2]!==255
    ) {
      throw bad("Invalid JPEG image");
    }

    const staff=await env.DB.prepare(`
      SELECT * FROM staff
      WHERE id=? AND owner_id=? AND active=1
    `).bind(s.staff_id,s.owner_id).first();

    if(!staff) throw bad("Staff disabled",403);

    await verifyPIN(env,staff,pin);

    const orderId=id();
    const orderNumber=
      "SF-"+today().slice(0,10).replaceAll("-","")+
      "-"+orderId.slice(0,8).toUpperCase();

    const imageKey=s.owner_id+"/"+orderId+".jpg";

    const amount=
      Math.round(weight*rate*percent)/100;

    await env.PHOTOS.put(
      imageKey,
      imageBytes,
      {httpMetadata:{contentType:"image/jpeg"}}
    );

    try {
      await env.DB.prepare(`
        INSERT INTO orders
        (
          id,number,owner_id,staff_id,
          customer,phone,item,description,
          weight,rate,percent,amount,
          photo_key,created_at
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        orderId,
        orderNumber,
        s.owner_id,
        s.staff_id,
        customer,
        phone,
        item,
        description,
        weight,
        rate,
        percent,
        amount,
        imageKey,
        today()
      ).run();
    } catch(error) {
      await env.PHOTOS.delete(imageKey);
      throw error;
    }

    const connected=await env.DB.prepare(`
      SELECT owner_id FROM drive_accounts
      WHERE owner_id=?
    `).bind(s.owner_id).first();

    if(!connected) {
      await env.DB.prepare(`
        UPDATE orders
        SET backup_status='not-connected'
        WHERE id=?
      `).bind(orderId).run();
    }

    const sheets=await env.DB.prepare(`
      SELECT owner_id FROM sheets_configs
      WHERE owner_id=?
    `).bind(s.owner_id).first();

    if(sheets) {
      await env.DB.prepare(`
        UPDATE orders SET sheet_status='pending'
        WHERE id=?
      `).bind(orderId).run();
    }

    if(connected) {
      ctx.waitUntil((async()=>{
        await syncOne(env,s.owner_id,orderId);
        if(sheets) {
          await syncSheetOne(env,s.owner_id,orderId);
        }
      })());
    }

    return reply({
      ok:true,
      order:{
        id:orderId,
        number:orderNumber,
        backup_status:connected?"pending":"not-connected",
        sheet_status:sheets?"pending":"not-configured"
      }
    },201);
  }

  // PRIVATE PHOTO
  const photoRoute=path.match(
    /^\/api\/orders\/([a-f0-9-]+)\/photo$/
  );

  if(photoRoute && method==="GET") {
    requireStaff(s);

    const order=await env.DB.prepare(`
      SELECT photo_key FROM orders
      WHERE id=? AND owner_id=?
    `).bind(photoRoute[1],s.owner_id).first();

    if(!order) throw bad("Photo not found",404);

    const object=await env.PHOTOS.get(order.photo_key);

    if(!object) throw bad("Photo not found",404);

    return new Response(object.body,{
      headers:{
        "Content-Type":"image/jpeg",
        "Cache-Control":"private,no-store",
        "X-Content-Type-Options":"nosniff"
      }
    });
  }

  // GOOGLE DRIVE STATUS
  if(path==="/api/drive/status" && method==="GET") {
    requireOwner(s);

    const connection=await env.DB.prepare(`
      SELECT folder_id,connected_at
      FROM drive_accounts
      WHERE owner_id=?
    `).bind(s.owner_id).first();

    const totals=await env.DB.prepare(`
      SELECT backup_status,COUNT(*) AS n
      FROM orders
      WHERE owner_id=?
      GROUP BY backup_status
    `).bind(s.owner_id).all();

    return reply({
      connected:!!connection,
      folder_url:connection
        ? "https://drive.google.com/drive/u/0/folders/"+
          encodeURIComponent(connection.folder_id)
        : null,
      totals:totals.results
    });
  }

  // OWNER-SELECTED GOOGLE DRIVE FOLDER
  if(path==="/api/drive/folder" && method==="POST") {
    requireOwner(s);
    const v=await parse(req);
    const input=txt(v.url,1200);
    let parsed;
    try { parsed=new URL(input); } catch { throw bad("Invalid Google Drive folder link"); }
    if(parsed.protocol!=="https:" || parsed.hostname!=="drive.google.com") {
      throw bad("Use a Google Drive folder URL");
    }
    const match=parsed.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})\/?$/);
    if(!match) throw bad("Paste a Google Drive folder link ending in /folders/FOLDER_ID");
    const folderId=match[1];
    const {access}=await googleAccess(env,s.owner_id);
    const response=await fetch(
      "https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(folderId)+
      "?fields=id,mimeType,capabilities(canAddChildren)&supportsAllDrives=true",
      {headers:{Authorization:"Bearer "+access}}
    );
    if(!response.ok) throw bad("Google cannot access this folder. Authorize it for the app or use its existing Swarna Finance folder.",403);
    const folder=await response.json();
    if(folder.mimeType!=="application/vnd.google-apps.folder" || !folder.capabilities?.canAddChildren) {
      throw bad("This account cannot upload to the selected folder",403);
    }
    await env.DB.prepare("UPDATE drive_accounts SET folder_id=? WHERE owner_id=?")
      .bind(folderId,s.owner_id).run();
    // Previously synced files remain in their original folder. New backups use the selected folder.
    return reply({ok:true,folder_url:"https://drive.google.com/drive/folders/"+folderId});
  }

  // GOOGLE CONNECT
  if(path==="/api/drive/connect" && method==="GET") {
    requireOwner(s);

    if(
      !env.GOOGLE_CLIENT_ID ||
      !env.GOOGLE_CLIENT_SECRET ||
      !env.GOOGLE_REDIRECT_URI ||
      !env.TOKEN_ENCRYPTION_KEY
    ) {
      throw bad("Google OAuth is not configured",503);
    }

    const stateToken=token();

    await env.DB.prepare(`
      INSERT INTO oauth_states
      (state_hash,owner_id,session_hash,expires_at)
      VALUES(?,?,?,?)
    `).bind(
      await sha(stateToken),
      s.owner_id,
      s.token_hash,
      now()+600000
    ).run();

    const query=new URLSearchParams({
      client_id:env.GOOGLE_CLIENT_ID,
      redirect_uri:env.GOOGLE_REDIRECT_URI,
      response_type:"code",
      scope:
        "https://www.googleapis.com/auth/drive.file "+
        "https://www.googleapis.com/auth/spreadsheets",
      access_type:"offline",
      prompt:"consent",
      state:stateToken
    });

    return Response.redirect(
      "https://accounts.google.com/o/oauth2/v2/auth?"+
      query,
      302
    );
  }

  // GOOGLE OAUTH CALLBACK
  if(path==="/api/drive/callback" && method==="GET") {
    requireOwner(s);

    const stateValue=u.searchParams.get("state")||"";
    const code=u.searchParams.get("code");

    const row=stateValue
      ? await env.DB.prepare(`
          SELECT * FROM oauth_states WHERE state_hash=?
        `).bind(await sha(stateValue)).first()
      : null;

    if(
      !row ||
      row.owner_id!==s.owner_id ||
      row.session_hash!==s.token_hash ||
      row.expires_at<now() ||
      !code
    ) {
      throw bad("Google authorization expired. Retry.",400);
    }

    await env.DB.prepare(`
      DELETE FROM oauth_states
      WHERE state_hash=?
    `).bind(row.state_hash).run();

    const result=await tokenResponse({
      client_id:env.GOOGLE_CLIENT_ID,
      client_secret:env.GOOGLE_CLIENT_SECRET,
      redirect_uri:env.GOOGLE_REDIRECT_URI,
      code,
      grant_type:"authorization_code"
    });

    if(!result.refresh_token) {
      throw bad("Google did not grant offline access",502);
    }

    const folder=await driveFolder(
      result.access_token,
      "Swarna Finance Backups - "+s.business.slice(0,50)
    );

    await env.DB.prepare(`
      INSERT INTO drive_accounts
      (owner_id,refresh_encrypted,folder_id,connected_at)
      VALUES(?,?,?,?)
      ON CONFLICT(owner_id) DO UPDATE SET
        refresh_encrypted=excluded.refresh_encrypted,
        folder_id=excluded.folder_id,
        connected_at=excluded.connected_at
    `).bind(
      s.owner_id,
      await encrypt(env,result.refresh_token),
      folder,
      today()
    ).run();

    await env.DB.prepare(`
      UPDATE orders
      SET backup_status='pending',
          drive_json_id=NULL,
          drive_photo_id=NULL,
          backed_up_at=NULL
      WHERE owner_id=?
    `).bind(s.owner_id).run();

    return Response.redirect(
      u.origin+"/?drive=connected",
      302
    );
  }

  // MANUAL DRIVE SYNC
  if(path==="/api/drive/sync" && method==="POST") {
    requireOwner(s);

    const connected=await env.DB.prepare(`
      SELECT owner_id FROM drive_accounts
      WHERE owner_id=?
    `).bind(s.owner_id).first();

    if(!connected) throw bad("Connect Google Drive first",409);

    const rows=await env.DB.prepare(`
      SELECT id FROM orders
      WHERE owner_id=?
        AND backup_status!='synced'
        AND (
          backup_status!='syncing'
          OR backup_started<?
        )
      ORDER BY created_at
      LIMIT 5
    `).bind(s.owner_id,now()-600000).all();

    let success=0;

    for(const row of rows.results) {
      if(await syncOne(env,s.owner_id,row.id)) {
        success++;
      }
    }

    return reply({
      message:
        "Backed up "+success+" of "+
        rows.results.length+" attempted orders."
    });
  }

  // GOOGLE SHEETS STATUS
  if(path==="/api/sheets/status" && method==="GET") {
    requireOwner(s);

    const row=await env.DB.prepare(`
      SELECT spreadsheet_url,title
      FROM sheets_configs WHERE owner_id=?
    `).bind(s.owner_id).first();

    const totals=await env.DB.prepare(`
      SELECT sheet_status,COUNT(*) AS n
      FROM orders WHERE owner_id=?
      GROUP BY sheet_status
    `).bind(s.owner_id).all();

    return reply({
      configured:!!row,
      url:row?.spreadsheet_url||null,
      title:row?.title||null,
      totals:totals.results
    });
  }

  // LINK OWNER'S GOOGLE SHEET
  if(path==="/api/sheets/link" && method==="POST") {
    requireOwner(s);

    const v=await parse(req);
    const sheetId=sheetIdFromURL(v.url);
    const {access}=await googleAccess(env,s.owner_id);

    const response=await fetch(
      "https://sheets.googleapis.com/v4/spreadsheets/"+
      encodeURIComponent(sheetId)+
      "?fields=spreadsheetId,properties.title",
      {
        headers:{
          Authorization:"Bearer "+access
        }
      }
    );

    if(!response.ok) {
      throw bad("Cannot access Google spreadsheet",403);
    }

    const meta=await response.json();

    await ensureSheetHeader(access,sheetId);

    const url=
      "https://docs.google.com/spreadsheets/d/"+
      sheetId+"/edit";

    await env.DB.prepare(`
      INSERT INTO sheets_configs
      (
        owner_id,spreadsheet_id,
        spreadsheet_url,title,connected_at
      )
      VALUES(?,?,?,?,?)
      ON CONFLICT(owner_id) DO UPDATE SET
        spreadsheet_id=excluded.spreadsheet_id,
        spreadsheet_url=excluded.spreadsheet_url,
        title=excluded.title,
        connected_at=excluded.connected_at
    `).bind(
      s.owner_id,
      sheetId,
      url,
      String(meta.properties?.title||"Finance Orders").slice(0,120),
      today()
    ).run();

    await env.DB.prepare(`
      UPDATE orders
      SET sheet_status='pending',
          sheet_started=NULL,
          sheet_synced_at=NULL
      WHERE owner_id=?
    `).bind(s.owner_id).run();

    return reply({
      ok:true,
      title:meta.properties?.title||"Finance Orders",
      url
    });
  }

  // MANUAL SHEETS SYNC
  if(path==="/api/sheets/sync" && method==="POST") {
    requireOwner(s);

    const config=await env.DB.prepare(`
      SELECT owner_id FROM sheets_configs
      WHERE owner_id=?
    `).bind(s.owner_id).first();

    if(!config) throw bad("Link a Google Sheet first",409);

    const rows=await env.DB.prepare(`
      SELECT id FROM orders
      WHERE owner_id=?
        AND sheet_status!='synced'
        AND (
          sheet_status!='syncing'
          OR sheet_started<?
        )
      ORDER BY created_at
      LIMIT 5
    `).bind(s.owner_id,now()-600000).all();

    let success=0;

    for(const row of rows.results) {
      const order=await env.DB.prepare(`
        SELECT backup_status FROM orders
        WHERE id=? AND owner_id=?
      `).bind(row.id,s.owner_id).first();

      if(order?.backup_status!=="synced") {
        await syncOne(env,s.owner_id,row.id);
      }

      if(await syncSheetOne(env,s.owner_id,row.id)) {
        success++;
      }
    }

    return reply({
      message:
        "Synced "+success+" of "+
        rows.results.length+" selected orders."
    });
  }

  // UNLINK SHEETS
  if(path==="/api/sheets/unlink" && method==="POST") {
    requireOwner(s);

    await env.DB.prepare(`
      DELETE FROM sheets_configs WHERE owner_id=?
    `).bind(s.owner_id).run();

    await env.DB.prepare(`
      UPDATE orders
      SET sheet_status='not-configured'
      WHERE owner_id=?
    `).bind(s.owner_id).run();

    return reply({ok:true});
  }

  // DISCONNECT GOOGLE DRIVE
  if(path==="/api/drive/disconnect" && method==="POST") {
    requireOwner(s);

    await env.DB.prepare(`
      DELETE FROM drive_accounts WHERE owner_id=?
    `).bind(s.owner_id).run();

    await env.DB.prepare(`
      DELETE FROM sheets_configs WHERE owner_id=?
    `).bind(s.owner_id).run();

    await env.DB.prepare(`
      UPDATE orders
      SET sheet_status='not-configured'
      WHERE owner_id=?
    `).bind(s.owner_id).run();

    return reply({ok:true});
  }

  throw bad("API route not found",404);
}

// SCHEDULED BACKUP RETRIES

async function retryBackups(env) {
  await env.DB.prepare(`
    DELETE FROM login_otp_challenges
    WHERE expires_at<?
       OR consumed_at IS NOT NULL
  `).bind(now()).run();

  const rows=await env.DB.prepare(`
    SELECT
      o.id,
      o.owner_id,
      o.backup_status,
      o.sheet_status
    FROM orders o
    JOIN drive_accounts d ON d.owner_id=o.owner_id
    WHERE o.backup_status!='synced'
      AND (
        o.backup_status!='syncing'
        OR o.backup_started<?
      )
    ORDER BY o.created_at ASC
    LIMIT 15
  `).bind(now()-600000).all();

  for(const row of rows.results) {
    await syncOne(env,row.owner_id,row.id);

    if(
      row.sheet_status!=="not-configured" &&
      row.sheet_status!=="synced"
    ) {
      await syncSheetOne(env,row.owner_id,row.id);
    }
  }

  const pending=await env.DB.prepare(`
    SELECT o.id,o.owner_id
    FROM orders o
    JOIN sheets_configs s ON s.owner_id=o.owner_id
    WHERE o.backup_status='synced'
      AND o.sheet_status!='synced'
      AND (
        o.sheet_status!='syncing'
        OR o.sheet_started<?
      )
    ORDER BY o.created_at ASC
    LIMIT 15
  `).bind(now()-600000).all();

  for(const row of pending.results) {
    await syncSheetOne(env,row.owner_id,row.id);
  }
}

// CLOUDFLARE ENTRY POINT

export default {
  scheduled(event,env,ctx) {
    ctx.waitUntil(retryBackups(env));
  },

  async fetch(req,env,ctx) {
    try {
      const path=new URL(req.url).pathname;

      if(path.startsWith("/api/")) {
        return await handler(req,env,ctx);
      }

      if(new URL(req.url).hostname === 'admin.swarnalive.com') {
        if(path==='/' || path==='/index.html') {
          return env.ASSETS.fetch(new Request(new URL('/admin.html',req.url),req));
        }
        if(!['/admin.html','/platform.js','/platform.css'].includes(path)) {
          return new Response('Not found',{status:404});
        }
      }
      return env.ASSETS.fetch(req);
    } catch(error) {
      if(error.status) {
        return reply(
          {error:error.message},
          error.status
        );
      }

      console.error("Swarna Finance server error",String(error));

      return reply({
        error:"Unexpected server error. Check the configuration."
      },500);
    }
  }
};
