import { buildScenePrompt, buildShotPrompt, shotReferenceUrls, detectImageMime, requestImageEdits, requestImageGeneration, type ReferenceBytes } from './generation.ts';
import { mergeGeneration, summarizeProject, validateProject } from './domain.ts';
import { createProject, createSamplePreview } from './sample.ts';
import { SAMPLE_PROJECT_ID } from './project-access.ts';
import { authSchemaStatements, handleAuth, requireUser } from './auth.ts';
import { ApiError, bodyJson, checkRequestOrigin, fail, json } from './http.ts';
import type { Candidate, GeneratedFrame, GenerationKind, Project, ResourceLibrary } from './types.ts';

type Statement = { bind(...args: unknown[]): { first<T>(): Promise<T | null>; all<T>(): Promise<{results:T[]}>; run(): Promise<{meta:{changes:number}}> } };
type D1 = { prepare(sql: string): Statement };
type Bucket = { put(key:string, body:Uint8Array, options?:unknown):Promise<unknown>; get(key:string):Promise<{body:ReadableStream; arrayBuffer():Promise<ArrayBuffer>} | null> };
export type ApiEnv = { DB:D1; ASSETS_BUCKET:Bucket; ASSETS?:{fetch(request:Request):Promise<Response>}; OPENAI_API_KEY?:string; IMAGE_API_KEY?:string; IMAGE_API_BASE_URL?:string; IMAGE_MODEL?:string };
type ProjectRow = { id:string; owner:string; revision:number; document:string; updated_at:string };
type AssetRow = { id:string; owner:string; mime:string; name:string };
const uuidPath = /^\/api\/assets\/([a-f0-9-]{36})$/;
const projectPath = /^\/api\/projects\/([a-f0-9-]{36})$/;
const generationPath = /^\/api\/projects\/([a-f0-9-]{36})\/(generate|generate-scene)$/;
const staleAfter = 10 * 60 * 1000;
const schemaStatements = [
  'CREATE TABLE IF NOT EXISTS assets (id text PRIMARY KEY NOT NULL, owner text NOT NULL, mime text NOT NULL, name text NOT NULL)',
  'CREATE TABLE IF NOT EXISTS projects (id text PRIMARY KEY NOT NULL, owner text NOT NULL, revision integer NOT NULL, document text NOT NULL, updated_at text NOT NULL)',
  'CREATE INDEX IF NOT EXISTS projects_owner_updated_idx ON projects (owner, updated_at)',
  ...authSchemaStatements,
];

async function ensureSchema(env: ApiEnv): Promise<void> {
  for (const sql of schemaStatements) await env.DB.prepare(sql).bind().run();
}

async function rowFor(env:ApiEnv,id:string,owner:string):Promise<ProjectRow> {
  const row = await env.DB.prepare('SELECT id, owner, revision, document, updated_at FROM projects WHERE id = ? AND owner = ?').bind(id,owner).first<ProjectRow>();
  if (!row || row.owner !== owner) fail(404,'Project not found');
  return row;
}
const readProject = (row:ProjectRow):Project => {
  const project = JSON.parse(row.document) as Project;
  return { ...project, scenes: project.scenes ?? [] };
};

async function saveCas(env:ApiEnv,project:Project,owner:string,expectedRevision:number):Promise<Project | null> {
  const next = {...project, revision:expectedRevision+1, updatedAt:new Date().toISOString()};
  const result = await env.DB.prepare('UPDATE projects SET document = ?, revision = ?, updated_at = ? WHERE id = ? AND owner = ? AND revision = ?').bind(JSON.stringify(next),next.revision,next.updatedAt,next.id,owner,expectedRevision).run();
  return result.meta.changes ? next : null;
}

function recoverStale(project:Project):Project | null {
  let changed = false;
  const recover = <T extends GeneratedFrame>(s: T): T => {
    if (s.status !== 'generating' || !s.generationStartedAt || Date.now() - Date.parse(s.generationStartedAt) <= staleAfter) return s;
    changed = true;
    return {...s,status:'failed' as const,error:'生成已中断，请重试。',generationId:null,generationStartedAt:null};
  };
  const shots = project.shots.map(recover);
  const scenes = (project.scenes ?? []).map(recover);
  return changed ? {...project, shots, scenes} : null;
}
async function loadRecovered(env:ApiEnv,id:string,owner:string):Promise<Project> {
  for (let attempt=0;attempt<5;attempt++) {
    const current=readProject(await rowFor(env,id,owner));
    const recovered=recoverStale(current);
    if (!recovered) return current;
    const saved=await saveCas(env,recovered,owner,current.revision);
    if (saved) return saved;
  }
  fail(409,'Project changed; reload and retry');
}

async function validateOwnedAssets(env:ApiEnv,project:Project,owner:string):Promise<void> {
  const urls = new Set<string>();
  for (const c of project.characters) for (const r of c.references) urls.add(r.url);
  for (const s of project.shots) for (const c of s.candidates) urls.add(c.url);
  for (const s of project.scenes ?? []) for (const c of s.candidates) urls.add(c.url);
  for (const url of urls) {
    const match=url.match(uuidPath);
    if (!match) continue;
    const asset=await env.DB.prepare('SELECT id, owner, mime, name FROM assets WHERE id = ? AND owner = ?').bind(match[1],owner).first<AssetRow>();
    if (!asset || asset.owner !== owner) fail(400,'Project uses an image you do not own');
  }
}

async function getReference(env:ApiEnv,url:string,owner:string,requestUrl:string):Promise<ReferenceBytes> {
  const match=url.match(uuidPath);
  if (match) {
    const asset=await env.DB.prepare('SELECT id, owner, mime, name FROM assets WHERE id = ? AND owner = ?').bind(match[1],owner).first<AssetRow>();
    if (!asset || asset.owner !== owner) fail(400,'Reference image not found');
    const object=await env.ASSETS_BUCKET.get(match[1]);
    if (!object) fail(400,'Reference image file is missing');
    const bytes=new Uint8Array(await object.arrayBuffer());
    if (detectImageMime(bytes) !== asset.mime) fail(400,'Reference image file is invalid');
    return {bytes,mime:asset.mime as ReferenceBytes['mime'],name:asset.name};
  }
  if (/^\/samples\/(?:summer|linxia|chenyu)\.png$/.test(url) && env.ASSETS) {
    const response=await env.ASSETS.fetch(new Request(new URL(url,requestUrl)));
    if (!response.ok) fail(400,'Sample reference image is missing');
    const bytes=new Uint8Array(await response.arrayBuffer());
    const mime=detectImageMime(bytes);
    if (!mime) fail(400,'Sample reference image is invalid');
    return {bytes,mime,name:url.split('/').at(-1)!};
  }
  fail(400,'Reference image must be an uploaded image');
}

async function generationResult(env:ApiEnv,owner:string,id:string,shotId:string,generationId:string,candidates:Candidate[],kind:GenerationKind,error?:string):Promise<Project> {
  for (let attempt=0;attempt<12;attempt++) {
    const current=readProject(await rowFor(env,id,owner));
    const items=current[kind] ?? [];
    const target=items.find(s=>s.id===shotId);
    if (!target || target.generationId!==generationId || target.status!=='generating') fail(409,'Generation was superseded');
    const merged=error ? {...current,[kind]:items.map(s=>s.id===shotId ? {...s,status:'failed' as const,error,generationId:null,generationStartedAt:null}:s)} : mergeGeneration(current,shotId,generationId,candidates,kind);
    const saved=await saveCas(env,merged,owner,current.revision);
    if (saved) return saved;
  }
  fail(409,'Project changed repeatedly; reload and retry');
}

async function handleGenerate(request:Request,env:ApiEnv,owner:string,id:string,kind:GenerationKind,fetcher?:typeof fetch,waitUntil?:(promise:Promise<unknown>)=>void):Promise<Response> {
  const body=await bodyJson(request);
  const count=body.count;
  const targetId = kind === 'scenes' ? body.sceneId : body.shotId;
  if (typeof targetId!=='string' || typeof count!=='number' || !Number.isInteger(count) || count<1 || count>4) fail(400,'请选择镜头或场景，并生成 1–4 张图片。');
  const key=env.IMAGE_API_KEY || env.OPENAI_API_KEY;
  const model=env.IMAGE_MODEL?.trim();
  if (!key || !model) fail(503,'请配置图片生成密钥和模型');
  const current=await loadRecovered(env,id,owner);
  const items = current[kind] ?? [];
  const target = items.find(s=>s.id===targetId);
  if (!target) fail(404,'镜头或场景不存在。');
  if (target.status==='generating') fail(409,'正在生成，请稍候。');
  if (target.candidates.length + count > 200) fail(400,'最多保留 200 张候选图。');
  let prompt: string;
  let imageUrls: string[];
  try {
    prompt = 'name' in target ? buildScenePrompt(current,target) : buildShotPrompt(current,target);
    imageUrls = 'name' in target ? [] : shotReferenceUrls(current,target);
  } catch (error) { fail(400,error instanceof Error ? error.message : '生成设定无效。'); }
  const images=await Promise.all(imageUrls.map(url=>getReference(env,url,owner,request.url)));
  const generationId=crypto.randomUUID();
  const started={...current,[kind]:items.map(s=>s.id===target.id ? {...s,status:'generating' as const,error:null,generationId,generationStartedAt:new Date().toISOString()}:s)};
  const startedSaved=await saveCas(env,started,owner,current.revision);
  if (!startedSaved) fail(409,'Project changed; reload and retry');
  const generation = (async ():Promise<Project> => {
    try {
    const providerOptions={key,model,baseUrl:env.IMAGE_API_BASE_URL || 'https://api.openai.com/v1',prompt,count,aspectRatio:current.aspectRatio,fetcher};
    const output=images.length ? await requestImageEdits({...providerOptions,images}) : await requestImageGeneration(providerOptions);
    const now=new Date().toISOString();
    const candidates:Candidate[]=[];
    for (const result of output) {
      const assetId=crypto.randomUUID();
      await env.ASSETS_BUCKET.put(assetId,result.bytes,{httpMetadata:{contentType:result.mime}});
      await env.DB.prepare('INSERT INTO assets (id, owner, mime, name) VALUES (?, ?, ?, ?)').bind(assetId,owner,result.mime,`${'name' in target ? target.name : target.title}.${result.mime.split('/')[1]}`).run();
      candidates.push({id:crypto.randomUUID(),url:`/api/assets/${assetId}`,createdAt:now,prompt,batchId:generationId,source:'generated'});
    }
      return await generationResult(env,owner,id,target.id,generationId,candidates,kind);
    } catch (error) {
      const message=error instanceof Error ? error.message : 'Image generation failed';
      await generationResult(env,owner,id,target.id,generationId,[],kind,message).catch(()=>{});
      throw error instanceof Error ? error : new Error(message);
    }
  })();
  // Keep provider work alive if the browser refreshes or closes this request.
  waitUntil?.(generation.then(()=>undefined,()=>undefined));
  try {
    return json({project:await generation});
  } catch (error) {
    fail(502,error instanceof Error ? error.message : 'Image generation failed');
  }
}

export async function handleApiRequest(request:Request,env:ApiEnv,options:{fetcher?:typeof fetch;waitUntil?:(promise:Promise<unknown>)=>void}={}):Promise<Response> {
  try {
    checkRequestOrigin(request);
    const path=new URL(request.url).pathname;
    await ensureSchema(env);
    if (path.startsWith('/api/auth/')) return await handleAuth(request,env);
    const samplePath = `/api/projects/${SAMPLE_PROJECT_ID}`;
    if (path === samplePath && request.method === 'GET') return json({project:createSamplePreview()});
    const owner=(await requireUser(request,env)).id;
    if (path==='/api/config' && request.method==='GET') return json({configured:!!((env.IMAGE_API_KEY || env.OPENAI_API_KEY) && env.IMAGE_MODEL?.trim()),model:env.IMAGE_MODEL?.trim() || ''});
    if ((path === samplePath && request.method !== 'GET') || path === `${samplePath}/generate` || path === `${samplePath}/generate-scene`) {
      fail(403,'样例为只读，请先复制为我的作品。');
    }
    if (path === `${samplePath}/copy` && request.method === 'POST') {
      const project = {...createProject('夏日来信',true),name:'夏日来信 · 我的副本'};
      await env.DB.prepare('INSERT INTO projects (id, owner, revision, document, updated_at) VALUES (?, ?, ?, ?, ?)').bind(project.id,owner,project.revision,JSON.stringify(project),project.updatedAt).run();
      return json({project},201);
    }
    if (path==='/api/projects' && request.method==='GET') {
      const rows=(await env.DB.prepare('SELECT id, owner, revision, document, updated_at FROM projects WHERE owner = ? ORDER BY updated_at DESC').bind(owner).all<ProjectRow>()).results;
      return json({projects:[summarizeProject(createSamplePreview()),...rows.map(row=>summarizeProject(readProject(row)))]});
    }
    if (path==='/api/library' && request.method==='GET') {
      const rows=(await env.DB.prepare('SELECT id, owner, revision, document, updated_at FROM projects WHERE owner = ? ORDER BY updated_at DESC').bind(owner).all<ProjectRow>()).results;
      const library:ResourceLibrary={characters:[],scenes:[]};
      for (const row of rows) {
        const project=readProject(row);
        library.characters.push(...project.characters.map(character=>({
          ...character,
          projectId:project.id,
          projectName:project.name,
          shotCount:project.shots.filter(shot=>shot.characterIds.includes(character.id)).length,
        })));
        library.scenes.push(...(project.scenes ?? []).map(scene=>({
          id:scene.id,
          name:scene.name,
          description:scene.description,
          style:scene.style,
          status:scene.status,
          projectId:project.id,
          projectName:project.name,
          shotCount:project.shots.filter(shot=>shot.sceneId===scene.id).length,
          candidateCount:scene.candidates.length,
          previewUrl:scene.candidates.find(candidate=>candidate.id===scene.selectedCandidateId)?.url ?? scene.candidates.at(-1)?.url ?? null,
        })));
      }
      return json(library);
    }
    if (path==='/api/projects' && request.method==='POST') {
      const body=await bodyJson(request);
      if (!body || typeof body.name!=='string' || !body.name.trim() || body.name.length>120 || (body.demo!==undefined && typeof body.demo!=='boolean')) fail(400,'Enter a project name');
      if (body.style!==undefined && (typeof body.style!=='string' || !body.style.trim() || body.style.length>500)) fail(400,'Enter a visual style');
      const project=createProject(body.name,body.demo===true,typeof body.style==='string' ? body.style : undefined);
      await env.DB.prepare('INSERT INTO projects (id, owner, revision, document, updated_at) VALUES (?, ?, ?, ?, ?)').bind(project.id,owner,project.revision,JSON.stringify(project),project.updatedAt).run();
      return json({project},201);
    }
    const assetMatch=path.match(uuidPath);
    if (assetMatch && request.method==='GET') {
      const asset=await env.DB.prepare('SELECT id, owner, mime, name FROM assets WHERE id = ? AND owner = ?').bind(assetMatch[1],owner).first<AssetRow>();
      if (!asset || asset.owner!==owner) fail(404,'Image not found');
      const object=await env.ASSETS_BUCKET.get(asset.id);
      if (!object) fail(404,'Image file not found');
      return new Response(object.body,{headers:{'content-type':asset.mime,'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
    }
    if (path==='/api/upload' && request.method==='POST') {
      if (Number(request.headers.get('content-length') || 0)>10*1024*1024+10000) fail(413,'Image is too large');
      const form=await request.formData();
      const file=form.get('file');
      if (!(file instanceof File) || file.size<8 || file.size>10*1024*1024 || !['image/png','image/jpeg','image/webp'].includes(file.type)) fail(400,'Upload a PNG, JPEG, or WebP image under 10 MiB');
      const bytes=new Uint8Array(await file.arrayBuffer());
      if (detectImageMime(bytes)!==file.type) fail(400,'Image file does not match its type');
      const id=crypto.randomUUID();
      await env.ASSETS_BUCKET.put(id,bytes,{httpMetadata:{contentType:file.type}});
      await env.DB.prepare('INSERT INTO assets (id, owner, mime, name) VALUES (?, ?, ?, ?)').bind(id,owner,file.type,file.name.slice(0,200)).run();
      return json({image:{id,url:`/api/assets/${id}`,name:file.name.slice(0,200)}},201);
    }
    const generateMatch=path.match(generationPath);
    if (generateMatch && request.method==='POST') return await handleGenerate(request,env,owner,generateMatch[1],generateMatch[2]==='generate-scene'?'scenes':'shots',options.fetcher,options.waitUntil);
    const match=path.match(projectPath);
    if (match && request.method==='GET') return json({project:await loadRecovered(env,match[1],owner)});
    if (match && request.method==='PUT') {
      const current=await loadRecovered(env,match[1],owner);
      const body=await bodyJson(request);
      const proposed=body?.project;
      try { validateProject(proposed); } catch (error) { fail(400,error instanceof Error ? error.message : 'Invalid project'); }
      if (proposed.id!==match[1] || proposed.revision!==current.revision) fail(409,'Project changed; reload and retry');
      await validateOwnedAssets(env,proposed,owner);
      const protectGeneration = <T extends GeneratedFrame>(items:T[], existing:T[]):T[] => {
        const byId = new Map(existing.map(s=>[s.id,s]));
        return items.map(s=>{
          const old=byId.get(s.id);
          return old?.status==='generating' ? {...s,status:old.status,error:old.error,generationId:old.generationId,generationStartedAt:old.generationStartedAt} : {...s,status:s.status==='generating'?'idle':s.status,generationId:null,generationStartedAt:null};
        });
      };
      const safe:Project={...proposed,createdAt:current.createdAt,shots:protectGeneration(proposed.shots,current.shots),scenes:protectGeneration(proposed.scenes ?? [],current.scenes ?? [])};
      const saved=await saveCas(env,safe,owner,current.revision);
      if (!saved) fail(409,'Project changed; reload and retry');
      return json({project:saved});
    }
    if (match && request.method==='DELETE') {
      const result=await env.DB.prepare('DELETE FROM projects WHERE id = ? AND owner = ?').bind(match[1],owner).run();
      if (!result.meta.changes) fail(404,'Project not found');
      return json({ok:true});
    }
    fail(404,'Endpoint not found');
  } catch (error) {
    return json({error:error instanceof Error ? error.message : 'Unexpected server error'},error instanceof ApiError ? error.status : error instanceof SyntaxError ? 400 : 500);
  }
}
