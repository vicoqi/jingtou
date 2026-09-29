import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyShotAudio, getTimeline, isShotAudioStale, shotAtTime, newShot, normalizeProject, validateProject, mergeGeneration } from '../lib/domain.ts';
import type { Project, Shot } from '../lib/types.ts';

const shot = (id: string, duration = 5): Shot => ({ id, title: id, characterIds: [], scene: '', description: '', dialogue: '', showSubtitle: true, voiceInstruction: '', duration, audioLeadIn: 0, audioTailOut: 0, speakerCharacterId: null, audio: emptyShotAudio(), candidates: [], selectedCandidateId: null, status: 'idle', error: null, generationId: null, generationStartedAt: null });
const project = (shots: Shot[]): Project => ({ id: 'p', name: 'Test', description: '', aspectRatio: '16:9', style: '', characters: [], shots, revision: 1, createdAt: '', updatedAt: '' });

test('timeline preserves ordering and end boundary belongs to next shot', () => {
  const shots = [shot('a', 3), shot('b', 7)];
  assert.deepEqual(getTimeline(shots).map(({shot, start, end}) => [shot.id, start, end]), [['a', 0, 3], ['b', 3, 10]]);
  assert.equal(shotAtTime(shots, 0)?.id, 'a');
  assert.equal(shotAtTime(shots, 3)?.id, 'b');
  assert.equal(shotAtTime(shots, 10), null);
});

test('new shot starts empty at five seconds', () => {
  const result = newShot();
  assert.equal(result.duration, 5);
  assert.equal(result.showSubtitle, true);
  assert.equal(result.voiceInstruction, '');
  assert.equal(result.audioLeadIn, 0);
  assert.equal(result.audioTailOut, 0);
  assert.equal(result.status, 'idle');
  assert.equal(result.selectedCandidateId, null);
  assert.equal(result.speakerCharacterId, null);
  assert.deepEqual(result.audio, emptyShotAudio());
});

test('legacy projects gain default voices and empty audio state', () => {
  const legacy = structuredClone(project([shot('x')])) as unknown as {characters:Record<string,unknown>[];shots:Record<string,unknown>[]};
  legacy.characters = [{id:'c', name:'C', description:'', references:[]}];
  legacy.shots[0].characterIds = ['c'];
  delete legacy.characters[0].voice;
  delete legacy.shots[0].speakerCharacterId;
  delete legacy.shots[0].audio;
  delete legacy.shots[0].showSubtitle;
  delete legacy.shots[0].voiceInstruction;
  delete legacy.shots[0].audioLeadIn;
  delete legacy.shots[0].audioTailOut;

  const normalized = normalizeProject(legacy);

  assert.equal(normalized.characters[0].voice, 'female');
  assert.equal(normalized.shots[0].speakerCharacterId, null);
  assert.equal(normalized.shots[0].showSubtitle, true);
  assert.equal(normalized.shots[0].voiceInstruction, '');
  assert.equal(normalized.shots[0].audioLeadIn, 0);
  assert.equal(normalized.shots[0].audioTailOut, 0);
  assert.equal(normalized.shots[0].duration, 5);
  assert.deepEqual(normalized.shots[0].audio, emptyShotAudio());
  assert.doesNotThrow(() => validateProject(normalized));
});

test('legacy generated audio gains an empty tone snapshot', () => {
  const legacy = structuredClone(project([shot('x')])) as unknown as {shots:Record<string,unknown>[]};
  legacy.shots[0].audio={
    ...emptyShotAudio(),
    url:'/api/assets/00000000-0000-0000-0000-000000000001',
    duration:1,
    sourceText:'你好',
    sourceVoice:'female',
  };
  const audio=legacy.shots[0].audio as Record<string,unknown>;
  delete audio.sourceInstruction;
  delete legacy.shots[0].voiceInstruction;

  const normalized=normalizeProject(legacy);

  assert.equal(normalized.shots[0].voiceInstruction,'');
  assert.equal(normalized.shots[0].audio.sourceInstruction,'');
  assert.doesNotThrow(()=>validateProject(normalized));
});

test('validation accepts a hidden subtitle and rejects malformed subtitle visibility', () => {
  const hidden = project([shot('x')]);
  hidden.shots[0].showSubtitle = false;
  assert.doesNotThrow(() => validateProject(hidden));

  const malformed = structuredClone(hidden) as unknown as {shots:Record<string,unknown>[]};
  malformed.shots[0].showSubtitle = 'false';
  assert.throws(() => validateProject(malformed), /shot/i);
});

test('validation limits tone descriptions to 500 characters', () => {
  const valid=project([shot('x')]);
  valid.shots[0].voiceInstruction='字'.repeat(500);
  assert.doesNotThrow(()=>validateProject(valid));
  valid.shots[0].voiceInstruction+='字';
  assert.throws(()=>validateProject(valid),/shot/i);
});

test('pause validation accepts finite seconds from zero through thirty and preserves saved values', () => {
  const valid=project([shot('x')]);
  valid.shots[0].audioLeadIn=0.2;
  valid.shots[0].audioTailOut=30;
  assert.doesNotThrow(()=>validateProject(valid));
  const normalized=normalizeProject(valid);
  assert.equal(normalized.shots[0].audioLeadIn,0.2);
  assert.equal(normalized.shots[0].audioTailOut,30);
  assert.equal(normalized.shots[0].duration,5);
  for (const field of ['audioLeadIn','audioTailOut']) {
    for (const value of [-0.1,30.1,NaN,Infinity,'1',null]) {
      const malformed=structuredClone(valid) as unknown as {shots:Record<string,unknown>[]};
      malformed.shots[0][field]=value;
      assert.throws(()=>validateProject(normalizeProject(malformed)),/pause/i,`${field}=${String(value)}`);
    }
  }
});

test('audio becomes stale when dialogue, speaker, voice, or tone instruction changes', () => {
  const p=project([shot('x')]);
  p.characters=[{id:'c',name:'C',description:'',voice:'female',references:[]}];
  p.shots[0].characterIds=['c'];
  p.shots[0].speakerCharacterId='c';
  p.shots[0].dialogue='你好';
  p.shots[0].voiceInstruction='温柔地说';
  p.shots[0].audio={...emptyShotAudio(),url:'/api/assets/00000000-0000-0000-0000-000000000001',duration:1,sourceText:'你好',sourceVoice:'female',sourceInstruction:'温柔地说'};
  assert.equal(isShotAudioStale(p,p.shots[0]),false);
  p.shots[0].audioLeadIn=0.3;
  p.shots[0].audioTailOut=0.5;
  p.shots[0].duration=2;
  assert.equal(isShotAudioStale(p,p.shots[0]),false);
  p.shots[0].dialogue='你好呀';
  assert.equal(isShotAudioStale(p,p.shots[0]),true);
  p.shots[0].dialogue='你好';
  p.shots[0].voiceInstruction='激动地说';
  assert.equal(isShotAudioStale(p,p.shots[0]),true);
  p.shots[0].voiceInstruction='温柔地说';
  p.characters[0].voice='male';
  assert.equal(isShotAudioStale(p,p.shots[0]),true);
  p.shots[0].speakerCharacterId=null;
  assert.equal(isShotAudioStale(p,p.shots[0]),true);
});

test('creating shots works on LAN HTTP where crypto.randomUUID is unavailable', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis,'crypto')!;
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues}});
  try {
    assert.doesNotThrow(()=>{
      const first = newShot();
      const second = newShot();
      assert.match(first.id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      assert.notEqual(first.id,second.id);
    });
  } finally {
    Object.defineProperty(globalThis,'crypto',original);
  }
});

test('validation rejects invalid duration and malformed reference URLs', () => {
  assert.throws(() => validateProject(project([shot('x', 0)])), /duration/i);
  const p = project([shot('x')]);
  p.characters.push({id:'c', name:'C', description:'', voice:'female', references:[{id:'r', name:'bad', url:'https://outside.example/a.jpg'}]});
  assert.throws(() => validateProject(p), /reference/i);
});

test('generation merge preserves selection, candidate history and unrelated edits', () => {
  const prior = shot('a');
  prior.candidates.push({id:'old', url:'/api/assets/old', createdAt:'', prompt:'', batchId:'old', source:'generated'});
  prior.selectedCandidateId = 'old';
  prior.status = 'generating';
  prior.generationId = 'job';
  const current = project([prior, shot('b')]);
  current.shots[1].description = 'concurrent edit';
  const next = mergeGeneration(current, 'a', 'job', [{id:'new', url:'/api/assets/new', createdAt:'', prompt:'', batchId:'job', source:'generated'}]);
  assert.equal(next.shots[0].selectedCandidateId, 'old');
  assert.deepEqual(next.shots[0].candidates.map(c => c.id), ['old','new']);
  assert.equal(next.shots[1].description, 'concurrent edit');
  assert.equal(next.shots[0].status, 'idle');
});

test('rebasing a local edit keeps completed generation results from the server', async () => {
  const domain=await import('../lib/domain.ts');
  assert.equal(typeof domain.rebaseProjectEdits,'function');
  const local=project([shot('a'),shot('b')]);
  local.revision=4;
  local.shots[1].description='本地修改的第二个镜头';
  const remote=structuredClone(local);
  remote.revision=5;
  remote.shots[1].description='保存前的第二个镜头';
  remote.shots[0].candidates=[{id:'generated',url:'/api/assets/00000000-0000-0000-0000-000000000001',createdAt:'',prompt:'',batchId:'job',source:'generated'}];
  remote.shots[0].status='idle';
  remote.shots[0].generationId=null;
  remote.shots[0].generationStartedAt=null;

  const rebased=domain.rebaseProjectEdits(local,remote);

  assert.equal(rebased.revision,5);
  assert.equal(rebased.shots[1].description,'本地修改的第二个镜头');
  assert.deepEqual(rebased.shots[0].candidates.map(candidate=>candidate.id),['generated']);
});

test('rebasing retains local rhythm edits while adopting newly generated audio', async () => {
  const {rebaseProjectEdits}=await import('../lib/domain.ts');
  const remote=project([shot('line'),shot('other')]);
  const local=structuredClone(remote);
  local.shots[0].audioLeadIn=0.3;
  local.shots[0].audioTailOut=0.6;
  local.shots[0].duration=9;
  remote.revision++;
  remote.shots[0].audio={...emptyShotAudio(),url:'/api/assets/00000000-0000-0000-0000-000000000001',duration:6.8,sourceText:'你好',sourceVoice:'female',sourceInstruction:''};
  const rebased=rebaseProjectEdits(local,remote);
  assert.equal(rebased.shots[0].audioLeadIn,0.3);
  assert.equal(rebased.shots[0].audioTailOut,0.6);
  assert.equal(rebased.shots[0].duration,9);
  assert.deepEqual(rebased.shots[0].audio,remote.shots[0].audio);
  assert.deepEqual(rebased.shots[1],remote.shots[1]);
});
