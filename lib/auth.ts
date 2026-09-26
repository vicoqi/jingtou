import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { ApiEnv } from './server.ts';
import type { AuthUser } from './types.ts';
import { bodyJson, fail, json } from './http.ts';

type UserRow=AuthUser & {password_hash:string};
const cookieName='jingtou_session';
const sessionSeconds=30*24*60*60;
const attemptWindow=15*60*1000;
// OWASP's 16 MiB scrypt configuration fits the Worker memory limit.
const passwordPrefix='scrypt$16384$8$5';
const dummyHash=`${passwordPrefix}$${'0'.repeat(32)}$${'0'.repeat(64)}`;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

export const authSchemaStatements=[
  'CREATE TABLE IF NOT EXISTS auth_users (id text PRIMARY KEY NOT NULL, email text NOT NULL UNIQUE, password_hash text NOT NULL, created_at text NOT NULL)',
  'CREATE TABLE IF NOT EXISTS auth_sessions (token_hash text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE, expires_at integer NOT NULL)',
  'CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions (expires_at)',
  'CREATE TABLE IF NOT EXISTS auth_attempts (key text PRIMARY KEY NOT NULL, attempts integer NOT NULL, expires_at integer NOT NULL)',
  'CREATE INDEX IF NOT EXISTS auth_attempts_expiry_idx ON auth_attempts (expires_at)',
];

function derive(password:string,salt:string):Promise<Buffer> {
  return new Promise((resolve,reject)=>scrypt(password,salt,32,{N:16384,r:8,p:5,maxmem:32*1024*1024},(error,key)=>error ? reject(error) : resolve(key)));
}
async function hashPassword(password:string):Promise<string> {
  const salt=randomBytes(16).toString('hex');
  return `${passwordPrefix}$${salt}$${(await derive(password,salt)).toString('hex')}`;
}
async function verifyPassword(password:string,encoded:string):Promise<boolean> {
  const parts=encoded.split('$');
  if (parts.length!==6 || parts.slice(0,4).join('$')!==passwordPrefix || !/^[a-f0-9]{32}$/.test(parts[4]) || !/^[a-f0-9]{64}$/.test(parts[5])) return false;
  return timingSafeEqual(await derive(password,parts[4]),Buffer.from(parts[5],'hex'));
}
function sessionToken(request:Request):string | null {
  const token=request.headers.get('cookie')?.split(';').map(part=>part.trim()).find(part=>part.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
function sessionCookie(request:Request,token:string,maxAge=sessionSeconds):string {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(request.url).protocol==='https:' ? '; Secure' : ''}`;
}
export async function sessionUser(request:Request,env:ApiEnv):Promise<AuthUser | null> {
  const token=sessionToken(request);
  if (!token) return null;
  return env.DB.prepare('SELECT u.id, u.email FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?').bind(digest(token),Date.now()).first<AuthUser>();
}
export async function requireUser(request:Request,env:ApiEnv):Promise<AuthUser> {
  const user=await sessionUser(request,env);
  if (!user) fail(401,'请先登录后继续使用。');
  const expectedUser=request.headers.get('x-jingtou-user');
  if (expectedUser && expectedUser!==user.id) fail(401,'当前账号已切换，请重新登录。');
  return user;
}
async function revokeSession(request:Request,env:ApiEnv):Promise<void> {
  const token=sessionToken(request);
  if (token) await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(digest(token)).run();
}
async function issueSession(request:Request,env:ApiEnv,user:AuthUser,status:number):Promise<Response> {
  const token=randomBytes(32).toString('hex');
  const now=Date.now();
  await env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(now).run();
  await env.DB.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(digest(token),user.id,now+sessionSeconds*1000).run();
  await revokeSession(request,env);
  const response=json({user},status);
  response.headers.set('set-cookie',sessionCookie(request,token));
  return response;
}
async function limitAttempts(env:ApiEnv,email:string):Promise<string> {
  const key=digest(email),now=Date.now();
  await env.DB.prepare('DELETE FROM auth_attempts WHERE expires_at <= ?').bind(now).run();
  const row=await env.DB.prepare('INSERT INTO auth_attempts (key, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1 RETURNING attempts').bind(key,now+attemptWindow).first<{attempts:number}>();
  if (!row || row.attempts>10) fail(429,'尝试次数过多，请在 15 分钟后重试。');
  return key;
}

export async function handleAuth(request:Request,env:ApiEnv):Promise<Response> {
  const path=new URL(request.url).pathname;
  if (path==='/api/auth/me' && request.method==='GET') return json({user:await sessionUser(request,env)});
  if (path==='/api/auth/logout' && request.method==='POST') {
    const expected=request.headers.get('x-jingtou-user');
    const user=expected ? await sessionUser(request,env) : null;
    if (user && expected!==user.id) fail(401,'当前账号已切换，请重新登录。');
    await revokeSession(request,env);
    const response=json({ok:true});
    response.headers.set('set-cookie',sessionCookie(request,'',0));
    return response;
  }
  if (!['/api/auth/register','/api/auth/login'].includes(path) || request.method!=='POST') fail(404,'Endpoint not found');
  if (request.headers.get('content-type')?.split(';')[0].trim()!=='application/json') fail(415,'请使用 JSON 提交登录信息。');
  const body=await bodyJson(request,4096);
  const email=typeof body.email==='string' ? body.email.trim().toLowerCase() : '';
  if (email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400,'请输入有效的邮箱地址。');
  if (typeof body.password!=='string' || body.password.length<8 || body.password.length>128) fail(400,'密码需要 8–128 个字符。');
  const attemptKey=await limitAttempts(env,email);
  const stored=await env.DB.prepare('SELECT id, email, password_hash FROM auth_users WHERE email = ?').bind(email).first<UserRow>();
  let user:AuthUser;
  const registering=path==='/api/auth/register';
  if (registering) {
    if (stored) fail(409,'该邮箱已注册，请直接登录。');
    user={id:crypto.randomUUID(),email};
    const encoded=await hashPassword(body.password);
    const result=await env.DB.prepare('INSERT INTO auth_users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING').bind(user.id,email,encoded,new Date().toISOString()).run();
    if (!result.meta.changes) fail(409,'该邮箱已注册，请直接登录。');
  } else {
    const valid=await verifyPassword(body.password,stored?.password_hash ?? dummyHash);
    if (!stored || !valid) fail(401,'邮箱或密码不正确。');
    user={id:stored.id,email:stored.email};
  }
  await env.DB.prepare('DELETE FROM auth_attempts WHERE key = ?').bind(attemptKey).run();
  return issueSession(request,env,user,registering ? 201 : 200);
}
