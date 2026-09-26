import assert from 'node:assert/strict';
const origin = process.env.TEST_BASE_URL || 'http://localhost:3000';
let activeCookie = '';
const accounts = [];
const fetchAs = (cookie, url, options = {}) => {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  return fetch(url, {...options, headers});
};
const fetchSigned = (url, options) => fetchAs(activeCookie, url, options);
const register = async () => {
  const email = `smoke-${crypto.randomUUID()}@jingtou-test.invalid`;
  const password = crypto.randomUUID();
  const response = await fetch(`${origin}/api/auth/register`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});
  assert.equal(response.status,201,await response.clone().text());
  const {user} = await response.json();
  const account = {id:user.id,email,password,cookie:response.headers.get('set-cookie').split(';')[0]};
  accounts.push(account);
  return account;
};
const request = async (path, options) => {
  const response = await fetchSigned(`${origin}${path}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
};
let id;
try {
  const publicHome=await fetch(origin);
  const homepage=await publicHome.text();
  assert.equal(publicHome.status,200);
  assert.match(homepage,/让故事，/,'visitors see the original homepage');
  assert.match(homepage,/登录/);
  assert.match(homepage,/注册/);
  assert.equal((await fetch(`${origin}/api/projects/sample-summer-letter`)).status,200,'visitors can browse sample');
  assert.equal((await fetch(`${origin}/api/projects`)).status,401,'anonymous requests cannot list works');
  assert.equal((await fetch(`${origin}/api/config`)).status,401,'anonymous requests cannot inspect provider settings');
  const alice = await register();
  const bob = await register();
  activeCookie = alice.cookie;
  assert.equal((await request('/api/auth/me')).user.email,alice.email);
  const config=await request('/api/config');
  assert.equal(typeof config.speech.configured,'boolean');
  assert.equal(config.speech.id,'qwen');
  assert.equal(typeof config.speech.provider,'string');
  assert.equal(typeof config.speech.model,'string');
  assert.deepEqual(config.speech.voices,{female:'女声',male:'男声'});
  const page = await fetchSigned(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /镜头/);
  const samplePath = '/api/projects/sample-summer-letter';
  const before = await request('/api/projects');
  assert.equal(before.projects.length,1,'new accounts cannot inherit legacy or other users’ projects');
  const sample = (await request(samplePath)).project;
  assert.equal(sample.id,'sample-summer-letter');
  assert.equal(before.projects.filter(project=>project.id===sample.id).length,1,'workbench lists the sample exactly once');
  assert.deepEqual(await request('/api/projects'),before, 'browsing does not save a project');
  for (const [path,method] of [[samplePath,'PUT'],[samplePath,'DELETE'],[`${samplePath}/generate`,'POST'],[`${samplePath}/generate-scene`,'POST'],[`${samplePath}/generate-audio`,'POST']]) {
    const denied = await fetchSigned(`${origin}${path}`,{method});
    assert.equal(denied.status,403,`${method} ${path}`);
  }
  const created = await request(`${samplePath}/copy`, { method: 'POST' });
  let project = created.project; id = project.id;
  assert.notEqual(id,sample.id);
  assert.equal(project.name,'夏日来信 · 我的副本');
  assert.ok((await request('/api/projects')).projects.some(p=>p.id===id));
  assert.equal((await fetchSigned(`${origin}/?project=${id}`)).status,200);
  assert.equal(project.characters.length, 2);
  assert.equal(project.shots.length, 12);
  assert.equal(project.shots.reduce((n, s) => n + s.duration, 0), 60);
  const legacy=structuredClone(project);
  delete legacy.characters[0].voice;
  delete legacy.shots[0].speakerCharacterId;
  delete legacy.shots[0].audio;
  project=(await request(`/api/projects/${id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({project:legacy})})).project;
  assert.equal(project.characters[0].voice,'female');
  assert.equal(project.shots[0].speakerCharacterId,null);
  assert.equal(project.shots[0].audio.status,'idle');
  if (!config.speech.configured) {
    const unconfigured=await fetchSigned(`${origin}/api/projects/${id}/generate-audio`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({shotId:project.shots[1].id})});
    assert.equal(unconfigured.status,503,'unconfigured speech generation stops before provider work');
  }
  for (const url of new Set(project.shots.flatMap(s => s.candidates.map(c => c.url)).concat(project.characters.flatMap(c => c.references.map(r => r.url))))) {
    const response = await fetchSigned(`${origin}${url}`);
    assert.equal(response.status, 200, `sample image ${url}`);
    assert.match(response.headers.get('content-type'), /^image\//);
  }
  const oldSelection = project.shots[0].selectedCandidateId;
  const originalRevision = project.revision;
  project.name = 'HTTP 验收测试';
  project.characters[0].description = '验收修改角色，旧画面应保留';
  project.shots[0].duration = 8;
  project.shots[0].dialogue = '新的对白应进入预览';
  const shot = project.shots.shift(); project.shots.push(shot);
  project = (await request(`/api/projects/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project }) })).project;
  assert.ok(project.revision > originalRevision);
  const reloaded = (await request(`/api/projects/${id}`)).project;
  assert.equal(reloaded.name,'HTTP 验收测试');
  assert.equal(reloaded.shots[11].dialogue, '新的对白应进入预览');
  assert.equal(reloaded.shots[11].selectedCandidateId, oldSelection);
  assert.equal(reloaded.shots.reduce((n, s) => n + s.duration, 0), 63);
  const staleResponse = await fetchSigned(`${origin}/api/projects/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: { ...project, revision: originalRevision } }) });
  assert.equal(staleResponse.status, 409);
  const body = new FormData();
  body.set('file', new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j+V8AAAAASUVORK5CYII=', 'base64')], 'verification.png', { type: 'image/png' }));
  const uploaded = await request('/api/upload', { method: 'POST', body });
  assert.equal((await fetchSigned(`${origin}${uploaded.image.url}`)).status, 200);
  project.characters[0].references.push(uploaded.image);
  const persisted = await request(`/api/projects/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project }) });
  assert.equal(persisted.project.characters[0].references.length, 2);
  project = persisted.project;
  const sceneId = crypto.randomUUID();
  const candidateId = crypto.randomUUID();
  project.scenes = [{id:sceneId,name:'验收场景',description:'蓝色长椅与白色站棚',candidates:[{id:candidateId,url:uploaded.image.url,createdAt:new Date().toISOString(),prompt:'上传参考图',batchId:'verification',source:'uploaded'}],selectedCandidateId:candidateId,status:'idle',error:null,generationId:null,generationStartedAt:null}];
  project.shots[0].sceneId = sceneId;
  project.shots[1].sceneId = sceneId;
  project = (await request(`/api/projects/${id}`, { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({project}) })).project;
  const sceneReload = (await request(`/api/projects/${id}`)).project;
  assert.deepEqual(sceneReload.scenes,project.scenes);
  assert.equal(sceneReload.shots[0].sceneId,sceneId);
  assert.equal(sceneReload.shots[1].sceneId,sceneId);
  const library = await request('/api/library');
  assert.equal(library.characters.filter(character=>character.projectId===id).length,project.characters.length);
  const libraryScene = library.scenes.find(scene=>scene.projectId===id && scene.id===sceneId);
  assert.equal(libraryScene.projectName,project.name);
  assert.equal(libraryScene.shotCount,2);
  assert.equal(libraryScene.candidateCount,1);
  assert.equal(libraryScene.previewUrl,uploaded.image.url);
  assert.equal('candidates' in libraryScene,false);
  const bobProjects = await (await fetchAs(bob.cookie,`${origin}/api/projects`)).json();
  assert.equal(bobProjects.projects.length,1);
  assert.deepEqual(await (await fetchAs(bob.cookie,`${origin}/api/library`)).json(),{characters:[],scenes:[]});
  for (const method of ['GET','PUT','DELETE']) {
    const denied = await fetchAs(bob.cookie,`${origin}/api/projects/${id}`,{method,headers:{'content-type':'application/json'},...(method==='PUT'?{body:JSON.stringify({project})}:{})});
    assert.equal(denied.status,404,`foreign ${method} must fail`);
  }
  assert.equal((await fetchAs(bob.cookie,`${origin}${uploaded.image.url}`)).status,404);
  assert.match((await fetchSigned(`${origin}${uploaded.image.url}`)).headers.get('cache-control'),/no-store/);
  const replayCookie = activeCookie;
  await request('/api/auth/logout',{method:'POST'});
  assert.equal((await fetchAs(replayCookie,`${origin}/api/projects`)).status,401,'logout must revoke session on server');
  const login = await fetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:alice.email,password:alice.password})});
  assert.equal(login.status,200,await login.clone().text());
  activeCookie = login.headers.get('set-cookie').split(';')[0];
  alice.cookie = activeCookie;
  assert.equal((await request(`/api/projects/${id}`)).project.name,project.name,'login restores saved data');

  const invalidGenerate = await fetchSigned(`${origin}/api/projects/${id}/generate-scene`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sceneId,count:0})});
  assert.equal(invalidGenerate.status,400,'reject invalid count before paid provider work');
  const existingShots = project.shots;
  project.scenes = [];
  project.shots = project.shots.map(s=>s.sceneId===sceneId ? {...s,sceneId:null} : s);
  await request(`/api/projects/${id}`, {method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({project})});
  const afterRemoval = (await request(`/api/projects/${id}`)).project;
  assert.deepEqual(afterRemoval.scenes,[]);
  assert.equal(afterRemoval.shots[0].sceneId,null);
  assert.deepEqual(afterRemoval.shots.map(s=>s.candidates),existingShots.map(s=>s.candidates));
  assert.deepEqual(afterRemoval.shots.map(s=>s.selectedCandidateId),existingShots.map(s=>s.selectedCandidateId));
  assert.deepEqual((await request(samplePath)).project,sample,'copy edits preserve the original sample');
  console.log('HTTP smoke passed: email registration, login, session revocation, two-account project/image/library isolation, readonly sample, explicit copy, project URL, speech config privacy, legacy voice/audio defaults, demo assets, 2 characters, 12 shots / 60s, edit/save/reload, preserved selection, revision conflict, uploaded reference, global character/scene libraries, scene selection persistence, multi-shot scene links, scene deletion without losing shot images. No paid generation requested.');
} finally {
  if (id && activeCookie) await request(`/api/projects/${id}`, { method: 'DELETE' }).catch(()=>{});
  for (const account of accounts) await fetchAs(account.cookie,`${origin}/api/auth/logout`,{method:'POST'}).catch(()=>{});
  // Only clean accounts created by this invocation, in the default local server.
  if (!process.env.TEST_BASE_URL && accounts.length) {
    const {DatabaseSync} = await import('node:sqlite');
    const {findLocalDatabase} = await import('../scripts/local-owner.ts');
    const db = new DatabaseSync(findLocalDatabase());
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const account of accounts) {
        const row = db.prepare('SELECT id FROM auth_users WHERE id = ? AND email = ?').get(account.id,account.email);
        if (!row) continue;
        db.prepare('DELETE FROM projects WHERE owner = ?').run(account.id);
        db.prepare('DELETE FROM assets WHERE owner = ?').run(account.id);
        db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(account.id);
        db.prepare('DELETE FROM auth_users WHERE id = ?').run(account.id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { db.close(); }
  }
}
