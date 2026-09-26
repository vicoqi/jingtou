/* eslint-disable @typescript-eslint/no-explicit-any -- In-memory D1 fixture mirrors heterogeneous database rows and JSON responses. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest } from '../lib/server.ts';
import { createProject } from '../lib/sample.ts';
import { newScene, newShot } from '../lib/domain.ts';

class MemoryDB {
  projects = new Map<string, any>();
  assets = new Map<string, any>();
  schema = new Set<string>();
  prepare(sql: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- The nested D1 statement closure retains this fixture.
    const db = this;
    if (!sql.startsWith('CREATE') && db.schema.size !== 3) throw new Error('no such table: projects');
    return { bind(...args: any[]) {
      return {
        async first() {
          if (sql.includes('FROM projects')) return db.projects.get(args[0]) ?? null;
          if (sql.includes('FROM assets')) return db.assets.get(args[0]) ?? null;
          return null;
        },
        async all() { return { results: [...db.projects.values()].filter(x => x.owner === args[0]).sort((a,b) => b.updated_at.localeCompare(a.updated_at)) }; },
        async run() {
          if (sql.startsWith('CREATE')) { db.schema.add(sql); return {meta:{changes:0}}; }
          if (sql.startsWith('INSERT INTO projects')) { db.projects.set(args[0], {id:args[0], owner:args[1], revision:args[2], document:args[3], updated_at:args[4]}); return {meta:{changes:1}}; }
          if (sql.startsWith('UPDATE projects')) { const row = db.projects.get(args[3]); if (!row || row.owner !== args[4] || row.revision !== args[5]) return {meta:{changes:0}}; row.document=args[0]; row.revision=args[1]; row.updated_at=args[2]; return {meta:{changes:1}}; }
          if (sql.startsWith('DELETE FROM projects')) { const row = db.projects.get(args[0]); if (!row || row.owner !== args[1]) return {meta:{changes:0}}; db.projects.delete(args[0]); return {meta:{changes:1}}; }
          if (sql.startsWith('INSERT INTO assets')) { db.assets.set(args[0], {id:args[0], owner:args[1], mime:args[2], name:args[3]}); return {meta:{changes:1}}; }
          throw new Error(`Unknown SQL: ${sql}`);
        }
      };
    }};
  }
}
const db = new MemoryDB();
const objects = new Map<string, Uint8Array>();
const env: any = { DB:db, ASSETS_BUCKET:{ put:async (key:string, body:ArrayBuffer|Uint8Array) => { objects.set(key, new Uint8Array(body)); }, get:async (key:string) => objects.has(key) ? {body:new ReadableStream({start(c) { c.enqueue(objects.get(key)); c.close(); }}), arrayBuffer:async () => objects.get(key)!.buffer} : null }, OPENAI_API_KEY:'', IMAGE_MODEL:'gpt-image-2.5-flare' };
const request = (path:string, method='GET', body?:unknown, owner='a@example.com') => new Request(`https://studio.example${path}`, { method, headers:{'oai-authenticated-user-email':owner, ...(body ? {'content-type':'application/json'} : {})}, body:body ? JSON.stringify(body) : undefined });
const json = async (response: Response) => response.json() as Promise<any>;

test('API initializes missing tables and index idempotently', async () => {
  const first = await handleApiRequest(request('/api/projects'),env);
  assert.equal(first.status,200);
  const projects=(await json(first)).projects;
  assert.equal(projects.length,1);
  assert.equal(projects[0].id,'sample-summer-letter');
  assert.equal(db.schema.size,3);
  const again = await handleApiRequest(request('/api/projects'),env);
  assert.equal(again.status,200);
  assert.equal(db.schema.size,3);
});

const samplePath = '/api/projects/sample-summer-letter';

test('browsing the canonical sample is stable and does not create saved projects', async () => {
  const before = db.projects.size;
  const response = await handleApiRequest(request(samplePath),env);
  assert.equal(response.status,200);
  const sample = (await json(response)).project;
  assert.equal(sample.id,'sample-summer-letter');
  assert.equal(sample.characters.length,2);
  assert.equal(sample.shots.length,12);
  assert.equal(sample.shots.reduce((total:number,s:any)=>total+s.duration,0),60);
  const other = await handleApiRequest(request(samplePath,'GET',undefined,'b@example.com'),env);
  assert.equal(other.status,200);
  assert.deepEqual((await json(other)).project,sample);
  assert.equal(db.projects.size,before);
  const list = (await json(await handleApiRequest(request('/api/projects'),env))).projects;
  const listedSample = list.filter((p:any)=>p.id===sample.id);
  assert.equal(listedSample.length,1);
  assert.equal(listedSample[0].name,'夏日来信 · 样例');
  assert.equal(listedSample[0].shotCount,12);
  assert.equal(db.projects.size,before,'listing the sample must not persist it');
});

test('sample rejects saving, deletion and generation without touching data or provider', async () => {
  const before = structuredClone([...db.projects]);
  const assetsBefore = db.assets.size;
  let called = false;
  const options = {fetcher:async()=>{called=true;throw new Error('sample must not generate');}};
  for (const owner of ['a@example.com','b@example.com']) {
    for (const [method,path,body] of [
      ['PUT',samplePath,{project:{id:'sample-summer-letter',name:'Overwrite',readOnly:false}}],
      ['DELETE',samplePath,undefined],
      ['POST',`${samplePath}/generate`,{shotId:'sample-shot-1',count:1}],
    ] as const) {
      const response = await handleApiRequest(request(path,method,body,owner),env,options);
      assert.equal(response.status,403,`${method} ${path}`);
      assert.match((await json(response)).error,/只读.*复制/);
    }
  }
  assert.equal(called,false);
  assert.equal(db.assets.size,assetsBefore);
  assert.deepEqual([...db.projects],before);
});

test('explicit sample copies are editable and owner scoped while the original stays unchanged', async () => {
  const sample = (await json(await handleApiRequest(request(samplePath),env))).project;
  const response = await handleApiRequest(request(`${samplePath}/copy`,'POST'),env);
  assert.equal(response.status,201);
  const copy = (await json(response)).project;
  const other = (await json(await handleApiRequest(request(`${samplePath}/copy`,'POST',undefined,'b@example.com'),env))).project;
  assert.notEqual(copy.id,sample.id);
  assert.notEqual(copy.id,other.id);
  assert.equal(copy.name,'夏日来信 · 我的副本');
  assert.deepEqual(copy.characters,sample.characters);
  const withoutDates = (p:any) => p.shots.map((s:any)=>({...s,candidates:s.candidates.map(({createdAt,...c}:any)=>{ void createdAt; return c; })}));
  assert.deepEqual(withoutDates(copy),withoutDates(sample));
  copy.name = '我的改编';
  copy.characters[0].description = '新的角色设定';
  copy.shots[0].dialogue = '只修改我的副本';
  copy.shots[0].selectedCandidateId = copy.shots[0].candidates[1].id;
  const saved = await handleApiRequest(request(`/api/projects/${copy.id}`,'PUT',{project:copy}),env);
  assert.equal(saved.status,200);
  const reloaded = (await json(await handleApiRequest(request(`/api/projects/${copy.id}`),env))).project;
  assert.equal(reloaded.name,copy.name);
  assert.deepEqual(reloaded.characters,copy.characters);
  assert.deepEqual(reloaded.shots,copy.shots);
  for (const method of ['GET','PUT','DELETE']) {
    const denied = await handleApiRequest(request(`/api/projects/${copy.id}`,method,method==='PUT'?{project:reloaded}:undefined,'b@example.com'),env);
    assert.equal(denied.status,404);
  }
  assert.deepEqual((await json(await handleApiRequest(request(`/api/projects/${other.id}`,'GET',undefined,'b@example.com'),env))).project,other);
  assert.equal((await handleApiRequest(request(`/api/projects/${copy.id}`,'DELETE'),env)).status,200);
  assert.deepEqual((await json(await handleApiRequest(request(samplePath),env))).project,sample);
  const anonymous = new Request(`https://studio.example${samplePath}/copy`,{method:'POST'});
  assert.equal((await handleApiRequest(anonymous,env)).status,401);
});

test('generation configuration requires both a key and an explicit model', async () => {
  const before=(await json(await handleApiRequest(request('/api/config'),env)));
  assert.equal(before.configured,false);
  env.OPENAI_API_KEY='test-key';
  env.IMAGE_MODEL='';
  const missing=(await json(await handleApiRequest(request('/api/config'),env)));
  assert.equal(missing.configured,false);
  const p=(await json(await handleApiRequest(request('/api/projects','POST',{name:'Model required'}),env))).project;
  p.shots.push({id:'shot',title:'Shot',characterIds:[],scene:'',description:'',dialogue:'',duration:5,candidates:[],selectedCandidateId:null,status:'idle',error:null,generationId:null,generationStartedAt:null});
  await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:p}),env);
  const denied=await handleApiRequest(request(`/api/projects/${p.id}/generate`,'POST',{shotId:'shot',count:1}),env);
  assert.equal(denied.status,503);
  env.OPENAI_API_KEY='';
  env.IMAGE_MODEL='gpt-image-2.5-flare';
});

test('sample only links to shipped images and spans sixty seconds', () => {
  const sample=createProject('ignored',true);
  const urls=new Set(sample.shots.flatMap(s=>s.candidates.map(c=>c.url)));
  assert.deepEqual([...urls].sort(),['/samples/chenyu.png','/samples/linxia.png','/samples/summer.png']);
  assert.equal(sample.shots[0].candidates.length,3);
  assert.equal(sample.shots.length,12);
  assert.equal(sample.shots.reduce((total,s)=>total+s.duration,0),60);
  assert.deepEqual(sample.characters.map(c=>c.name),['林夏','陈屿']);
  assert.deepEqual(sample.characters.map(c=>c.references[0].url),['/samples/linxia.png','/samples/chenyu.png']);
});

test('sample generation reads the two shipped character references', async () => {
  env.OPENAI_API_KEY='test-key';
  const png=new Uint8Array([137,80,78,71,13,10,26,10,0]);
  const requested:string[]=[];
  env.ASSETS={fetch:async (assetRequest:Request)=>{
    requested.push(assetRequest.url);
    return new Response(png,{headers:{'content-type':'image/png'}});
  }};
  const sample=(await json(await handleApiRequest(request('/api/projects','POST',{name:'Sample',demo:true}),env))).project;
  const response=await handleApiRequest(request(`/api/projects/${sample.id}/generate`,'POST',{shotId:sample.shots[0].id,count:1}),env,{fetcher:async (_url,init)=>{
    assert.equal((init?.body as FormData).getAll('image').length,2);
    return new Response(JSON.stringify({data:[{b64_json:btoa(String.fromCharCode(...png))}]}));
  }});
  assert.equal(response.status,200);
  assert.deepEqual(requested,['https://studio.example/samples/linxia.png','https://studio.example/samples/chenyu.png']);
  env.OPENAI_API_KEY='';
  delete env.ASSETS;
});

test('generation rejects a batch that would exceed 200 candidates before calling provider', async () => {
  env.OPENAI_API_KEY='test-key';
  const p=(await json(await handleApiRequest(request('/api/projects','POST',{name:'Limit'}),env))).project;
  p.shots.push({id:'full',title:'Full',characterIds:[],scene:'',description:'',dialogue:'',duration:5,candidates:Array.from({length:199},(_,i)=>({id:`candidate-${i}`,url:'/samples/summer.png',createdAt:'',prompt:'',batchId:'',source:'sample'})),selectedCandidateId:null,status:'idle',error:null,generationId:null,generationStartedAt:null});
  const saved=(await json(await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:p}),env))).project;
  let called=false;
  const response=await handleApiRequest(request(`/api/projects/${p.id}/generate`,'POST',{shotId:'full',count:2}),env,{fetcher:async()=>{called=true;throw new Error('should not call provider');}});
  assert.equal(response.status,400);
  assert.equal(called,false);
  const after=(await json(await handleApiRequest(request(`/api/projects/${p.id}`),env))).project;
  assert.equal(after.revision,saved.revision);
  assert.equal(after.shots[0].candidates.length,199);
  env.OPENAI_API_KEY='';
});

test('project save uses revision checks and owner scope', async () => {
  const created = await json(await handleApiRequest(request('/api/projects','POST',{name:'First'}),env));
  const p = created.project;
  assert.equal(p.revision, 1);
  p.name = 'Edited';
  const saved = await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:p}),env);
  assert.equal((await json(saved)).project.revision, 2);
  assert.equal((await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:p}),env)).status, 409);
  assert.equal((await handleApiRequest(request(`/api/projects/${p.id}`,'GET',undefined,'b@example.com'),env)).status, 404);
});

test('new projects persist the requested visual style', async () => {
  const response = await handleApiRequest(request('/api/projects','POST',{name:'Live action',style:'真人电影写实摄影'}),env);
  assert.equal(response.status,201);
  assert.equal((await json(response)).project.style,'真人电影写实摄影');
  assert.equal((await handleApiRequest(request('/api/projects','POST',{name:'Blank style',style:'   '}),env)).status,400);
});

test('global resource library aggregates every owned project without leaking foreign resources', async () => {
  const owner = 'library@example.com';
  const first = (await json(await handleApiRequest(request('/api/projects','POST',{name:'海边故事'},owner),env))).project;
  first.characters = [{id:'hero',name:'林夏',description:'蓝色短发',references:[{id:'hero-ref',name:'正面',url:'/samples/linxia.png'}]}];
  first.scenes = [{...newScene('水彩绘本'),id:'station',name:'海边车站',description:'蓝色长椅',candidates:[
    {id:'old',url:'/samples/summer.png',createdAt:'',prompt:'',batchId:'',source:'sample'},
    {id:'selected',url:'/samples/chenyu.png',createdAt:'',prompt:'',batchId:'',source:'sample'},
  ],selectedCandidateId:'selected'}];
  first.shots = [{...newShot(),id:'arrival',characterIds:['hero'],sceneId:'station'}];
  assert.equal((await handleApiRequest(request(`/api/projects/${first.id}`,'PUT',{project:first},owner),env)).status,200);

  const second = (await json(await handleApiRequest(request('/api/projects','POST',{name:'城市故事'},owner),env))).project;
  second.characters = [{id:'friend',name:'陈屿',description:'棕色短发',references:[]}];
  assert.equal((await handleApiRequest(request(`/api/projects/${second.id}`,'PUT',{project:second},owner),env)).status,200);

  const foreign = (await json(await handleApiRequest(request('/api/projects','POST',{name:'别人的作品'},'foreign-library@example.com'),env))).project;
  foreign.characters = [{id:'foreign',name:'不可见角色',description:'',references:[]}];
  assert.equal((await handleApiRequest(request(`/api/projects/${foreign.id}`,'PUT',{project:foreign},'foreign-library@example.com'),env)).status,200);

  const response = await handleApiRequest(request('/api/library','GET',undefined,owner),env);
  assert.equal(response.status,200);
  const library = await json(response);
  assert.equal(library.characters.length,2);
  assert.deepEqual(library.characters.find((item:any)=>item.name==='林夏'),{
    id:'hero',name:'林夏',description:'蓝色短发',references:[{id:'hero-ref',name:'正面',url:'/samples/linxia.png'}],
    projectId:first.id,projectName:'海边故事',shotCount:1,
  });
  assert.deepEqual(library.characters.find((item:any)=>item.name==='陈屿'),{
    id:'friend',name:'陈屿',description:'棕色短发',references:[],
    projectId:second.id,projectName:'城市故事',shotCount:0,
  });
  assert.deepEqual(library.scenes.map((item:any)=>({name:item.name,project:item.projectName,shots:item.shotCount,candidates:item.candidateCount,preview:item.previewUrl,style:item.style})),[
    {name:'海边车站',project:'海边故事',shots:1,candidates:2,preview:'/samples/chenyu.png',style:'水彩绘本'},
  ]);
  assert.equal('candidates' in library.scenes[0],false);
  assert.ok(!library.characters.some((item:any)=>item.name==='不可见角色'));
});

test('invalid project documents return a client error', async () => {
  const p=(await json(await handleApiRequest(request('/api/projects','POST',{name:'Validation'}),env))).project;
  p.shots.push({id:'bad',title:'Bad',characterIds:[],scene:'',description:'',dialogue:'',duration:0,candidates:[],selectedCandidateId:null,status:'idle',error:null,generationId:null,generationStartedAt:null});
  const response=await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:p}),env);
  assert.equal(response.status,400);
});

test('upload validates magic bytes and owner gates retrieval', async () => {
  const form = new FormData();
  form.set('file', new File([new Uint8Array([137,80,78,71,13,10,26,10,0])], 'ref.png', {type:'image/png'}));
  const uploaded = await json(await handleApiRequest(new Request('https://studio.example/api/upload',{method:'POST',headers:{'oai-authenticated-user-email':'a@example.com'},body:form}),env));
  assert.match(uploaded.image.url, /^\/api\/assets\//);
  assert.equal((await handleApiRequest(request(uploaded.image.url),env)).status, 200);
  assert.equal((await handleApiRequest(request(uploaded.image.url,'GET',undefined,'b@example.com'),env)).status, 404);
  const bad = new FormData();
  bad.set('file', new File(['hello'], 'bad.png', {type:'image/png'}));
  assert.equal((await handleApiRequest(new Request('https://studio.example/api/upload',{method:'POST',headers:{'oai-authenticated-user-email':'a@example.com'},body:bad}),env)).status, 400);
  const foreign = (await json(await handleApiRequest(request('/api/projects','POST',{name:'Other'},'b@example.com'),env))).project;
  foreign.characters.push({id:'c',name:'C',description:'',references:[uploaded.image]});
  assert.equal((await handleApiRequest(request(`/api/projects/${foreign.id}`,'PUT',{project:foreign},'b@example.com'),env)).status,400);
});

test('generation failure persists retryable state without dropping selected candidate', async () => {
  env.OPENAI_API_KEY = 'test-key';
  const refForm = new FormData();
  refForm.set('file', new File([new Uint8Array([137,80,78,71,13,10,26,10,0])], 'ref.png', {type:'image/png'}));
  const ref = (await json(await handleApiRequest(new Request('https://studio.example/api/upload',{method:'POST',headers:{'oai-authenticated-user-email':'a@example.com'},body:refForm}),env))).image;
  const p = (await json(await handleApiRequest(request('/api/projects','POST',{name:'Generate'}),env))).project;
  p.characters.push({id:'c',name:'C',description:'desc',references:[ref]});
  p.shots.push({id:'s',title:'S',characterIds:['c'],scene:'',description:'',dialogue:'',duration:5,candidates:[{id:'old',url:'/samples/summer.png',createdAt:'',prompt:'',batchId:'',source:'sample'}],selectedCandidateId:'old',status:'idle',error:null,generationId:null,generationStartedAt:null});
  const saved = (await json(await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:p}),env))).project;
  const response = await handleApiRequest(request(`/api/projects/${p.id}/generate`,'POST',{shotId:'s',count:1}),env,{fetcher:async()=>new Response('upstream failed',{status:503})});
  assert.equal(response.status, 502);
  const after = (await json(await handleApiRequest(request(`/api/projects/${p.id}`),env))).project;
  assert.equal(after.shots[0].selectedCandidateId, 'old');
  assert.equal(after.shots[0].status, 'failed');
  assert.match(after.shots[0].error, /503/);
  assert.equal(after.revision, saved.revision + 2);
  const png = new Uint8Array([137,80,78,71,13,10,26,10,0]);
  const retried = await handleApiRequest(request(`/api/projects/${p.id}/generate`,'POST',{shotId:'s',count:1}),env,{fetcher:async()=>new Response(JSON.stringify({data:[{b64_json:btoa(String.fromCharCode(...png))}]}))});
  assert.equal(retried.status,200);
  const finished = (await json(retried)).project;
  assert.equal(finished.shots[0].status,'idle');
  assert.equal(finished.shots[0].selectedCandidateId,'old');
  assert.deepEqual(finished.shots[0].candidates.map((c:any)=>c.id).slice(0,1),['old']);
  assert.equal(finished.shots[0].candidates.length,2);
  env.OPENAI_API_KEY = '';
});

test('generation merges into the latest revision after another shot is edited', async () => {
  env.OPENAI_API_KEY = 'test-key';
  const png = new Uint8Array([137,80,78,71,13,10,26,10,0]);
  const form = new FormData();
  form.set('file', new File([png], 'reference.png', {type:'image/png'}));
  const ref = (await json(await handleApiRequest(new Request('https://studio.example/api/upload',{method:'POST',headers:{'oai-authenticated-user-email':'a@example.com'},body:form}),env))).image;
  const p = (await json(await handleApiRequest(request('/api/projects','POST',{name:'Concurrent'}),env))).project;
  p.characters.push({id:'c',name:'Lin',description:'blue hair',references:[ref]});
  const baseShot = (id:string) => ({id,title:id,characterIds:id==='a'?['c']:[],scene:'',description:'',dialogue:'',duration:5,candidates:[],selectedCandidateId:null,status:'idle',error:null,generationId:null,generationStartedAt:null});
  p.shots.push(baseShot('a'),baseShot('b'));
  await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:p}),env);
  let release!: () => void;
  let background: Promise<unknown> | undefined;
  const gate = new Promise<void>(resolve => { release=resolve; });
  const generation = handleApiRequest(request(`/api/projects/${p.id}/generate`,'POST',{shotId:'a',count:1}),env,{fetcher:async()=>{
    await gate;
    return new Response(JSON.stringify({data:[{b64_json:btoa(String.fromCharCode(...png))}]}),{headers:{'content-type':'application/json'}});
  },waitUntil:promise=>{ background=promise; }});
  await new Promise(resolve => setTimeout(resolve,10));
  assert.ok(background,'generation must be registered as background work before the provider finishes');
  const during = (await json(await handleApiRequest(request(`/api/projects/${p.id}`),env))).project;
  assert.equal(during.shots[0].status,'generating');
  during.shots[1].description = 'edit during generation';
  const saved = await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:during}),env);
  assert.equal(saved.status,200);
  release();
  const result = await generation;
  await background;
  assert.equal(result.status,200);
  const final = (await json(result)).project;
  assert.equal(final.shots[1].description,'edit during generation');
  assert.equal(final.shots[0].candidates.length,1);
  assert.equal(final.shots[0].selectedCandidateId,null);
  assert.equal(final.shots[0].status,'idle');
  env.OPENAI_API_KEY = '';
});

test('stale generating state becomes retryable on reload', async () => {
  const p = (await json(await handleApiRequest(request('/api/projects','POST',{name:'Stale'}),env))).project;
  p.shots.push({id:'s',title:'S',characterIds:[],scene:'',description:'',dialogue:'',duration:5,candidates:[],selectedCandidateId:null,status:'idle',error:null,generationId:null,generationStartedAt:null});
  const saved = (await json(await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:p}),env))).project;
  saved.shots[0].status='generating';
  saved.shots[0].generationId='lost-job';
  saved.shots[0].generationStartedAt='2020-01-01T00:00:00.000Z';
  db.projects.get(p.id).document=JSON.stringify(saved);
  const reloaded=(await json(await handleApiRequest(request(`/api/projects/${p.id}`),env))).project;
  assert.equal(reloaded.shots[0].status,'failed');
  assert.match(reloaded.shots[0].error,/重试/);
  assert.equal(reloaded.revision,saved.revision+1);
});

test('a shot without associated characters uses text-only generation', async () => {
  env.OPENAI_API_KEY='test-key';
  const p=(await json(await handleApiRequest(request('/api/projects','POST',{name:'Scenery'}),env))).project;
  p.shots.push({id:'landscape',title:'海岸',characterIds:[],scene:'海边',description:'日落',dialogue:'',duration:5,candidates:[],selectedCandidateId:null,status:'idle',error:null,generationId:null,generationStartedAt:null});
  await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:p}),env);
  const png=new Uint8Array([137,80,78,71,13,10,26,10,0]);
  const response=await handleApiRequest(request(`/api/projects/${p.id}/generate`,'POST',{shotId:'landscape',count:1}),env,{fetcher:async url=>{
    assert.match(String(url),/\/images\/generations$/);
    return new Response(JSON.stringify({data:[{b64_json:btoa(String.fromCharCode(...png))}]}));
  }});
  assert.equal(response.status,200);
  env.OPENAI_API_KEY='';
});

test('explicit LAN mode shares the existing local workspace and keeps samples readonly', async () => {
  const localEnv = {...env,JINGTOU_LOCAL_WORKSPACE:'1'};
  const createLocal = new Request('http://localhost:3000/api/projects', {
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'LAN shared project'}),
  });
  const created = (await json(await handleApiRequest(createLocal,env))).project;
  const url = `http://192.168.1.112:3000/api/projects/${created.id}`;
  const response = await handleApiRequest(new Request(url),localEnv);
  assert.equal(response.status,200);
  const project = (await json(response)).project;
  assert.deepEqual(project,created);
  project.name = 'Edited from LAN';
  const saved = await handleApiRequest(new Request(url,{
    method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({project}),
  }),localEnv);
  assert.equal(saved.status,200);
  const local = await handleApiRequest(new Request(`http://localhost:3000/api/projects/${created.id}`),env);
  assert.equal((await json(local)).project.name,'Edited from LAN');
  // A forwarded identity cannot switch workspaces when sharing is explicitly enabled.
  const list = await handleApiRequest(new Request('http://192.168.1.112:3000/api/projects',{
    headers:{'oai-authenticated-user-email':'someone@example.com'},
  }),localEnv);
  assert.ok((await json(list)).projects.some((p:any)=>p.id===created.id));
  assert.equal((await handleApiRequest(new Request(`http://192.168.1.112:3000${samplePath}`),localEnv)).status,200);
  assert.equal((await handleApiRequest(new Request(`http://192.168.1.112:3000${samplePath}`,{method:'DELETE'}),localEnv)).status,403);
  assert.equal((await handleApiRequest(request(`/api/projects/${created.id}`),env)).status,404);
  assert.equal((await handleApiRequest(new Request(url,{method:'DELETE'}),localEnv)).status,200);
});

test('private addresses and client flags do not bypass identity checks outside LAN mode', async () => {
  for (const origin of ['http://192.168.1.112:3000','http://10.0.0.2:3000','https://studio.example']) {
    const response = await handleApiRequest(new Request(`${origin}/api/projects?JINGTOU_LOCAL_WORKSPACE=1`,{
      headers:{'JINGTOU_LOCAL_WORKSPACE':'1','x-forwarded-host':'localhost'},
    }),env);
    assert.equal(response.status,401,origin);
  }
});

const scenePng = new Uint8Array([137,80,78,71,13,10,26,10,1]);
const sceneOutput = () => new Response(JSON.stringify({data:[{b64_json:btoa(String.fromCharCode(...scenePng))}]}));
const sceneEnv = () => ({...env,OPENAI_API_KEY:'test-key'});
async function sceneProject() {
  const p = (await json(await handleApiRequest(request('/api/projects','POST',{name:'场景制作',style:'电影写实摄影'}),env))).project;
  p.scenes = [{...newScene(),name:'海边车站',description:'蓝色长椅，白色站棚'}];
  p.shots.push(newShot());
  const saved = await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:p}),env);
  assert.equal(saved.status,200);
  return (await json(saved)).project;
}

test('old project documents gain an empty scene library on reload', async () => {
  const p = await sceneProject();
  delete p.scenes;
  db.projects.get(p.id).document = JSON.stringify(p);
  const reloaded = (await json(await handleApiRequest(request(`/api/projects/${p.id}`),env))).project;
  assert.deepEqual(reloaded.scenes,[]);
});

test('scene generation saves real image bytes and preserves selected history through failure and retry', async () => {
  const p = await sceneProject();
  const url = `/api/projects/${p.id}/generate-scene`;
  const input = {sceneId:p.scenes[0].id,count:1};
  const result = await handleApiRequest(request(url,'POST',input),sceneEnv(),{fetcher:async (url,init) => {
    assert.match(String(url),/\/images\/generations$/);
    const body = JSON.parse(String(init?.body));
    assert.match(body.prompt,/电影写实摄影/);
    assert.match(body.prompt,/No people/i);
    assert.match(body.prompt,/蓝色长椅/);
    return sceneOutput();
  }});
  assert.equal(result.status,200);
  const generated = (await json(result)).project;
  assert.deepEqual(generated.shots,p.shots);
  assert.equal(generated.scenes[0].candidates.length,1);
  assert.equal(generated.scenes[0].selectedCandidateId,null);
  const candidate = generated.scenes[0].candidates[0];
  const image = await handleApiRequest(request(candidate.url),env);
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()),scenePng);
  generated.scenes[0].selectedCandidateId = candidate.id;
  assert.equal((await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:generated}),env)).status,200);
  assert.equal((await handleApiRequest(request(url,'POST',input),sceneEnv(),{fetcher:async()=>new Response('failure',{status:503})})).status,502);
  const failed = (await json(await handleApiRequest(request(`/api/projects/${p.id}`),env))).project;
  assert.equal(failed.scenes[0].status,'failed');
  assert.match(failed.scenes[0].error,/503/);
  assert.equal(failed.scenes[0].selectedCandidateId,candidate.id);
  assert.deepEqual(failed.scenes[0].candidates,[candidate]);
  const retry = await handleApiRequest(request(url,'POST',input),sceneEnv(),{fetcher:async()=>sceneOutput()});
  assert.equal(retry.status,200);
  const finished = (await json(retry)).project;
  assert.equal(finished.scenes[0].status,'idle');
  assert.equal(finished.scenes[0].selectedCandidateId,candidate.id);
  assert.equal(finished.scenes[0].candidates.length,2);
  const reloaded = (await json(await handleApiRequest(request(`/api/projects/${p.id}`),env))).project;
  assert.deepEqual(reloaded,finished);
});

test('shot generation sends selected scene bytes after character images', async () => {
  const p = await sceneProject();
  const form = new FormData();
  const characterPng = new Uint8Array([137,80,78,71,13,10,26,10,2]);
  form.set('file',new File([characterPng],'character.png',{type:'image/png'}));
  const ref = (await json(await handleApiRequest(new Request('https://studio.example/api/upload',{method:'POST',headers:{'oai-authenticated-user-email':'a@example.com'},body:form}),env))).image;
  p.characters = [{id:'c',name:'角色',description:'短发',references:[ref]}];
  p.shots[0].sceneId = p.scenes[0].id;
  p.shots[0].characterIds = ['c'];
  await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:p}),env);
  const generated = (await json(await handleApiRequest(request(`/api/projects/${p.id}/generate-scene`,'POST',{sceneId:p.scenes[0].id,count:1}),sceneEnv(),{fetcher:async()=>sceneOutput()}))).project;
  assert.ok(generated,'scene generation must succeed');
  generated.scenes[0].selectedCandidateId = generated.scenes[0].candidates[0].id;
  await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:generated}),env);
  let calls = 0;
  const response = await handleApiRequest(request(`/api/projects/${p.id}/generate`,'POST',{shotId:p.shots[0].id,count:1}),sceneEnv(),{fetcher:async (url,init)=>{
    calls++;
    assert.match(String(url),/\/images\/edits$/);
    const form = init?.body as FormData;
    const refs = form.getAll('image') as File[];
    assert.equal(refs.length,2);
    assert.deepEqual(new Uint8Array(await refs[0].arrayBuffer()),characterPng);
    assert.deepEqual(new Uint8Array(await refs[1].arrayBuffer()),scenePng);
    assert.match(String(form.get('prompt')),/海边车站.*reference image 2/);
    return sceneOutput();
  }});
  assert.equal(response.status,200);
  assert.equal(calls,1);
});

test('unselected linked scenes block shot generation before contacting provider', async () => {
  const p = await sceneProject();
  p.shots[0].sceneId = p.scenes[0].id;
  await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:p}),env);
  let called = false;
  const result = await handleApiRequest(request(`/api/projects/${p.id}/generate`,'POST',{shotId:p.shots[0].id,count:1}),sceneEnv(),{fetcher:async()=>{called=true;return sceneOutput();}});
  assert.equal(result.status,400);
  assert.match((await json(result)).error,/场景.*选定/);
  assert.equal(called,false);
});

test('scene generation is background work and merges without losing concurrent edits or selection', async () => {
  const p = await sceneProject();
  p.scenes[0].candidates = ['first','second'].map(id=>({id,url:'/samples/summer.png',createdAt:'',prompt:'',batchId:'',source:'sample'}));
  p.scenes[0].selectedCandidateId = 'first';
  assert.equal((await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:p}),env)).status,200);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve=>{release=resolve;});
  const registered = new Promise<void>(resolve=>{started=resolve;});
  let background: Promise<unknown> | undefined;
  const pending = handleApiRequest(request(`/api/projects/${p.id}/generate-scene`,'POST',{sceneId:p.scenes[0].id,count:1}),sceneEnv(),{
    fetcher:async()=>{await gate;return sceneOutput();},
    waitUntil:promise=>{background=promise;started();},
  });
  // A missing endpoint must fail promptly, rather than hang the test waiting for registration.
  await Promise.race([registered,pending]);
  assert.ok(background);
  try {
    const during = (await json(await handleApiRequest(request(`/api/projects/${p.id}`),env))).project;
    assert.equal(during.scenes[0].status,'generating');
    assert.equal((await handleApiRequest(request(`/api/projects/${p.id}/generate-scene`,'POST',{sceneId:p.scenes[0].id,count:1}),sceneEnv())).status,409);
    during.shots[0].dialogue = '生成时修改的对白';
    during.scenes[0].description = '生成时修改的场景设定';
    during.scenes[0].selectedCandidateId = 'second';
    during.scenes[0].status = 'idle';
    const saved = (await json(await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:during}),env))).project;
    assert.equal(saved.scenes[0].status,'generating');
  } finally { release(); }
  const response = await pending;
  await background;
  assert.equal(response.status,200);
  const final = (await json(response)).project;
  assert.equal(final.shots[0].dialogue,'生成时修改的对白');
  assert.equal(final.scenes[0].description,'生成时修改的场景设定');
  assert.equal(final.scenes[0].candidates.length,3);
  assert.equal(final.scenes[0].selectedCandidateId,'second');
  assert.equal(final.scenes[0].status,'idle');
});

test('stale scene generation recovers and readonly sample rejects scene generation', async () => {
  const p = await sceneProject();
  p.scenes[0].status = 'generating';
  p.scenes[0].generationId = 'lost';
  p.scenes[0].generationStartedAt = '2020-01-01T00:00:00.000Z';
  db.projects.get(p.id).document = JSON.stringify(p);
  const recovered = (await json(await handleApiRequest(request(`/api/projects/${p.id}`),env))).project;
  assert.equal(recovered.scenes[0].status,'failed');
  assert.equal(recovered.scenes[0].generationId,null);
  assert.match(recovered.scenes[0].error,/重试/);
  assert.equal((await handleApiRequest(request(`${samplePath}/generate-scene`,'POST',{sceneId:'any',count:1}),sceneEnv())).status,403);
});

test('scene candidates enforce ownership and reject over-limit generation', async () => {
  const p = await sceneProject();
  p.scenes[0].candidates = [{id:'unowned',url:'/api/assets/00000000-0000-0000-0000-000000000000',createdAt:'',prompt:'',batchId:'',source:'uploaded'}];
  assert.equal((await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:p}),env)).status,400);
  p.scenes[0].candidates = Array.from({length:199},(_,i)=>({id:`c${i}`,url:'/samples/summer.png',createdAt:'',prompt:'',batchId:'',source:'sample'}));
  assert.equal((await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:p}),env)).status,200);
  let called=false;
  assert.equal((await handleApiRequest(request(`/api/projects/${p.id}/generate-scene`,'POST',{sceneId:p.scenes[0].id,count:2}),sceneEnv(),{fetcher:async()=>{called=true;return sceneOutput();}})).status,400);
  assert.equal(called,false);
  assert.equal((await handleApiRequest(request(`/api/projects/${p.id}/generate-scene`,'POST',{sceneId:p.scenes[0].id,count:1},'b@example.com'),sceneEnv())).status,404);
});

test('scene generation validates description and count and honors missing provider configuration', async () => {
  const p = await sceneProject();
  const url = `/api/projects/${p.id}/generate-scene`;
  const noConfig = {...sceneEnv(),IMAGE_API_KEY:'',OPENAI_API_KEY:''};
  assert.equal((await handleApiRequest(request(url,'POST',{sceneId:p.scenes[0].id,count:1}),noConfig)).status,503);
  for (const count of [0,5,1.5,'1']) {
    assert.equal((await handleApiRequest(request(url,'POST',{sceneId:p.scenes[0].id,count}),sceneEnv())).status,400);
  }
  p.scenes[0].description = '  ';
  await handleApiRequest(request(`/api/projects/${p.id}`,'PUT',{project:p}),env);
  let called = false;
  const result = await handleApiRequest(request(url,'POST',{sceneId:p.scenes[0].id,count:1}),sceneEnv(),{fetcher:async()=>{called=true;return sceneOutput();}});
  assert.equal(result.status,400);
  assert.match((await json(result)).error,/场景描述/);
  assert.equal(called,false);
});
