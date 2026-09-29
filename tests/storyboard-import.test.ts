import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStoryboardDraft } from '../lib/storyboard-import.ts';
import { newStoryboardDraft, validateProject } from '../lib/domain.ts';
import type { Character, Project, StoryboardDraft } from '../lib/types.ts';

const character = (id: string, name: string): Character => ({ id, name, description: `desc-${name}`, voice: 'male', references: [] });
const baseProject = (characters: Character[] = [], shotCount = 0): Project => ({
  id: 'p1', name: '作品', description: '', aspectRatio: '16:9', style: '', characters,
  shots: Array.from({ length: shotCount }, (_, i) => ({ id: `s${i}`, title: `镜头${i}`, characterIds: [], scene: '', description: '', dialogue: '', showSubtitle: true, voiceInstruction: '', duration: 5, audioLeadIn: 0, audioTailOut: 0, speakerCharacterId: null, audio: { url: null, duration: null, sourceText: null, sourceVoice: null, sourceInstruction: null, status: 'idle' as const, error: null, generationId: null, generationStartedAt: null }, candidates: [], selectedCandidateId: null, status: 'idle' as const, error: null, generationId: null, generationStartedAt: null })),
  revision: 1, createdAt: '', updatedAt: '',
});

const draft = (): StoryboardDraft => ({
  ...newStoryboardDraft('林夏与陈屿在车站重逢。', 2, 'gen-1'),
  status: 'ready', generationId: null, generationStartedAt: null,
  characters: [{ name: '林夏', description: '深蓝短发少女' }, { name: '路人甲', description: '背景人物' }],
  shots: [
    { title: '', scene: '海边车站', description: '夕阳全景', dialogue: '你来了。', duration: 3, speaker: '林夏', characters: ['林夏'] },
    { title: '特写', scene: '海边车站', description: '陈屿特写', dialogue: '', duration: 4, speaker: '陈屿', characters: [] },
    { title: '删除我', scene: 'x', description: 'x', dialogue: '', duration: 1, speaker: null, characters: ['路人甲'] },
  ],
});

test('imports kept shots, reuses same-name characters, and backfills speaker into characterIds', () => {
  const existing = character('c1', '林夏');
  const result = applyStoryboardDraft(baseProject([existing]), draft(), [0, 1]);
  const { project, insertedShotIds } = result;
  assert.equal(project.shots.length, 2);
  assert.equal(project.storyboardDraft, null);
  assert.equal(project.characters.length, 2, '林夏复用 + 陈屿新建，路人甲不建');
  const linxia = project.characters.find(c => c.name === '林夏')!;
  assert.equal(linxia.id, 'c1', '同名复用已有角色');
  const chenyu = project.characters.find(c => c.name === '陈屿')!;
  assert.equal(chenyu.voice, 'female');
  assert.equal(chenyu.description, '');
  assert.equal(project.shots[0].title, '镜头 1', '空标题回退');
  assert.equal(project.shots[0].speakerCharacterId, linxia.id);
  assert.deepEqual(project.shots[0].characterIds, [linxia.id]);
  assert.equal(project.shots[1].speakerCharacterId, chenyu.id);
  assert.deepEqual(project.shots[1].characterIds, [chenyu.id], 'speaker 补进出场角色');
  assert.deepEqual(insertedShotIds, project.shots.map(s => s.id));
  assert.doesNotThrow(() => validateProject({ ...project, revision: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));
});

test('matches names case-insensitively after trim and rejects limit overflow', () => {
  const existing = character('c1', 'Lin Xia');
  const d = draft();
  d.shots[0].characters = [' LIN xia '];
  d.shots[0].speaker = ' LIN xia ';
  const result = applyStoryboardDraft(baseProject([existing]), d, [0]);
  assert.equal(result.project.characters.length, 1);
  assert.equal(result.project.shots[0].speakerCharacterId, 'c1');

  assert.throws(() => applyStoryboardDraft(baseProject([], 199), draft(), [0, 1]), /200/);
  const manyCharacters = Array.from({ length: 100 }, (_, i) => character(`c${i}`, `角色${i}`));
  assert.throws(() => applyStoryboardDraft(baseProject(manyCharacters), draft(), [0]), /100/);
});
