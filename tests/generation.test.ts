import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShotPrompt, requestImageEdits, requestImageGeneration } from '../lib/generation.ts';
import type { Project, Shot } from '../lib/types.ts';

const shot: Shot = { id:'s', title:'追逐', characterIds:['c'], scene:'雨夜街道', description:'主角回头', dialogue:'快跑！', duration:5, candidates:[], selectedCandidateId:null, status:'idle', error:null, generationId:null, generationStartedAt:null };
const project: Project = { id:'p', name:'故事', description:'', aspectRatio:'16:9', style:'国风动漫', characters:[{id:'c', name:'阿岚', description:'蓝色短发', references:[{id:'r', name:'ref.png', url:'/api/assets/00000000-0000-0000-0000-000000000001'}]}], shots:[shot], revision:1, createdAt:'', updatedAt:'' };

test('prompt uses the character description currently in the project', () => {
  assert.match(buildShotPrompt(project, shot), /蓝色短发/);
  project.characters[0].description = '黑色长发';
  assert.match(buildShotPrompt(project, shot), /黑色长发/);
  assert.doesNotMatch(buildShotPrompt(project, shot), /蓝色短发/);
});

test('associated characters must have reference images', () => {
  const refs = project.characters[0].references;
  project.characters[0].references = [];
  assert.throws(() => buildShotPrompt(project, shot), /reference/i);
  project.characters[0].references = refs;
});

test('prompt assigns contiguous reference image numbers to each character', () => {
  const two = structuredClone(project);
  two.characters[0].references.push({id:'r2',name:'side.png',url:'/api/assets/00000000-0000-0000-0000-000000000002'});
  two.characters.push({id:'c2',name:'小明',description:'红色外套',references:[{id:'r3',name:'front.png',url:'/api/assets/00000000-0000-0000-0000-000000000003'}]});
  two.shots[0].characterIds.push('c2');
  const prompt = buildShotPrompt(two,two.shots[0]);
  assert.match(prompt,/阿岚.*reference images? 1–2/i);
  assert.match(prompt,/小明.*reference image 3/i);
});

test('image edit request sends actual reference bytes and validates provider image bytes', async () => {
  const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
  let called = false;
  const result = await requestImageEdits({ key:'secret', model:'gpt-image-1', baseUrl:'https://api.openai.com/v1', prompt:'scene', count:1, images:[{name:'ref.png', mime:'image/png', bytes:png}], fetcher: async (_url, init) => {
    called = true;
    assert.equal(init?.headers && (init.headers as Record<string,string>).Authorization, 'Bearer secret');
    const form = init?.body as FormData;
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(form.get('prompt'), 'scene');
    assert.equal(form.getAll('image[]').length, 1);
    assert.deepEqual(new Uint8Array(await (form.get('image[]') as File).arrayBuffer()), png);
    return new Response(JSON.stringify({data:[{b64_json:btoa(String.fromCharCode(...png))}]}), {headers:{'content-type':'application/json'}});
  }});
  assert.equal(called, true);
  assert.deepEqual(result[0].bytes, png);
});

test('provider malformed image payload fails explicitly', async () => {
  await assert.rejects(requestImageEdits({ key:'secret', model:'gpt-image-1', baseUrl:'https://api.openai.com/v1', prompt:'x', count:1, images:[{name:'ref.png', mime:'image/png', bytes:new Uint8Array([137,80,78,71,13,10,26,10])}], fetcher: async () => new Response(JSON.stringify({data:[{b64_json:'not an image'}]})) }), /image/i);
});

test('shot without characters can generate from its text prompt', async () => {
  const png = new Uint8Array([137,80,78,71,13,10,26,10,0]);
  const images = await requestImageGeneration({key:'secret',model:'gpt-image-2.5-flare',baseUrl:'https://api.openai.com/v1',prompt:'empty station',count:1,fetcher:async (url,init)=>{
    assert.match(String(url),/\/images\/generations$/);
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(JSON.parse(String(init?.body)).prompt,'empty station');
    return new Response(JSON.stringify({data:[{b64_json:btoa(String.fromCharCode(...png))}]}));
  }});
  assert.deepEqual(images[0].bytes,png);
});
