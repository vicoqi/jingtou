import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { handleApiRequest } from '../lib/server.ts';
import { apiRequest, testEnvironment } from './helpers/database.ts';

const password='a correct horse 电车';
const credentials=(email='creator@example.com')=>({email,password});
const cookieOf=(response:Response)=>response.headers.get('set-cookie')!.split(';')[0];

test('visitors can browse the fixed sample while personal data and copying still require login',async()=>{
  const {env,db}=testEnvironment();
  const path='/api/projects/sample-summer-letter';
  const response=await handleApiRequest(apiRequest(path),env);
  assert.equal(response.status,200);
  const {project}=await response.json();
  assert.equal(project.id,'sample-summer-letter');
  assert.equal(project.shots.length,12);
  for(const [url,method] of [[path,'PUT'],[path,'DELETE'],[`${path}/copy`,'POST'],[`${path}/generate`,'POST'],['/api/projects','GET'],['/api/library','GET'],['/api/upload','POST']] as const) {
    assert.equal((await handleApiRequest(apiRequest(url,method),env)).status,401,`${method} ${url}`);
  }
  assert.equal(db.count('projects'),0);
});

test('email registration starts a persistent private session without email verification', async () => {
  const {env,db}=testEnvironment();
  const response=await handleApiRequest(apiRequest('/api/auth/register','POST',credentials(' Creator@Example.com ')),env);
  assert.equal(response.status,201,await response.clone().text());
  const {user}=await response.json();
  assert.equal(user.email,'creator@example.com');
  assert.deepEqual(Object.keys(user).sort(),['email','id']);
  const cookie=cookieOf(response);
  assert.match(response.headers.get('set-cookie')!,/HttpOnly/);
  assert.match(response.headers.get('set-cookie')!,/SameSite=Lax/);
  assert.match(response.headers.get('set-cookie')!,/Secure/);
  const me=await handleApiRequest(apiRequest('/api/auth/me','GET',undefined,cookie),{...env});
  assert.deepEqual(await me.json(),{user});
  const stored=db.sqlite.prepare('SELECT * FROM auth_users').get()!;
  assert.notEqual(stored.password_hash,password);
  assert.match(String(stored.password_hash),/^scrypt\$/);
  const session=db.sqlite.prepare('SELECT * FROM auth_sessions').get()!;
  const token=cookie.split('=')[1];
  assert.equal(session.token_hash,createHash('sha256').update(token).digest('hex'));
  assert.ok(Number(session.expires_at)>Date.now());
  assert.equal(JSON.stringify(stored).includes(password),false);
});

test('validation and duplicate registration do not overwrite an account', async () => {
  const {env,db}=testEnvironment();
  for (const input of [{email:'bad',password},{email:'ok@example.com',password:'short'},{email:'ok@example.com',password:'x'.repeat(129)}]) {
    assert.equal((await handleApiRequest(apiRequest('/api/auth/register','POST',input),env)).status,400);
  }
  assert.equal((await handleApiRequest(apiRequest('/api/auth/register','POST',credentials()),env)).status,201);
  assert.equal((await handleApiRequest(apiRequest('/api/auth/register','POST',{email:'CREATOR@example.com',password:'different password'}),env)).status,409);
  assert.equal(db.count('auth_users'),1);
  assert.equal((await handleApiRequest(apiRequest('/api/auth/login','POST',credentials()),env)).status,200);
  const other=await handleApiRequest(apiRequest('/api/auth/register','POST',credentials('other@example.com')),env);
  assert.equal(other.status,201);
  const hashes=db.sqlite.prepare('SELECT password_hash FROM auth_users').all();
  assert.notEqual(hashes[0].password_hash,hashes[1].password_hash,'equal passwords must use different salts');
});

test('login rejects wrong credentials, rotates tokens, and logout revokes the cookie immediately', async () => {
  const {env}=testEnvironment();
  const registered=await handleApiRequest(apiRequest('/api/auth/register','POST',credentials()),env);
  assert.equal(registered.status,201);
  const oldCookie=cookieOf(registered);
  const bad=await handleApiRequest(apiRequest('/api/auth/login','POST',{...credentials(),password:'wrong password'}),env);
  const missing=await handleApiRequest(apiRequest('/api/auth/login','POST',credentials('missing@example.com')),env);
  assert.equal(bad.status,401);
  assert.equal(missing.status,401);
  assert.deepEqual(await bad.json(),await missing.json());
  const login=await handleApiRequest(apiRequest('/api/auth/login','POST',credentials(),oldCookie),env);
  assert.equal(login.status,200);
  const cookie=cookieOf(login);
  assert.notEqual(cookie,oldCookie);
  assert.equal((await handleApiRequest(apiRequest('/api/projects','GET',undefined,oldCookie),env)).status,401);
  const logout=await handleApiRequest(apiRequest('/api/auth/logout','POST',undefined,cookie),env);
  assert.equal(logout.status,200);
  assert.match(logout.headers.get('set-cookie')!,/Max-Age=0/);
  assert.deepEqual(await (await handleApiRequest(apiRequest('/api/auth/me','GET',undefined,cookie),env)).json(),{user:null});
  assert.equal((await handleApiRequest(apiRequest('/api/projects','GET',undefined,cookie),env)).status,401);
});

test('expired and forged sessions and legacy local identities cannot access private endpoints', async () => {
  const {env,db}=testEnvironment();
  for (const origin of ['http://localhost:3000','http://127.0.0.1:3000','http://192.168.1.112:3000','https://studio.example']) {
    const req=new Request(`${origin}/api/projects`,{headers:{'oai-authenticated-user-email':'a@example.com','JINGTOU_LOCAL_WORKSPACE':'1'}});
    assert.equal((await handleApiRequest(req,{...env,JINGTOU_LOCAL_WORKSPACE:'1'} as typeof env)).status,401,origin);
  }
  const registration=await handleApiRequest(apiRequest('/api/auth/register','POST',credentials()),env);
  assert.equal(registration.status,201);
  const cookie=cookieOf(registration);
  db.sqlite.prepare('UPDATE auth_sessions SET expires_at = 0').run();
  assert.equal((await handleApiRequest(apiRequest('/api/library','GET',undefined,cookie),env)).status,401);
  assert.equal((await handleApiRequest(apiRequest('/api/config','GET',undefined,'jingtou_session=forged'),env)).status,401);
});

test('two accounts cannot read, save, delete or generate each other’s projects or retrieve their images', async () => {
  const {env}=testEnvironment();
  const a=await handleApiRequest(apiRequest('/api/auth/register','POST',credentials('a@example.com')),env);
  const b=await handleApiRequest(apiRequest('/api/auth/register','POST',credentials('b@example.com')),env);
  assert.equal(a.status,201); assert.equal(b.status,201);
  const ca=cookieOf(a),cb=cookieOf(b);
  const {user:ua}=await a.json();
  const {project}=await (await handleApiRequest(apiRequest('/api/projects','POST',{name:'A project',demo:true,owner:'b@example.com'},ca),env)).json();
  const {projects}=await (await handleApiRequest(apiRequest('/api/projects','GET',undefined,cb),env)).json();
  assert.equal(projects.some((p:{id:string})=>p.id===project.id),false);
  assert.deepEqual(await (await handleApiRequest(apiRequest('/api/library','GET',undefined,cb),env)).json(),{characters:[],scenes:[]});
  let providerCalled=false;
  for (const [suffix,method,body] of [['','GET',undefined],['','PUT',{project}],['','DELETE',undefined],['/generate','POST',{shotId:project.shots[0].id,count:1}],['/generate-scene','POST',{sceneId:'scene',count:1}]] as const) {
    const result=await handleApiRequest(apiRequest(`/api/projects/${project.id}${suffix}`,method,body,cb),{...env,IMAGE_API_KEY:'test',IMAGE_MODEL:'test'},{fetcher:async()=>{providerCalled=true;throw new Error('must not generate');}});
    assert.equal(result.status,404,`${method} ${suffix}`);
  }
  assert.equal(providerCalled,false);
  const form=new FormData();
  form.set('file',new File([new Uint8Array([137,80,78,71,13,10,26,10,0])],'a.png',{type:'image/png'}));
  const upload=await handleApiRequest(new Request('https://studio.example/api/upload',{method:'POST',headers:{cookie:ca},body:form}),env);
  const {image}=await upload.json();
  const ownImage=await handleApiRequest(apiRequest(image.url,'GET',undefined,ca),env);
  assert.equal(ownImage.status,200);
  assert.match(ownImage.headers.get('cache-control')!,/no-store/);
  assert.equal((await handleApiRequest(apiRequest(image.url,'GET',undefined,cb),env)).status,404);
  const spoof=new Request(`https://studio.example/api/projects/${project.id}`,{headers:{cookie:cb,'oai-authenticated-user-email':'a@example.com'}});
  assert.equal((await handleApiRequest(spoof,env)).status,404);
  const staleTab=new Request('https://studio.example/api/projects',{method:'POST',headers:{cookie:cb,'content-type':'application/json','x-jingtou-user':ua.id},body:JSON.stringify({name:'stale tab'})});
  assert.equal((await handleApiRequest(staleTab,env)).status,401);
  const staleLogout=new Request('https://studio.example/api/auth/logout',{method:'POST',headers:{cookie:cb,'x-jingtou-user':ua.id}});
  assert.equal((await handleApiRequest(staleLogout,env)).status,401,'an old tab cannot log out the new account');
  assert.ok((await (await handleApiRequest(apiRequest('/api/auth/me','GET',undefined,cb),env)).json()).user);
});

test('cross-origin writes are rejected, and HTTP LAN cookies remain usable', async () => {
  const {env}=testEnvironment();
  const origin='http://192.168.1.112:3000';
  const registration=await handleApiRequest(apiRequest('/api/auth/register','POST',credentials(),'',origin),env);
  assert.equal(registration.status,201);
  assert.doesNotMatch(registration.headers.get('set-cookie')!,/Secure/);
  const cookie=cookieOf(registration);
  for (const path of ['/api/auth/login','/api/auth/register','/api/auth/logout','/api/projects','/api/upload']) {
    const response=await handleApiRequest(new Request(`${origin}${path}`,{method:'POST',headers:{cookie,origin:'https://evil.example','content-type':'application/json'},body:JSON.stringify(credentials())}),env);
    assert.equal(response.status,403,path);
  }
  assert.equal((await handleApiRequest(apiRequest('/api/projects','GET',undefined,cookie,origin),env)).status,200);
});

test('repeated failed logins are limited and recover after the window expires', async () => {
  const {env,db}=testEnvironment();
  for(let i=0;i<10;i++) assert.equal((await handleApiRequest(apiRequest('/api/auth/login','POST',credentials()),env)).status,401);
  const limited=await handleApiRequest(apiRequest('/api/auth/login','POST',credentials()),env);
  assert.equal(limited.status,429);
  db.sqlite.prepare('UPDATE auth_attempts SET expires_at = 0').run();
  assert.equal((await handleApiRequest(apiRequest('/api/auth/login','POST',credentials()),env)).status,401);
});
