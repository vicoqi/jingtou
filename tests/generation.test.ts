import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCharacterPrompt, buildShotPrompt, requestImageEdits, requestImageGeneration } from '../lib/generation.ts';
import { emptyShotAudio } from '../lib/domain.ts';
import type { Project, Shot } from '../lib/types.ts';

const shot: Shot = { id:'s', title:'追逐', characterIds:['c'], scene:'雨夜街道', description:'主角回头', dialogue:'快跑！', showSubtitle:true, voiceInstruction:'', duration:5, speakerCharacterId:'c', audio:emptyShotAudio(), candidates:[], selectedCandidateId:null, status:'idle', error:null, generationId:null, generationStartedAt:null };
const project: Project = { id:'p', name:'故事', description:'', aspectRatio:'16:9', style:'国风动漫', characters:[{id:'c', name:'阿岚', description:'蓝色短发', voice:'female', references:[{id:'r', name:'ref.png', url:'/api/assets/00000000-0000-0000-0000-000000000001'}]}], shots:[shot], revision:1, createdAt:'', updatedAt:'' };

test('character prompt inherits project style and asks for a reusable single-person reference', () => {
  const prompt=buildCharacterPrompt(project,{name:'阿岚',description:'蓝色短发，琥珀色眼睛，黑色短夹克'});
  assert.match(prompt,/国风动漫/);
  assert.match(prompt,/阿岚/);
  assert.match(prompt,/蓝色短发，琥珀色眼睛，黑色短夹克/);
  assert.match(prompt,/one person only/i);
  assert.match(prompt,/full-body/i);
  assert.match(prompt,/No extra people.*text/i);
  assert.throws(()=>buildCharacterPrompt(project,{name:' ',description:'蓝色短发'}),/角色名称/);
  assert.throws(()=>buildCharacterPrompt(project,{name:'阿岚',description:' '}),/外观设定/);
});

test('prompt uses the character description currently in the project', () => {
  assert.match(buildShotPrompt(project, shot), /蓝色短发/);
  assert.doesNotMatch(buildShotPrompt(project, shot), /Aspect ratio/i);
  project.characters[0].description = '黑色长发';
  assert.match(buildShotPrompt(project, shot), /黑色长发/);
  assert.doesNotMatch(buildShotPrompt(project, shot), /蓝色短发/);
});

test('project style is not overridden by a fixed animation instruction', () => {
  const realistic = structuredClone(project);
  realistic.style = '电影写实摄影';
  const prompt = buildShotPrompt(realistic,realistic.shots[0]);
  assert.match(prompt,/电影写实摄影/);
  assert.doesNotMatch(prompt,/animated|anime|动漫/i);
});

test('associated characters must have reference images', () => {
  const refs = project.characters[0].references;
  project.characters[0].references = [];
  assert.throws(() => buildShotPrompt(project, shot), /reference/i);
  project.characters[0].references = refs;
});

test('text-only shot does not claim that character references were provided', () => {
  const textOnly = structuredClone(shot);
  textOnly.characterIds = [];
  const prompt = buildShotPrompt(project,textOnly);
  assert.doesNotMatch(prompt,/provided character reference images/i);
  assert.match(prompt,/No named characters/i);
});

test('prompt assigns contiguous reference image numbers to each character', () => {
  const two = structuredClone(project);
  two.characters[0].references.push({id:'r2',name:'side.png',url:'/api/assets/00000000-0000-0000-0000-000000000002'});
  two.characters.push({id:'c2',name:'小明',description:'红色外套',voice:'male',references:[{id:'r3',name:'front.png',url:'/api/assets/00000000-0000-0000-0000-000000000003'}]});
  two.shots[0].characterIds.push('c2');
  const prompt = buildShotPrompt(two,two.shots[0]);
  assert.match(prompt,/阿岚.*reference images? 1–2/i);
  assert.match(prompt,/小明.*reference image 3/i);
});

test('image edit request sends actual reference bytes and validates provider image bytes', async () => {
  const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
  let called = false;
  const result = await requestImageEdits({ key:'secret', model:'gpt-image-1', baseUrl:'https://new.97api.com/v1', prompt:'scene', count:1, aspectRatio:'16:9', images:[{name:'ref.png', mime:'image/png', bytes:png}], fetcher: async (_url, init) => {
    called = true;
    assert.equal(init?.headers && (init.headers as Record<string,string>).Authorization, 'Bearer secret');
    const form = init?.body as FormData;
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(form.get('prompt'), 'scene');
    assert.equal(form.get('n'), '1');
    assert.equal(form.get('response_format'), 'b64_json');
    assert.equal(form.get('aspect_ratio'), null);
    assert.equal(form.get('size'), null);
    assert.equal(form.getAll('image').length, 1);
    assert.deepEqual(new Uint8Array(await (form.get('image') as File).arrayBuffer()), png);
    return new Response(JSON.stringify({data:[{b64_json:btoa(String.fromCharCode(...png))}]}), {headers:{'content-type':'application/json'}});
  }});
  assert.equal(called, true);
  assert.deepEqual(result[0].bytes, png);
});

test('multiple edit candidates use one-image result requests for compatible providers', async () => {
  const png = new Uint8Array([137,80,78,71,13,10,26,10,0]);
  const calls: FormData[] = [];
  const images = await requestImageEdits({key:'secret',model:'gpt-image-2',baseUrl:'https://www.packyapi.ai/v1/',prompt:'scene',count:3,aspectRatio:'16:9',images:[{name:'ref.png',mime:'image/png',bytes:png}],fetcher:async (url,init)=>{
    assert.equal(String(url),'https://www.packyapi.ai/v1/images/edits');
    calls.push(init?.body as FormData);
    return new Response(JSON.stringify({data:[{b64_json:btoa(String.fromCharCode(...png))}]}));
  }});
  assert.equal(calls.length,3);
  assert.equal(images.length,3);
  for (const form of calls) {
    assert.equal(form.get('n'),'1');
    assert.equal(form.get('response_format'),'b64_json');
  }
});

test('provider malformed image payload fails explicitly', async () => {
  await assert.rejects(requestImageEdits({ key:'secret', model:'gpt-image-1', baseUrl:'https://api.openai.com/v1', prompt:'x', count:1, aspectRatio:'16:9', images:[{name:'ref.png', mime:'image/png', bytes:new Uint8Array([137,80,78,71,13,10,26,10])}], fetcher: async () => new Response(JSON.stringify({data:[{b64_json:'not an image'}]})) }), /image/i);
});

test('provider errors preserve a safe response message for troubleshooting', async () => {
  await assert.rejects(requestImageGeneration({key:'secret',model:'gpt-image-2',baseUrl:'https://provider.example/v1',prompt:'portrait',count:1,aspectRatio:'16:9',fetcher:async()=>new Response(JSON.stringify({error:{message:'Unsupported field: response_format'}}),{status:400,headers:{'content-type':'application/json'}})}),error=>{
    assert.match(String(error),/400/);
    assert.match(String(error),/Unsupported field: response_format/);
    return true;
  });
});

test('shot without characters can generate from its text prompt', async () => {
  const png = new Uint8Array([137,80,78,71,13,10,26,10,0]);
  const images = await requestImageGeneration({key:'secret',model:'gpt-image-2.5-flare',baseUrl:'https://new-nocf.97api.com/v1',prompt:'empty station',count:1,aspectRatio:'9:16',fetcher:async (url,init)=>{
    if (String(url) === 'https://cdn.example.com/images/result.png') {
      assert.equal(init?.signal instanceof AbortSignal,true);
      return new Response(png,{headers:{'content-type':'image/png','content-length':String(png.length)}});
    }
    assert.match(String(url),/\/images\/generations$/);
    assert.ok(init?.signal instanceof AbortSignal);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.prompt,'empty station');
    assert.equal(body.n,1);
    assert.equal(body.size,'1254x1254');
    assert.equal(body.response_format,'url');
    assert.equal('aspect_ratio' in body,false);
    assert.equal(body.quality,'high');
    assert.equal(body.output_format,'webp');
    return new Response(JSON.stringify({data:[{url:'https://cdn.example.com/images/result.png'}]}));
  }});
  assert.deepEqual(images[0].bytes,png);
});

test('provider image URLs cannot target local or literal-IP hosts', async () => {
  let calls = 0;
  await assert.rejects(requestImageGeneration({key:'secret',model:'gpt-image-2',baseUrl:'https://new-nocf.97api.com/v1',prompt:'station',count:1,aspectRatio:'16:9',fetcher:async ()=>{
    calls += 1;
    return new Response(JSON.stringify({data:[{url:'https://127.0.0.1/private.png'}]}));
  }}),/invalid image URL/i);
  assert.equal(calls,1);
});

test('multiple text candidates use one-image result requests for compatible providers', async () => {
  const png = new Uint8Array([137,80,78,71,13,10,26,10,0]);
  const calls: unknown[] = [];
  const images = await requestImageGeneration({key:'secret',model:'gpt-image-2',baseUrl:'https://www.packyapi.ai/v1',prompt:'station',count:4,aspectRatio:'16:9',fetcher:async (_url,init)=>{
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({data:[{b64_json:btoa(String.fromCharCode(...png))}]}));
  }});
  assert.equal(calls.length,4);
  assert.equal(images.length,4);
  for (const body of calls as Array<Record<string,unknown>>) {
    assert.equal(body.n,1);
    assert.equal(body.response_format,'b64_json');
  }
});
