import test from 'node:test';
import assert from 'node:assert/strict';
import * as domain from '../lib/domain.ts';
import * as generation from '../lib/generation.ts';
import { createProject } from '../lib/sample.ts';

const candidate = (id: string) => ({ id, url: '/samples/summer.png', prompt: '', batchId: '', createdAt: '', source: 'uploaded' as const });
const scene = () => ({ id: 'station', name: '海边车站', description: '蓝色长椅，白色站棚，夕阳下的大海', candidates: [candidate('old')], selectedCandidateId: 'old', status: 'idle' as 'idle' | 'generating', error: null, generationId: null as string | null, generationStartedAt: null as string | null });

test('scene documents validate and legacy projects without scenes remain valid', () => {
  const p = { ...createProject('Scenes'), scenes: [scene()] };
  p.shots.push({ ...domain.newShot(), sceneId: 'station' });
  assert.doesNotThrow(() => domain.validateProject(p));
  assert.throws(() => domain.validateProject({ ...p, scenes: 'invalid' }), /scene/i);
  assert.throws(() => domain.validateProject({ ...p, scenes: [scene(), scene()] }), /scene/i);
  assert.throws(() => domain.validateProject({ ...p, scenes: [{ ...scene(), selectedCandidateId: 'missing' }] }), /selected/i);
  assert.throws(() => domain.validateProject({ ...p, scenes: [{ ...scene(), candidates: [{ ...candidate('old'), url: 'https://foreign.example/image.png' }] }] }), /candidate/i);
  assert.throws(() => domain.validateProject({ ...p, scenes: [{ ...scene(), style: 42 }] }), /scene/i);
  assert.throws(() => domain.validateProject({ ...p, scenes: [{ ...scene(), style: 'x'.repeat(2001) }] }), /scene/i);
  assert.throws(() => domain.validateProject({ ...p, scenes: [] }), /scene/i);
  const legacy = createProject('Legacy');
  delete legacy.scenes;
  legacy.shots.push(domain.newShot());
  delete legacy.shots[0].sceneId;
  assert.doesNotThrow(() => domain.validateProject(legacy));
});

test('new scenes can start with the project style', () => {
  assert.equal(domain.newScene('水彩绘本').style, '水彩绘本');
});

test('deleting a scene removes links but preserves shot text, candidates and selection', () => {
  const p = { ...createProject('Scenes'), scenes: [scene()] };
  p.shots.push({ ...domain.newShot(), sceneId: 'station', scene: '黄昏', candidates: [candidate('frame')], selectedCandidateId: 'frame' });
  const removed = domain.removeScene(p, 'station');
  assert.deepEqual(removed.scenes, []);
  assert.deepEqual(removed.shots[0], { ...p.shots[0], sceneId: null });
  assert.equal(p.scenes.length, 1);
});

test('scene generation merges history without replacing selection or other shots', () => {
  const p = { ...createProject('Scenes'), scenes: [{ ...scene(), status: 'generating' as const, generationId: 'job' }, { ...scene(), id: 'other' }] };
  p.shots.push(domain.newShot());
  const merged = domain.mergeGeneration(p, 'station', 'job', [candidate('new')], 'scenes');
  assert.deepEqual(merged.scenes![0].candidates.map(c => c.id), ['old', 'new']);
  assert.equal(merged.scenes![0].selectedCandidateId, 'old');
  assert.equal(merged.scenes![0].status, 'idle');
  assert.deepEqual(merged.scenes![1], p.scenes[1]);
  assert.deepEqual(merged.shots, p.shots);
  assert.throws(() => domain.mergeGeneration(p, 'station', 'superseded', [], 'scenes'), /superseded/i);
});

test('scene generation falls back to project style and asks for an unoccupied environment', () => {
  const p = createProject('Scene', false, '电影写实摄影');
  const prompt = generation.buildScenePrompt(p, scene());
  assert.match(prompt, /电影写实摄影/);
  assert.match(prompt, /蓝色长椅/);
  assert.match(prompt, /no people/i);
  assert.doesNotMatch(prompt, /anime|animated/i);
});

test('scene generation prefers the scene style over the project style', () => {
  const p = createProject('Scene', false, '国风动漫');
  const prompt = generation.buildScenePrompt(p, { ...scene(), style: '真人电影写实摄影' });
  assert.match(prompt, /真人电影写实摄影/);
  assert.doesNotMatch(prompt, /国风动漫/);
});

test('shot prompt and references put scene after all character images and use current settings', () => {
  const p = { ...createProject('Scene'), scenes: [scene()] };
  p.characters.push({ id: 'c', name: '林夏', description: '蓝色短发', references: [
    { id: 'r1', name: 'front', url: '/samples/linxia.png' }, { id: 'r2', name: 'side', url: '/samples/chenyu.png' },
  ] });
  const shot = { ...domain.newShot(), characterIds: ['c'], sceneId: 'station', scene: '下雨' };
  const prompt = generation.buildShotPrompt(p, shot);
  assert.match(prompt, /reference images 1–2/);
  assert.match(prompt, /海边车站.*reference image 3/);
  assert.match(prompt, /蓝色长椅/);
  assert.match(prompt, /下雨/);
  assert.deepEqual(generation.shotReferenceUrls(p, shot), ['/samples/linxia.png', '/samples/chenyu.png', '/samples/summer.png']);
  p.scenes[0].description = '红色长椅';
  assert.match(generation.buildShotPrompt(p, shot), /红色长椅/);
  assert.deepEqual(generation.shotReferenceUrls(p, { ...shot, characterIds: [] }), ['/samples/summer.png']);
  p.scenes[0].selectedCandidateId = 'missing';
  assert.throws(() => generation.buildShotPrompt(p, shot), /选.*场景|场景.*选/);
  assert.throws(() => generation.shotReferenceUrls(p, shot), /选.*场景|场景.*选/);
});
