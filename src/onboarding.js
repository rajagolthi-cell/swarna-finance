// Add-on routes for the existing Swarna Finance Cloudflare Worker.
// Expects env.DB, env.RESEND_API_KEY, env.RESEND_FROM, env.OTP_PEPPER,
// env.MASTER_EMAIL. All credentials belong in Cloudflare secrets.
const enc = new TextEncoder();
const stamp = () => Date.now();
const uuid = () => crypto.randomUUID();
const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
const digest = async x => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(x))),x=>x.toString(16).padStart(2,'0')).join('');
const code6 = () => {const b=crypto.getRandomValues(new Uint32Array(1));return String(b[0]%1000000).padStart(6,'0');};
const out=(v,status=200,headers={})=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...headers}});
const err=(message,status=400)=>Object.assign(new Error(message),{status});
const clean=(v,max=200)=>typeof v==='string'?v.trim().slice(0,max+1):'';
const validEmail=x=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)&&x.length<=150;
const validCode=x=>/^\d{6}$/.test(x);
const body=async req=>{try{const v=await req.json();if(!v||typeof v!=='object'||Array.isArray(v))throw 0;return v;}catch{throw err('Invalid request');}};
const keyHash=async (env,id,code)=>digest(env.OTP_PEPPER+':'+id+':'+code);
const cookie=(value,req)=>`sf_admin=${value||''}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${value?28800:0}`;
const getCookie=req=>(req.headers.get('Cookie')||'').match(/(?:^|;\s*)sf_admin=([a-f0-9]{64})(?:;|$)/)?.[1];
async function mail(env,to,subject,content){
  if(!env.RESEND_API_KEY||!env.RESEND_FROM)throw err('Email delivery is not configured',503);
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:env.RESEND_FROM,to:[to],subject,text:content})});
  if(!r.ok)throw err('Email delivery failed',502);
}
async function admin(req,env){
  const t=getCookie(req);if(!t)return null;
  return env.DB.prepare('SELECT * FROM master_admin_sessions WHERE token_hash=? AND expires_at>?').bind(await digest(t),stamp()).first();
}
async function requireAdmin(req,env){const a=await admin(req,env);if(!a)throw err('Master administrator login required',401);return a;}
async function rate(env,scope,limit,windowMs){
  const cutoff=stamp()-windowMs;
  const row=await env.DB.prepare('SELECT COUNT(*) AS n FROM platform_rate_limits WHERE scope=? AND created_at>?').bind(scope,cutoff).first();
  if(row.n>=limit)throw err('Too many requests. Please try later.',429);
  await env.DB.prepare('INSERT INTO platform_rate_limits(id,scope,created_at) VALUES(?,?,?)').bind(uuid(),scope,stamp()).run();
}
async function issueChallenge(env,table,id,email,code,purpose,ownerId){
  const hash=await keyHash(env,id,code);
  if(table==='master_admin_challenges'){
    await env.DB.prepare('INSERT INTO master_admin_challenges(id,email,code_hash,expires_at,created_at) VALUES(?,?,?,?,?)').bind(id,email,hash,stamp()+600000,stamp()).run();
  }else{
    await env.DB.prepare('INSERT INTO account_recovery_challenges(id,owner_id,code_hash,purpose,expires_at,created_at) VALUES(?,?,?,?,?,?)').bind(id,ownerId,hash,purpose,stamp()+600000,stamp()).run();
  }
}
async function verifyChallenge(env,table,id,code){
  const row=await env.DB.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(id).first();
  if(!row||row.consumed_at||row.expires_at<stamp()||row.attempts>=5)throw err('Code expired or invalid',400);
  await env.DB.prepare(`UPDATE ${table} SET attempts=attempts+1 WHERE id=?`).bind(id).run();
  if(!validCode(code)||await keyHash(env,id,code)!==row.code_hash)throw err('Invalid verification code',400);
  return row;
}
async function passwordHash(password){
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const k=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
  const hash=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},k,256);
  const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
  return hex(salt)+':'+hex(hash);
}
async function audit(env,actor,action,target,details=''){
  await env.DB.prepare('INSERT INTO platform_audit_log(id,actor_email,action,target_id,details,created_at) VALUES(?,?,?,?,?,?)').bind(uuid(),actor,action,target,details,stamp()).run();
}
export async function onboarding(req,env){
  const url=new URL(req.url),p=url.pathname,m=req.method;
  if(!p.startsWith('/api/platform/'))return null;
  if(m!=='POST'&&m!=='GET')throw err('Method not allowed',405);
  if(m==='POST'){
    if(req.headers.get('Origin')&&req.headers.get('Origin')!==url.origin)throw err('Invalid origin',403);
    if(req.headers.get('Sec-Fetch-Site')==='cross-site')throw err('Cross-site request denied',403);
  }
  if(!env.DB||!env.OTP_PEPPER||env.OTP_PEPPER.length<32)throw err('Platform configuration missing',503);
  if(p==='/api/platform/apply'&&m==='POST'){
    const v=await body(req),email=clean(v.email,150).toLowerCase();
    const name=clean(v.owner_name,80),business=clean(v.business_name,80),phone=clean(v.phone,20),address=clean(v.address,240),city=clean(v.city,80),state=clean(v.state,80),pin=clean(v.pincode,12),type=clean(v.business_type,40);
    if(!validEmail(email)||name.length<2||business.length<2||!/^\+?[0-9\s-]{10,18}$/.test(phone)||address.length<5||!city||!state||!/^\d{6}$/.test(pin)||!['Jewellery retailer','Gold finance','Both'].includes(type))throw err('Please complete all required business details');
    await rate(env,'apply:'+await digest(email),3,86400000);
    const existing=await env.DB.prepare("SELECT id FROM business_applications WHERE email=? AND status='pending'").bind(email).first();
    if(existing)return out({ok:true,message:'If eligible, your application is already under review.'});
    const applicationId=uuid();
    await env.DB.prepare('INSERT INTO business_applications(id,owner_name,email,phone,business_name,business_type,address,city,state,pincode,gstin,notes,status,submitted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(applicationId,name,email,phone,business,type,address,city,state,pin,clean(v.gstin,20),clean(v.notes,500),'pending',stamp()).run();
    // Notify admin without exposing applicants to other users.
    try{await mail(env,env.MASTER_EMAIL,'New Swarna Finance business application',`A new application is awaiting review. Business: ${business}\nApplicant: ${name}\nReference: ${applicationId}\nOpen https://admin.swarnalive.com`);}catch(e){console.error('Admin notification failed',String(e));}
    return out({ok:true,reference:applicationId,message:'Application received. Approval is required.'},201);
  }
  if(p==='/api/platform/admin/start'&&m==='POST'){
    if(url.hostname!=='admin.swarnalive.com'&&!url.hostname.endsWith('.workers.dev')&&url.hostname!=='localhost')throw err('Use the master portal',403);
    const v=await body(req),email=clean(v.email,150).toLowerCase();
    await rate(env,'admin-login:'+await digest(email),5,3600000);
    if(email===env.MASTER_EMAIL.toLowerCase()){
      const cid=uuid(),code=code6();
      await issueChallenge(env,'master_admin_challenges',cid,email,code);
      await mail(env,email,'Swarna Finance master login code',`Your master login OTP is ${code}. It expires in 10 minutes. Never share this code.`);
      return out({ok:true,challenge_id:cid});
    }
    return out({ok:true,challenge_id:uuid()});
  }
  if(p==='/api/platform/admin/verify'&&m==='POST'){
    const v=await body(req),cid=clean(v.challenge_id,50),code=clean(v.code,6);
    await rate(env,'admin-verify:'+await digest(cid),8,900000);
    const c=await verifyChallenge(env,'master_admin_challenges',cid,code);
    if(c.email!==env.MASTER_EMAIL.toLowerCase())throw err('Access denied',403);
    await env.DB.prepare('UPDATE master_admin_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL').bind(stamp(),cid).run();
    const t=rand();
    await env.DB.prepare('INSERT INTO master_admin_sessions(token_hash,email,expires_at,created_at) VALUES(?,?,?,?)').bind(await digest(t),c.email,stamp()+28800000,stamp()).run();
    return out({ok:true},200,{'Set-Cookie':cookie(t,req)});
  }
  if(p==='/api/platform/admin/logout'&&m==='POST'){
    const t=getCookie(req);if(t)await env.DB.prepare('DELETE FROM master_admin_sessions WHERE token_hash=?').bind(await digest(t)).run();
    return out({ok:true},200,{'Set-Cookie':cookie(null,req)});
  }
  if(p==='/api/platform/admin/applications'&&m==='GET'){
    await requireAdmin(req,env);
    const rows=await env.DB.prepare('SELECT * FROM business_applications ORDER BY submitted_at DESC LIMIT 100').all();
    return out({applications:rows.results});
  }
  if(p==='/api/platform/admin/review'&&m==='POST'){
    const a=await requireAdmin(req,env),v=await body(req),id=clean(v.id,50),decision=clean(v.decision,20);
    if(!['approve','reject'].includes(decision))throw err('Invalid decision');
    const application=await env.DB.prepare('SELECT * FROM business_applications WHERE id=? AND status=?').bind(id,'pending').first();
    if(!application)throw err('Pending application not found',404);
    if(decision==='reject'){
      await env.DB.prepare("UPDATE business_applications SET status='rejected',reviewed_at=?,reviewed_by=?,review_notes=? WHERE id=? AND status='pending'").bind(stamp(),a.email,clean(v.notes,300),id).run();
      await audit(env,a.email,'reject_application',id);
      return out({ok:true});
    }
    const duplicate=await env.DB.prepare('SELECT id FROM owners WHERE email=?').bind(application.email).first();
    if(duplicate)throw err('This email already belongs to an existing owner',409);
    const ownerId=uuid();
    // Owner account is created with a random unusable password until activation.
    const password=rand()+rand();
    await env.DB.prepare('INSERT INTO owners(id,business,name,email,password_hash,created_at) VALUES(?,?,?,?,?,?)').bind(ownerId,application.business_name,application.owner_name,application.email,await passwordHash(password),new Date().toISOString()).run();
    await env.DB.prepare("UPDATE business_applications SET status='approved',reviewed_at=?,reviewed_by=?,owner_id=? WHERE id=? AND status='pending'").bind(stamp(),a.email,ownerId,id).run();
    const cid=uuid(),code=code6();
    await issueChallenge(env,'account_recovery_challenges',cid,application.email,code,'account_activation',ownerId);
    await mail(env,application.email,'Swarna Finance business approved',`Your business has been approved. Go to https://swarnalive.com/reset.html and choose Activate account. Your activation reference is ${cid} and OTP is ${code}. Both expire in 10 minutes.`);
    await audit(env,a.email,'approve_application',id,ownerId);
    return out({ok:true,message:'Approved. Activation instructions emailed.'});
  }
  if(p==='/api/platform/recovery/start'&&m==='POST'){
    const v=await body(req),email=clean(v.email,150).toLowerCase();
    if(!validEmail(email))throw err('Enter a valid email');
    await rate(env,'recovery:'+await digest(email),3,3600000);
    const owner=await env.DB.prepare('SELECT id,email FROM owners WHERE email=?').bind(email).first();
    if(owner){
      const cid=uuid(),code=code6();
      await issueChallenge(env,'account_recovery_challenges',cid,email,code,'password_reset',owner.id);
      await mail(env,email,'Swarna Finance password reset code',`Your password reset reference is ${cid}. Your OTP is ${code}. Both expire in 10 minutes. If you did not request this, ignore this email.`);
    }
    return out({ok:true,message:'If the account exists, reset instructions have been emailed.'});
  }
  if(p==='/api/platform/recovery/finish'&&m==='POST'){
    const v=await body(req),cid=clean(v.challenge_id,50),code=clean(v.code,6),password=v.password;
    if(typeof password!=='string'||password.length<12||password.length>128)throw err('Use a password of 12–128 characters');
    await rate(env,'recovery-verify:'+await digest(cid),8,900000);
    const c=await verifyChallenge(env,'account_recovery_challenges',cid,code);
    await env.DB.prepare('UPDATE owners SET password_hash=? WHERE id=?').bind(await passwordHash(password),c.owner_id).run();
    await env.DB.prepare('UPDATE account_recovery_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL').bind(stamp(),cid).run();
    await env.DB.prepare('DELETE FROM sessions WHERE owner_id=?').bind(c.owner_id).run();
    await audit(env,'owner:'+c.owner_id,c.purpose,c.owner_id);
    return out({ok:true,message:'Password set. Sign in with your new password.'});
  }
  if(p==='/api/platform/admin/reset-owner'&&m==='POST'){
    const a=await requireAdmin(req,env),v=await body(req),email=clean(v.email,150).toLowerCase();
    const owner=await env.DB.prepare('SELECT id,email FROM owners WHERE email=?').bind(email).first();
    if(!owner)throw err('Owner not found',404);
    await rate(env,'admin-reset:'+owner.id,3,3600000);
    const cid=uuid(),code=code6();
    await issueChallenge(env,'account_recovery_challenges',cid,email,code,'password_reset',owner.id);
    await mail(env,email,'Swarna Finance account recovery',`The platform administrator requested a password reset. Reference: ${cid}\nOTP: ${code}\nComplete at https://swarnalive.com/reset.html within 10 minutes.`);
    await audit(env,a.email,'request_owner_reset',owner.id);
    return out({ok:true});
  }
  if(p==='/api/platform/admin/change-email'&&m==='POST'){
    const a=await requireAdmin(req,env),v=await body(req),oldEmail=clean(v.old_email,150).toLowerCase(),newEmail=clean(v.new_email,150).toLowerCase();
    if(!validEmail(newEmail))throw err('Invalid new email');
    const owner=await env.DB.prepare('SELECT id FROM owners WHERE email=?').bind(oldEmail).first();
    if(!owner)throw err('Owner not found',404);
    const used=await env.DB.prepare('SELECT id FROM owners WHERE email=?').bind(newEmail).first();
    if(used)throw err('New email is already registered',409);
    // Require confirmation from the new mailbox; do not change ownership immediately.
    const cid=uuid(),code=code6();
    await env.DB.prepare('INSERT INTO email_change_requests(id,owner_id,old_email,new_email,code_hash,expires_at,requested_by,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(cid,owner.id,oldEmail,newEmail,await keyHash(env,cid,code),stamp()+600000,a.email,stamp()).run();
    await mail(env,newEmail,'Confirm your new Swarna Finance email',`Your email change confirmation reference is ${cid}. OTP: ${code}. Give these to your platform administrator only after confirming this change is expected. Expires in 10 minutes.`);
    await audit(env,a.email,'request_email_change',owner.id,newEmail);
    return out({ok:true,request_id:cid,message:'Confirmation code sent to new email.'});
  }
  if(p==='/api/platform/admin/confirm-email'&&m==='POST'){
    const a=await requireAdmin(req,env),v=await body(req),id=clean(v.request_id,50),code=clean(v.code,6);
    const row=await env.DB.prepare('SELECT * FROM email_change_requests WHERE id=? AND consumed_at IS NULL').bind(id).first();
    if(!row||row.expires_at<stamp()||row.attempts>=5)throw err('Request expired',400);
    await env.DB.prepare('UPDATE email_change_requests SET attempts=attempts+1 WHERE id=?').bind(id).run();
    if(!validCode(code)||await keyHash(env,id,code)!==row.code_hash)throw err('Invalid code',400);
    await env.DB.prepare('UPDATE owners SET email=? WHERE id=? AND email=?').bind(row.new_email,row.owner_id,row.old_email).run();
    await env.DB.prepare('UPDATE email_change_requests SET consumed_at=? WHERE id=?').bind(stamp(),id).run();
    await env.DB.prepare('DELETE FROM sessions WHERE owner_id=?').bind(row.owner_id).run();
    await audit(env,a.email,'confirm_email_change',row.owner_id,row.old_email+' -> '+row.new_email);
    return out({ok:true});
  }
  throw err('Endpoint not found',404);
}
