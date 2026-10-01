import { buildCharacterPrompt, buildScenePrompt, buildShotPrompt, buildShotEndFramePrompt, shotReferenceUrls, detectImageMime, requestImageEdits, requestImageGeneration, type ReferenceBytes } from './generation.ts';
import { generationDeletionConflict, mergeGeneration, newStoryboardDraft, normalizeProject, recoverStoryboardDraft, summarizeProject, validateProject, shotVideoSource, videoSourceKey, MAX_REQUESTED_SHOTS, MIN_REQUESTED_SHOTS, MAX_STORY_LENGTH, MAX_VIDEO_CANDIDATES, STALE_STORYBOARD_MS, STALE_VIDEO_MS } from './domain.ts';
import { createSpeechProvider, DEFAULT_QWEN_TTS_MODEL, type SpeechProvider } from './speech.ts';
import { DEFAULT_STORYBOARD_MODEL, requestStoryboard } from './storyboard.ts';
import { buildVideoPrompt, checkWanVideoTask, clampVideoDuration, DEFAULT_WAN_VIDEO_MODEL, downloadWanVideo, submitWanVideoTask, type FirstFrameImage } from './video.ts';
import { getVideoFrameContext, videoFrameEditConflict } from './video-frames.ts';
import { createProject, createSamplePreview } from './sample.ts';
import { SAMPLE_PROJECT_ID } from './project-access.ts';
import { authSchemaStatements, handleAuth, requireUser } from './auth.ts';
import { ApiError, bodyJson, checkRequestOrigin, fail, json } from './http.ts';
import type { Candidate, DraftCharacter, DraftShot, GeneratedFrame, GenerationKind, Project, ReferenceImage, ResourceLibrary, Scene, Shot, ShotVideo, StoryboardDraft, VideoCandidate, VideoSource } from './types.ts';

type Statement = { bind(...args: unknown[]): { first<T>(): Promise<T | null>; all<T>(): Promise<{results:T[]}>; run(): Promise<{meta:{changes:number}}> } };
type D1 = { prepare(sql: string): Statement };
type Bucket = {
  put(key:string, body:Uint8Array, options?:unknown):Promise<unknown>;
  head(key:string):Promise<{size:number} | null>;
  get(key:string,options?:{range:{offset:number;length:number}}):Promise<{body:ReadableStream; arrayBuffer():Promise<ArrayBuffer>} | null>;
};
export type ApiEnv = {
  DB:D1;
  ASSETS_BUCKET:Bucket;
  ASSETS?:{fetch(request:Request):Promise<Response>};
  OPENAI_API_KEY?:string;
  IMAGE_API_KEY?:string;
  IMAGE_API_BASE_URL?:string;
  IMAGE_MODEL?:string;
  DASHSCOPE_API_KEY?:string;
  QWEN_TTS_MODEL?:string;
  QWEN_TTS_FEMALE_VOICE?:string;
  QWEN_TTS_MALE_VOICE?:string;
  STORYBOARD_LLM_MODEL?:string;
  STORYBOARD_LLM_BASE_URL?:string;
  WAN_VIDEO_MODEL?:string;
  WAN_VIDEO_BASE_URL?:string;
  TRUST_PROXY?:string;
};
type ProjectRow = { id:string; owner:string; revision:number; document:string; updated_at:string };
type AssetRow = { id:string; owner:string; mime:string; name:string };
const uuidPath = /^\/api\/assets\/([a-f0-9-]{36})$/;
const projectPath = /^\/api\/projects\/([a-f0-9-]{36})$/;
const generationPath = /^\/api\/projects\/([a-f0-9-]{36})\/(generate|generate-scene)$/;
const characterGenerationPath = /^\/api\/projects\/([a-f0-9-]{36})\/generate-character$/;
const audioGenerationPath = /^\/api\/projects\/([a-f0-9-]{36})\/generate-audio$/;
const videoGenerationPath = /^\/api\/projects\/([a-f0-9-]{36})\/generate-video$/;
const storyboardPath = /^\/api\/projects\/([a-f0-9-]{36})\/storyboard$/;

const schemaStatements = [
  'CREATE TABLE IF NOT EXISTS assets (id text PRIMARY KEY NOT NULL, owner text NOT NULL, mime text NOT NULL, name text NOT NULL)',
  'CREATE TABLE IF NOT EXISTS projects (id text PRIMARY KEY NOT NULL, owner text NOT NULL, revision integer NOT NULL, document text NOT NULL, updated_at text NOT NULL)',
  'CREATE INDEX IF NOT EXISTS projects_owner_updated_idx ON projects (owner, updated_at)',
  ...authSchemaStatements,
];

type SpeechRuntime = {
  public:{configured:boolean;id:'qwen';provider:string;model:string;voices:{female:'女声';male:'男声'}};
  provider:SpeechProvider | null;
};

function resolveSpeechProvider(env:ApiEnv):SpeechRuntime {
  const qwenKey=env.DASHSCOPE_API_KEY?.trim();
  const model=env.QWEN_TTS_MODEL?.trim() || DEFAULT_QWEN_TTS_MODEL;
  const configured=!!qwenKey;
  const voices:{female?:string;male?:string}={};
  if (env.QWEN_TTS_FEMALE_VOICE?.trim()) voices.female=env.QWEN_TTS_FEMALE_VOICE.trim();
  if (env.QWEN_TTS_MALE_VOICE?.trim()) voices.male=env.QWEN_TTS_MALE_VOICE.trim();
  return {
    public:{configured,id:'qwen',provider:'阿里云百炼',model,voices:{female:'女声',male:'男声'}},
    provider:configured ? createSpeechProvider({id:'qwen',key:qwenKey!,model,voices}) : null,
  };
}

async function ensureSchema(env: ApiEnv): Promise<void> {
  for (const sql of schemaStatements) await env.DB.prepare(sql).bind().run();
}

async function rowFor(env:ApiEnv,id:string,owner:string):Promise<ProjectRow> {
  const row = await env.DB.prepare('SELECT id, owner, revision, document, updated_at FROM projects WHERE id = ? AND owner = ?').bind(id,owner).first<ProjectRow>();
  if (!row || row.owner !== owner) fail(404,'Project not found');
  return row;
}
const readProject = (row:ProjectRow):Project => {
  return normalizeProject(JSON.parse(row.document));
};

async function saveCas(env:ApiEnv,project:Project,owner:string,expectedRevision:number):Promise<Project | null> {
  const next = {...project, revision:expectedRevision+1, updatedAt:new Date().toISOString()};
  const result = await env.DB.prepare('UPDATE projects SET document = ?, revision = ?, updated_at = ? WHERE id = ? AND owner = ? AND revision = ?').bind(JSON.stringify(next),next.revision,next.updatedAt,next.id,owner,expectedRevision).run();
  return result.meta.changes ? next : null;
}

function recoverStale(project:Project):Project | null {
  let changed = false;
  const recover = <T extends GeneratedFrame>(s: T): T => {
    if (s.status !== 'generating' || !s.generationStartedAt || Date.now() - Date.parse(s.generationStartedAt) <= STALE_STORYBOARD_MS) return s;
    changed = true;
    return {...s,status:'failed' as const,error:'生成已中断，请重试。',generationId:null,generationStartedAt:null};
  };
  const shots = project.shots.map(shot => {
    const recovered=recover(shot);
    const audio=recovered.audio;
    if (audio.status !== 'generating' || !audio.generationStartedAt || Date.now() - Date.parse(audio.generationStartedAt) <= STALE_STORYBOARD_MS) return recovered;
    changed = true;
    return {...recovered,audio:{...audio,status:'failed' as const,error:'配音生成已中断，请重试。',generationId:null,generationStartedAt:null}};
  });
  const scenes = (project.scenes ?? []).map(recover);
  const draftRecovered = recoverStoryboardDraft(project);
  return changed || draftRecovered ? {...(draftRecovered ?? project), shots, scenes} : null;
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
  const urls = new Map<string,'image'|'audio'|'video'>();
  for (const c of project.characters) for (const r of c.references) urls.set(r.url,'image');
  for (const s of project.shots) {
    for (const c of s.candidates) urls.set(c.url,'image');
    if (s.audio.url) urls.set(s.audio.url,'audio');
    for (const c of s.video.candidates) urls.set(c.url,'video');
  }
  for (const s of project.scenes ?? []) for (const c of s.candidates) urls.set(c.url,'image');
  const owned = new Map<string,AssetRow>();
  const uuids = [...new Set([...urls.keys()].map(url => url.match(uuidPath)?.[1]).filter((id): id is string => !!id))];
  for (let offset = 0; offset < uuids.length; offset += 50) {
    const batch = uuids.slice(offset, offset + 50);
    const rows=(await env.DB.prepare(`SELECT id, owner, mime, name FROM assets WHERE id IN (${batch.map(() => '?').join(',')}) AND owner = ?`).bind(...batch,owner).all<AssetRow>()).results;
    for (const row of rows) owned.set(row.id,row);
  }
  for (const [url,kind] of urls) {
    const match=url.match(uuidPath);
    if (!match) continue;
    const asset=owned.get(match[1]);
    if (!asset || asset.owner !== owner) fail(400,'作品使用了不属于当前账号的素材');
    if ((kind === 'image' && !asset.mime.startsWith('image/')) || (kind === 'audio' && asset.mime !== 'audio/wav') || (kind === 'video' && asset.mime !== 'video/mp4')) fail(400,'作品素材类型不正确');
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
  if (body.frame !== undefined && (kind !== 'shots' || !['start', 'end'].includes(String(body.frame)))) fail(400,'画面类型无效。');
  const frame: 'start' | 'end' = body.frame === 'end' ? 'end' : 'start';
  const targetId = kind === 'scenes' ? body.sceneId : body.shotId;
  if (typeof targetId!=='string' || typeof count!=='number' || !Number.isInteger(count) || count<1 || count>4) fail(400,'请选择镜头或场景，并生成 1–4 张图片。');
  const key=env.IMAGE_API_KEY || env.OPENAI_API_KEY;
  const model=env.IMAGE_MODEL?.trim();
  if (!key || !model) fail(503,'请配置图片生成密钥和模型');
  let target!:Shot | Scene;
  let prompt='';
  let images:ReferenceBytes[]=[];
  let generationId='';
  let aspectRatio:Project['aspectRatio']='16:9';
  let startedSaved:Project | null=null;
  for (let attempt=0;attempt<12 && !startedSaved;attempt++) {
    const current=await loadRecovered(env,id,owner);
    const items=current[kind] ?? [];
    const found=items.find(item=>item.id===targetId) as Shot | Scene | undefined;
    if (!found) fail(404,'镜头或场景不存在。');
    if (found.status==='generating') fail(409,'正在生成，请稍候。');
    if (found.candidates.length + count > 200) fail(400,'最多保留 200 张候选图。');
    let imageUrls:string[];
    try {
      prompt='name' in found ? buildScenePrompt(current,found) : frame === 'end' ? buildShotEndFramePrompt(current,found) : buildShotPrompt(current,found);
      imageUrls='name' in found ? [] : shotReferenceUrls(current,found);
      if (kind === 'shots' && frame === 'end') imageUrls.push((found as Shot).candidates.find(candidate=>candidate.id===found.selectedCandidateId)!.url);
    } catch (error) { fail(400,error instanceof Error ? error.message : '生成设定无效。'); }
    images=await Promise.all(imageUrls.map(url=>getReference(env,url,owner,request.url)));
    generationId=crypto.randomUUID();
    target=found;
    aspectRatio=current.aspectRatio;
    const started={...current,[kind]:items.map(item=>item.id===found.id ? {...item,status:'generating' as const,error:null,generationId,generationStartedAt:new Date().toISOString(),...(kind === 'shots' ? {generationFrame:frame} : {})}:item)};
    startedSaved=await saveCas(env,started,owner,current.revision);
  }
  if (!startedSaved) fail(409,'Project changed repeatedly; retry');
  const generation = (async ():Promise<Project> => {
    try {
    const providerOptions={key,model,baseUrl:env.IMAGE_API_BASE_URL || 'https://api.openai.com/v1',prompt,count,aspectRatio,fetcher};
    const output=images.length ? await requestImageEdits({...providerOptions,images}) : await requestImageGeneration(providerOptions);
    const now=new Date().toISOString();
    const candidates:Candidate[]=[];
    for (const result of output) {
      const assetId=crypto.randomUUID();
      await env.ASSETS_BUCKET.put(assetId,result.bytes,{httpMetadata:{contentType:result.mime}});
      await env.DB.prepare('INSERT INTO assets (id, owner, mime, name) VALUES (?, ?, ?, ?)').bind(assetId,owner,result.mime,`${'name' in target ? target.name : target.title}.${result.mime.split('/')[1]}`).run();
      candidates.push({id:crypto.randomUUID(),url:`/api/assets/${assetId}`,createdAt:now,prompt,batchId:generationId,source:'generated',...(kind === 'shots' ? {frame} : {})});
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
  if (waitUntil) return json({project:startedSaved},202);
  try {
    return json({project:await generation});
  } catch (error) {
    fail(502,error instanceof Error ? error.message : 'Image generation failed');
  }
}

async function handleGenerateCharacter(request:Request,env:ApiEnv,owner:string,id:string,fetcher?:typeof fetch):Promise<Response> {
  const body=await bodyJson(request);
  const name=typeof body.name==='string' ? body.name.trim() : '';
  const description=typeof body.description==='string' ? body.description.trim() : '';
  const count=body.count;
  if (!name || name.length>120) fail(400,'请填写不超过 120 个字符的角色名称。');
  if (!description || description.length>3000) fail(400,'请填写不超过 3000 个字符的外观设定。');
  if (typeof count!=='number' || !Number.isInteger(count) || count<1 || count>4) fail(400,'请选择生成 1–4 张角色参考图。');
  const current=await loadRecovered(env,id,owner);
  const key=env.IMAGE_API_KEY || env.OPENAI_API_KEY;
  const model=env.IMAGE_MODEL?.trim();
  if (!key || !model) fail(503,'请配置图片生成密钥和模型');
  const prompt=buildCharacterPrompt(current,{name,description});
  const output=await requestImageGeneration({
    key,
    model,
    baseUrl:env.IMAGE_API_BASE_URL || 'https://api.openai.com/v1',
    prompt,
    count,
    aspectRatio:'9:16',
    fetcher,
  });
  const images:ReferenceImage[]=[];
  for (const [index,result] of output.entries()) {
    const assetId=crypto.randomUUID();
    const fileName=`${name}-AI参考图-${index + 1}.${result.mime.split('/')[1]}`.slice(0,200);
    await env.ASSETS_BUCKET.put(assetId,result.bytes,{httpMetadata:{contentType:result.mime}});
    await env.DB.prepare('INSERT INTO assets (id, owner, mime, name) VALUES (?, ?, ?, ?)').bind(assetId,owner,result.mime,fileName).run();
    images.push({id:assetId,url:`/api/assets/${assetId}`,name:fileName});
  }
  return json({images});
}

async function audioGenerationResult(env:ApiEnv,owner:string,id:string,shotId:string,generationId:string,result?:{url:string;duration:number;sourceText:string;sourceVoice:'female'|'male';sourceInstruction:string},error?:string):Promise<Project> {
  for (let attempt=0;attempt<12;attempt++) {
    const current=readProject(await rowFor(env,id,owner));
    const shot=current.shots.find(item=>item.id===shotId);
    if (!shot || shot.audio.generationId!==generationId || shot.audio.status!=='generating') fail(409,'Audio generation was superseded');
    const audio=result
      ? {...shot.audio,...result,status:'idle' as const,error:null,generationId:null,generationStartedAt:null}
      : {...shot.audio,status:'failed' as const,error:error || 'Speech generation failed',generationId:null,generationStartedAt:null};
    const merged={...current,shots:current.shots.map(item=>item.id===shotId ? {...item,audio} : item)};
    const saved=await saveCas(env,merged,owner,current.revision);
    if (saved) return saved;
  }
  fail(409,'Project changed repeatedly; reload and retry');
}

async function handleGenerateAudio(request:Request,env:ApiEnv,owner:string,id:string,fetcher?:typeof fetch,waitUntil?:(promise:Promise<unknown>)=>void):Promise<Response> {
  const body=await bodyJson(request);
  if (typeof body.shotId!=='string') fail(400,'请选择需要生成配音的镜头。');
  const speech=resolveSpeechProvider(env);
  const provider=speech.provider;
  if (!provider) fail(503,'请配置百炼 API Key');
  let shot!:Shot;
  let sourceText='';
  let sourceInstruction='';
  let sourceVoice:'female' | 'male'='female';
  let generationId='';
  let startedSaved:Project | null=null;
  for (let attempt=0;attempt<12 && !startedSaved;attempt++) {
    const current=await loadRecovered(env,id,owner);
    const found=current.shots.find(item=>item.id===body.shotId);
    if (!found) fail(404,'镜头不存在。');
    if (found.audio.status==='generating') fail(409,'配音正在生成，请稍候。');
    const text=found.dialogue.trim();
    if (!text) fail(400,'请先填写镜头对白。');
    if (text.length>600) fail(400,'单个镜头对白不能超过 600 个字符。');
    const speaker=found.speakerCharacterId ? current.characters.find(character=>character.id===found.speakerCharacterId) : null;
    if (!speaker || !found.characterIds.includes(speaker.id)) fail(400,'请从出场角色中选择说话角色。');
    shot=found;
    sourceText=text;
    sourceInstruction=found.voiceInstruction.trim();
    sourceVoice=speaker.voice;
    generationId=crypto.randomUUID();
    const started={...current,shots:current.shots.map(item=>item.id===found.id ? {...item,audio:{...item.audio,status:'generating' as const,error:null,generationId,generationStartedAt:new Date().toISOString()}} : item)};
    startedSaved=await saveCas(env,started,owner,current.revision);
  }
  if (!startedSaved) fail(409,'Project changed repeatedly; retry');
  const generation=(async ():Promise<Project>=>{
    try {
      const output=await provider.synthesize({gender:sourceVoice,text:sourceText,instruction:sourceInstruction,fetcher});
      const assetId=crypto.randomUUID();
      await env.ASSETS_BUCKET.put(assetId,output.bytes,{httpMetadata:{contentType:output.mime}});
      await env.DB.prepare('INSERT INTO assets (id, owner, mime, name) VALUES (?, ?, ?, ?)').bind(assetId,owner,output.mime,`${shot.title || '镜头配音'}.wav`.slice(0,200)).run();
      return await audioGenerationResult(env,owner,id,shot.id,generationId,{url:`/api/assets/${assetId}`,duration:output.duration,sourceText,sourceVoice,sourceInstruction});
    } catch (error) {
      const message=error instanceof Error ? error.message : 'Speech generation failed';
      await audioGenerationResult(env,owner,id,shot.id,generationId,undefined,message).catch(()=>{});
      throw error instanceof Error ? error : new Error(message);
    }
  })();
  waitUntil?.(generation.then(()=>undefined,()=>undefined));
  if (waitUntil) return json({project:startedSaved},202);
  try {
    return json({project:await generation});
  } catch (error) {
    fail(502,error instanceof Error ? error.message : 'Speech generation failed');
  }
}

async function storyboardResult(env:ApiEnv,owner:string,id:string,generationId:string,output?:{characters:DraftCharacter[];shots:DraftShot[]},error?:string):Promise<Project> {
  for (let attempt=0;attempt<12;attempt++) {
    const current=readProject(await rowFor(env,id,owner));
    const draft=current.storyboardDraft;
    if (!draft || draft.generationId!==generationId || draft.status!=='generating') fail(409,'Storyboard generation was superseded');
    const next:StoryboardDraft = output
      ? {...draft,status:'ready',characters:output.characters,shots:output.shots,error:null,generationId:null,generationStartedAt:null}
      : {...draft,status:'failed',error:error || 'Storyboard generation failed',generationId:null,generationStartedAt:null};
    const saved=await saveCas(env,{...current,storyboardDraft:next},owner,current.revision);
    if (saved) return saved;
  }
  fail(409,'Project changed repeatedly; reload and retry');
}

async function runStoryboardGeneration(env:ApiEnv,owner:string,id:string,generationId:string,story:string,requestedCount:number|null,fetcher?:typeof fetch):Promise<Project> {
  try {
    const output=await requestStoryboard({
      key:env.DASHSCOPE_API_KEY!.trim(),
      model:env.STORYBOARD_LLM_MODEL,
      baseUrl:env.STORYBOARD_LLM_BASE_URL,
      story,
      requestedCount,
      fetcher,
    });
    return await storyboardResult(env,owner,id,generationId,output);
  } catch (error) {
    const message=(error instanceof Error ? error.message : 'Storyboard generation failed').slice(0,500);
    await storyboardResult(env,owner,id,generationId,undefined,message).catch(()=>{});
    throw error instanceof Error ? error : new Error(message);
  }
}

async function handleStoryboard(request:Request,env:ApiEnv,owner:string,id:string,fetcher?:typeof fetch,waitUntil?:(promise:Promise<unknown>)=>void):Promise<Response> {
  const body=await bodyJson(request);
  const story=typeof body.story==='string' ? body.story.trim() : '';
  const count=body.count ?? null;
  if (!story || story.length>MAX_STORY_LENGTH) fail(400,'请粘贴不超过 20000 个字符的故事文本。');
  if (count!==null && (typeof count!=='number' || !Number.isInteger(count) || count<MIN_REQUESTED_SHOTS || count>MAX_REQUESTED_SHOTS)) fail(400,'期望镜头数必须是 4–60 的整数。');
  if (!env.DASHSCOPE_API_KEY?.trim()) fail(503,'请配置百炼 API Key');
  let generationId='';
  let startedSaved:Project | null=null;
  for (let attempt=0;attempt<12 && !startedSaved;attempt++) {
    const current=await loadRecovered(env,id,owner);
    if (current.storyboardDraft?.status==='generating') fail(409,'正在拆分，请稍候。');
    generationId=crypto.randomUUID();
    const started={...current,storyboardDraft:newStoryboardDraft(story,count,generationId)};
    startedSaved=await saveCas(env,started,owner,current.revision);
  }
  if (!startedSaved) fail(409,'Project changed repeatedly; retry');
  const generation=runStoryboardGeneration(env,owner,id,generationId,story,count,fetcher);
  waitUntil?.(generation.then(()=>undefined,()=>undefined));
  if (waitUntil) return json({project:startedSaved},202);
  try {
    return json({project:await generation});
  } catch (error) {
    fail(502,error instanceof Error ? error.message : 'Storyboard generation failed');
  }
}

function resolveVideoRuntime(env:ApiEnv):{key:string | null;model:string;baseUrl:string | undefined;public:{configured:boolean;model:string}} {
  const key=env.DASHSCOPE_API_KEY?.trim() || null;
  const model=env.WAN_VIDEO_MODEL?.trim() || DEFAULT_WAN_VIDEO_MODEL;
  return { key, model, baseUrl: env.WAN_VIDEO_BASE_URL, public: { configured: !!key, model } };
}

async function saveShotVideo(env:ApiEnv,owner:string,id:string,shotId:string,generationId:string,update:(video:ShotVideo)=>ShotVideo):Promise<Project> {
  for (let attempt=0;attempt<12;attempt++) {
    const current=readProject(await rowFor(env,id,owner));
    const shot=current.shots.find(item=>item.id===shotId);
    if (!shot || shot.video.generationId!==generationId || shot.video.status!=='generating') fail(409,'Video generation was superseded');
    const merged={...current,shots:current.shots.map(item=>item.id===shotId ? {...item,video:update(shot.video)} : item)};
    const saved=await saveCas(env,merged,owner,current.revision);
    if (saved) return saved;
  }
  fail(409,'Project changed repeatedly; reload and retry');
}

async function videoGenerationResult(env:ApiEnv,owner:string,id:string,shotId:string,generationId:string,candidate?:VideoCandidate,error?:string):Promise<Project> {
  return saveShotVideo(env,owner,id,shotId,generationId,video=>candidate
    ? {...video,candidates:[...video.candidates,candidate],selectedVideoId:video.selectedVideoId ?? candidate.id,status:'idle',error:null,generationId:null,generationStartedAt:null,taskId:null,polledAt:null,source:null}
    : {...video,status:'failed',error:error || '视频生成失败',generationId:null,generationStartedAt:null,taskId:null,polledAt:null,source:null});
}

async function videoTaskAssigned(env:ApiEnv,owner:string,id:string,shotId:string,generationId:string,taskId:string):Promise<Project> {
  return saveShotVideo(env,owner,id,shotId,generationId,video=>({...video,taskId,error:null,polledAt:new Date().toISOString()}));
}

async function deferVideoTask(env:ApiEnv,owner:string,id:string,shotId:string,generationId:string,taskId:string,error='视频状态查询或下载暂时失败，将自动重试。'):Promise<Project> {
  return saveShotVideo(env,owner,id,shotId,generationId,video=>({...video,taskId,error,polledAt:new Date().toISOString()}));
}

async function storeVideoAsset(env:ApiEnv,owner:string,shotTitle:string,videoUrl:string,fetcher?:typeof fetch):Promise<string> {
  const downloaded=await downloadWanVideo(videoUrl,fetcher);
  const assetId=crypto.randomUUID();
  await env.ASSETS_BUCKET.put(assetId,downloaded.bytes,{httpMetadata:{contentType:downloaded.mime}});
  await env.DB.prepare('INSERT INTO assets (id, owner, mime, name) VALUES (?, ?, ?, ?)').bind(assetId,owner,downloaded.mime,`${shotTitle || '镜头视频'}.mp4`.slice(0,200)).run();
  return `/api/assets/${assetId}`;
}

async function serveVideoAsset(request:Request,env:ApiEnv,asset:AssetRow):Promise<Response> {
  const metadata=await env.ASSETS_BUCKET.head(asset.id);
  if (!metadata) fail(404,'素材文件不存在');
  const size=metadata.size;
  const headers=new Headers({'content-type':asset.mime,'content-length':String(size),'accept-ranges':'bytes','cache-control':'private, no-store','x-content-type-options':'nosniff'});
  if (request.method==='HEAD') return new Response(null,{headers});
  let range:{offset:number;length:number} | undefined;
  // Ignore multipart/unknown units and conditional ranges without a matching validator.
  const requested=request.headers.has('if-range') ? null : request.headers.get('range');
  const match=requested?.match(/^bytes=(\d*)-(\d*)$/);
  if (match && (match[1] || match[2])) {
    const offset=match[1] ? Number(match[1]) : Math.max(0,size-Number(match[2]));
    const end=match[1] && match[2] ? Math.min(size-1,Number(match[2])) : size-1;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset>=size || end<offset || (!match[1] && Number(match[2])===0)) {
      headers.set('content-range',`bytes */${size}`);
      headers.set('content-length','0');
      return new Response(null,{status:416,headers});
    }
    range={offset,length:end-offset+1};
    headers.set('content-range',`bytes ${offset}-${end}/${size}`);
    headers.set('content-length',String(range.length));
  }
  const object=await env.ASSETS_BUCKET.get(asset.id,range ? {range} : undefined);
  if (!object) fail(404,'素材文件不存在');
  return new Response(object.body,{status:range ? 206 : 200,headers});
}

// Jobs accepted before frame chaining did not persist a snapshot; retain their old
// single-frame interpretation rather than label them as newly chained videos.
const legacyVideoSource=(shot:Shot):VideoSource=>({sourceFirstFrameId:shot.selectedCandidateId ?? '',sourceKey:videoSourceKey(shot.description.trim(),shot.dialogue.trim(),shot.duration)});
const makeVideoCandidate=(url:string,duration:number|null,source:VideoSource):VideoCandidate=>({id:crypto.randomUUID(),url,createdAt:new Date().toISOString(),duration,...source});

type VideoJob={title:string;prompt:string;duration:number;source:VideoSource;firstFrame:FirstFrameImage;lastFrame:FirstFrameImage|null};

async function runVideoGeneration(env:ApiEnv,owner:string,id:string,shotId:string,generationId:string,job:VideoJob,fetcher?:typeof fetch):Promise<Project | null> {
  const runtime=resolveVideoRuntime(env);
  if (!runtime.key) throw new Error('请配置百炼 API Key');
  const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
  let taskId:string;
  try {
    taskId=await submitWanVideoTask({key:runtime.key,model:runtime.model,baseUrl:runtime.baseUrl,prompt:job.prompt,firstFrame:job.firstFrame,lastFrame:job.lastFrame,duration:job.duration,fetcher});
  } catch (error) {
    const message=(error instanceof Error ? error.message : '视频生成失败').slice(0,500);
    await videoGenerationResult(env,owner,id,shotId,generationId,undefined,message).catch(()=>{});
    throw error instanceof Error ? error : new Error(message);
  }
  // Once accepted, query/download failures must preserve this task rather than submit
  // a second generation. Persist its id before the first query so GET can resume it.
  await videoTaskAssigned(env,owner,id,shotId,generationId,taskId);
  const deadline=Date.now()+4.5*60_000;
  while (Date.now()<deadline) {
    let task;
    try {
      task=await checkWanVideoTask({key:runtime.key,taskId,baseUrl:runtime.baseUrl,fetcher});
    } catch {
      return deferVideoTask(env,owner,id,shotId,generationId,taskId);
    }
    if (task.status==='SUCCEEDED' && task.videoUrl) {
      let url:string;
      try {
        url=await storeVideoAsset(env,owner,job.title,task.videoUrl,fetcher);
      } catch {
        return deferVideoTask(env,owner,id,shotId,generationId,taskId);
      }
      return videoGenerationResult(env,owner,id,shotId,generationId,makeVideoCandidate(url,task.duration ?? job.duration,job.source));
    }
    if (task.error) {
      await videoGenerationResult(env,owner,id,shotId,generationId,undefined,task.error);
      throw new Error(task.error);
    }
    await videoTaskAssigned(env,owner,id,shotId,generationId,taskId);
    await sleep(15_000);
  }
  return null;
}

async function pollPendingVideos(env:ApiEnv,owner:string,project:Project,fetcher?:typeof fetch):Promise<Project | null> {
  const runtime=resolveVideoRuntime(env);
  const key=runtime.key;
  const now=Date.now();
  let latest:Project | null=null;
  let touched=false;
  const record=async (action:()=>Promise<Project>):Promise<void>=>{
    touched=true;
    try { latest=await action(); } catch { /* superseded; fall back to a fresh read below */ }
  };
  for (const shot of project.shots) {
    const video=shot.video;
    const generationId=video.generationId;
    if (video.status!=='generating' || !generationId) continue;
    const startedAt=video.generationStartedAt ? Date.parse(video.generationStartedAt) : 0;
    const lastPolled=video.polledAt ? Date.parse(video.polledAt) : startedAt;
    const overdue=now-startedAt>STALE_VIDEO_MS;
    if (video.taskId && now-lastPolled<20_000) continue;
    const taskId=video.taskId;
    if (!taskId) {
      if (overdue) await record(()=>videoGenerationResult(env,owner,project.id,shot.id,generationId,undefined,'视频生成已中断，请重试。'));
      continue;
    }
    if (!key) {
      await record(()=>deferVideoTask(env,owner,project.id,shot.id,generationId,taskId,'视频服务配置不可用，恢复配置后继续查询原任务。'));
      continue;
    }
    try {
      const task=await checkWanVideoTask({key,taskId,baseUrl:runtime.baseUrl,fetcher});
      if (task.status==='SUCCEEDED' && task.videoUrl) {
        const url=await storeVideoAsset(env,owner,shot.title,task.videoUrl,fetcher);
        await record(()=>videoGenerationResult(env,owner,project.id,shot.id,generationId,makeVideoCandidate(url,task.duration ?? clampVideoDuration(video.source?.sourceDuration ?? shot.duration),video.source ?? legacyVideoSource(shot))));
      } else if (task.error) {
        const message=task.error;
        await record(()=>videoGenerationResult(env,owner,project.id,shot.id,generationId,undefined,message));
      } else {
        await record(()=>videoTaskAssigned(env,owner,project.id,shot.id,generationId,taskId));
      }
    } catch {
      await record(()=>deferVideoTask(env,owner,project.id,shot.id,generationId,taskId));
    }
  }
  return latest ?? (touched ? readProject(await rowFor(env,project.id,owner)) : null);
}

async function handleGenerateVideo(request:Request,env:ApiEnv,owner:string,id:string,fetcher?:typeof fetch,waitUntil?:(promise:Promise<unknown>)=>void):Promise<Response> {
  const body=await bodyJson(request);
  if (typeof body.shotId!=='string') fail(400,'请选择需要生成视频的镜头。');
  if (!env.DASHSCOPE_API_KEY?.trim()) fail(503,'请配置百炼 API Key');
  let job!:VideoJob;
  let generationId='';
  let startedSaved:Project | null=null;
  for (let attempt=0;attempt<12 && !startedSaved;attempt++) {
    const current=await loadRecovered(env,id,owner);
    const found=current.shots.find(item=>item.id===body.shotId);
    if (!found) fail(404,'镜头不存在。');
    const { currentFrame, endFrame } = getVideoFrameContext(current,found);
    if (found.video.status==='generating') fail(409,'视频正在生成，请稍候。');
    if (!found.selectedCandidateId || !found.candidates.some(candidate=>candidate.id===found.selectedCandidateId)) fail(400,'请先为镜头选定一张候选图，再生成视频。');
    if (found.video.candidates.length >= MAX_VIDEO_CANDIDATES) fail(400,`最多保留 ${MAX_VIDEO_CANDIDATES} 个视频候选。`);
    // Description and speaker rules live in buildVideoPrompt; failures surface as 400 here.
    let prompt='';
    try { prompt=buildVideoPrompt(current,found); } catch (error) { fail(400,error instanceof Error ? error.message : '生成设定无效。'); }
    const [reference,lastReference]=await Promise.all([
      getReference(env,currentFrame!.url,owner,request.url),
      endFrame ? getReference(env,endFrame.url,owner,request.url) : Promise.resolve(null),
    ]);
    job={title:found.title,prompt,duration:clampVideoDuration(found.duration),source:shotVideoSource(current,found),firstFrame:{bytes:reference.bytes,mime:reference.mime},lastFrame:lastReference ? {bytes:lastReference.bytes,mime:lastReference.mime} : null};
    generationId=crypto.randomUUID();
    const started={...current,shots:current.shots.map(item=>item.id===found.id ? {...item,video:{...item.video,status:'generating' as const,error:null,generationId,generationStartedAt:new Date().toISOString(),taskId:null,polledAt:null,source:job.source}} : item)};
    startedSaved=await saveCas(env,started,owner,current.revision);
  }
  if (!startedSaved) fail(409,'Project changed repeatedly; retry');
  const generation=runVideoGeneration(env,owner,id,body.shotId,generationId,job,fetcher);
  waitUntil?.(generation.then(()=>undefined,()=>undefined));
  if (waitUntil) return json({project:startedSaved},202);
  try {
    const result=await generation;
    return json({project:result ?? readProject(await rowFor(env,id,owner))});
  } catch (error) {
    fail(502,error instanceof Error ? error.message : '视频生成失败');
  }
}

export async function handleApiRequest(request:Request,env:ApiEnv,options:{fetcher?:typeof fetch;waitUntil?:(promise:Promise<unknown>)=>void}={}):Promise<Response> {
  try {
    checkRequestOrigin(request,env.TRUST_PROXY==='1');
    const path=new URL(request.url).pathname;
    await ensureSchema(env);
    if (path.startsWith('/api/auth/')) return await handleAuth(request,env);
    const samplePath = `/api/projects/${SAMPLE_PROJECT_ID}`;
    if (path === samplePath && request.method === 'GET') return json({project:createSamplePreview()});
    const owner=(await requireUser(request,env)).id;
    if (path==='/api/config' && request.method==='GET') return json({configured:!!((env.IMAGE_API_KEY || env.OPENAI_API_KEY) && env.IMAGE_MODEL?.trim()),model:env.IMAGE_MODEL?.trim() || '',speech:resolveSpeechProvider(env).public,storyboard:{configured:!!env.DASHSCOPE_API_KEY?.trim(),model:env.STORYBOARD_LLM_MODEL?.trim() || DEFAULT_STORYBOARD_MODEL},video:resolveVideoRuntime(env).public});
    if ((path === samplePath && request.method !== 'GET') || path === `${samplePath}/generate` || path === `${samplePath}/generate-scene` || path === `${samplePath}/generate-character` || path === `${samplePath}/generate-audio` || path === `${samplePath}/generate-video` || path === `${samplePath}/storyboard`) {
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
      const story=typeof body.story==='string' ? body.story.trim() : '';
      if (story && story.length>MAX_STORY_LENGTH) fail(400,'故事文本不能超过 20000 个字符。');
      if (story && body.count!==undefined && (typeof body.count!=='number' || !Number.isInteger(body.count) || body.count<MIN_REQUESTED_SHOTS || body.count>MAX_REQUESTED_SHOTS)) fail(400,'期望镜头数必须是 4–60 的整数。');
      if (story && !env.DASHSCOPE_API_KEY?.trim()) fail(503,'请配置百炼 API Key');
      const baseProject=createProject(body.name,body.demo===true,typeof body.style==='string' ? body.style : undefined);
      const requestedCount=typeof body.count==='number' ? body.count : null;
      const generationId=story ? crypto.randomUUID() : null;
      const project=generationId ? {...baseProject,storyboardDraft:newStoryboardDraft(story,requestedCount,generationId)} : baseProject;
      await env.DB.prepare('INSERT INTO projects (id, owner, revision, document, updated_at) VALUES (?, ?, ?, ?, ?)').bind(project.id,owner,project.revision,JSON.stringify(project),project.updatedAt).run();
      if (generationId) options.waitUntil?.(runStoryboardGeneration(env,owner,project.id,generationId,story,requestedCount,options.fetcher).then(()=>undefined,()=>undefined));
      return json({project},201);
    }
    const assetMatch=path.match(uuidPath);
    if (assetMatch && (request.method==='GET' || request.method==='HEAD')) {
      const asset=await env.DB.prepare('SELECT id, owner, mime, name FROM assets WHERE id = ? AND owner = ?').bind(assetMatch[1],owner).first<AssetRow>();
      if (!asset || asset.owner!==owner) fail(404,'素材不存在');
      if (asset.mime==='video/mp4') return await serveVideoAsset(request,env,asset);
      const object=await env.ASSETS_BUCKET.get(asset.id);
      if (!object) fail(404,'素材文件不存在');
      if (request.method==='HEAD') { await object.body.cancel(); return new Response(null,{headers:{'content-type':asset.mime,'cache-control':'private, no-store','x-content-type-options':'nosniff'}}); }
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
    const characterGenerateMatch=path.match(characterGenerationPath);
    if (characterGenerateMatch && request.method==='POST') return await handleGenerateCharacter(request,env,owner,characterGenerateMatch[1],options.fetcher);
    const audioGenerateMatch=path.match(audioGenerationPath);
    if (audioGenerateMatch && request.method==='POST') return await handleGenerateAudio(request,env,owner,audioGenerateMatch[1],options.fetcher,options.waitUntil);
    const videoGenerateMatch=path.match(videoGenerationPath);
    if (videoGenerateMatch && request.method==='POST') return await handleGenerateVideo(request,env,owner,videoGenerateMatch[1],options.fetcher,options.waitUntil);
    const storyboardMatch=path.match(storyboardPath);
    if (storyboardMatch && request.method==='POST') return await handleStoryboard(request,env,owner,storyboardMatch[1],options.fetcher,options.waitUntil);
    const match=path.match(projectPath);
    if (match && request.method==='GET') {
      const project=await loadRecovered(env,match[1],owner);
      // Video tasks outlive waitUntil; every poll is a chance to advance them. With a real
      // waitUntil the advance (provider query + download) runs in the background so this
      // hot path stays fast; the next poll cycle picks up the result.
      const advance=pollPendingVideos(env,owner,project,options.fetcher);
      if (options.waitUntil) { options.waitUntil(advance.then(()=>undefined,()=>undefined)); return json({project}); }
      return json({project:(await advance.catch(()=>null)) ?? project});
    }
    if (match && request.method==='PUT') {
      const current=await loadRecovered(env,match[1],owner);
      const body=await bodyJson(request);
      const proposed=normalizeProject(body?.project);
      try { validateProject(proposed); } catch (error) { fail(400,error instanceof Error ? error.message : 'Invalid project'); }
      if (proposed.id!==match[1] || proposed.revision!==current.revision) fail(409,'Project changed; reload and retry');
      const videoConflict=videoFrameEditConflict(current,proposed) || generationDeletionConflict(current,proposed);
      if (videoConflict) fail(400,videoConflict);
      await validateOwnedAssets(env,proposed,owner);
      const protectGeneration = <T extends GeneratedFrame>(items:T[], existing:T[]):T[] => {
        const byId = new Map(existing.map(s=>[s.id,s]));
        return items.map(s=>{
          const old=byId.get(s.id);
          return old?.status==='generating' ? {...s,status:old.status,error:old.error,generationId:old.generationId,generationStartedAt:old.generationStartedAt} : {...s,status:s.status==='generating'?'idle':s.status,generationId:null,generationStartedAt:null};
        });
      };
      const safeDraft=current.storyboardDraft?.status==='generating' ? current.storyboardDraft : proposed.storyboardDraft ?? null;
      const safe:Project={...proposed,createdAt:current.createdAt,shots:protectGeneration(proposed.shots,current.shots),scenes:protectGeneration(proposed.scenes ?? [],current.scenes ?? []),storyboardDraft:safeDraft};
      const existingShots=new Map(current.shots.map(shot=>[shot.id,shot]));
      safe.shots=safe.shots.map(shot=>{
        const old=existingShots.get(shot.id);
        // Audio and video jobs are protected independently so parallel jobs never clobber
        // each other; a job running on the server keeps its recorded state verbatim.
        const audio=old?.audio.status==='generating'
          ? old.audio
          : {...shot.audio,status:shot.audio.status==='generating'?'idle':shot.audio.status,generationId:null,generationStartedAt:null};
        const video=old?.video.status==='generating'
          ? {...old.video,selectedVideoId:shot.video.selectedVideoId===null || old.video.candidates.some(candidate=>candidate.id===shot.video.selectedVideoId) ? shot.video.selectedVideoId : old.video.selectedVideoId}
          : {...shot.video,status:shot.video.status==='generating'?'idle':shot.video.status,generationId:null,generationStartedAt:null,taskId:null,polledAt:null,source:null};
        return {...shot,generationFrame:old?.status==='generating' ? old.generationFrame : shot.generationFrame,audio,video};
      });
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
