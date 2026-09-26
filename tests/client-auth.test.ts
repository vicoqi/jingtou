import assert from 'node:assert/strict';
import test from 'node:test';
import { api, generateShotAudio, loadWorkspace, setClientUser } from '../lib/client.ts';

test('opening the public homepage never requests private works, libraries or provider settings', async t=>{
  const original=globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;});
  let calls=0;
  globalThis.fetch=async ()=>{calls++;return Response.json({error:'private'},{status:401});};
  const [list,config,library]=await loadWorkspace(false);
  assert.equal(calls,0);
  assert.deepEqual(list,{projects:[]});
  assert.deepEqual(config,{configured:false,model:'',speech:{configured:false,id:'qwen',provider:'阿里云百炼',model:'qwen3-tts-flash',voices:{female:'女声',male:'男声'}}});
  assert.deepEqual(library,{characters:[],scenes:[]});
});

test('shot audio generation uses the project audio endpoint', async t => {
  const original=globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;setClientUser(null);});
  setClientUser({id:'user-a',email:'a@example.com'});
  globalThis.fetch=async (url,init)=>{
    assert.equal(url,'/api/projects/project-a/generate-audio');
    assert.equal(init?.method,'POST');
    assert.deepEqual(JSON.parse(String(init?.body)),{shotId:'shot-a'});
    return Response.json({project:{id:'project-a'}});
  };
  assert.deepEqual(await generateShotAudio('project-a','shot-a'),{project:{id:'project-a'}});
});

test('private requests send the expected user and explicitly avoid browser caches', async t => {
  const original=globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;setClientUser(null);});
  setClientUser({id:'user-a',email:'a@example.com'});
  globalThis.fetch=async (_url,init)=>{
    assert.equal(new Headers(init?.headers).get('x-jingtou-user'),'user-a');
    assert.equal(init?.credentials,'same-origin');
    assert.equal(init?.cache,'no-store');
    return Response.json({projects:[]});
  };
  assert.deepEqual(await api('/api/projects'),{projects:[]});
});

test('a response from the previous account cannot populate the next account’s workspace', async t => {
  const original=globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;setClientUser(null);});
  let release!:(value:Response)=>void;
  globalThis.fetch=()=>new Promise(resolve=>{release=resolve;});
  setClientUser({id:'user-a',email:'a@example.com'});
  const request=api('/api/projects');
  setClientUser({id:'user-b',email:'b@example.com'});
  release(Response.json({projects:[{name:'private A'}]}));
  await assert.rejects(request,/账号已切换/);
});
