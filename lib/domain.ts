import type { Candidate, GenerationKind, Project, ProjectSummary, Scene, Shot, ShotAudio } from './types.ts';
import { newId } from './id.ts';

export function emptyShotAudio(): ShotAudio {
  return { url: null, duration: null, sourceText: null, sourceVoice: null, status: 'idle', error: null, generationId: null, generationStartedAt: null };
}

export function newShot(): Shot {
  return { id: newId(), title: '新镜头', characterIds: [], scene: '', sceneId: null, description: '', dialogue: '', duration: 5, speakerCharacterId: null, audio: emptyShotAudio(), candidates: [], selectedCandidateId: null, status: 'idle', error: null, generationId: null, generationStartedAt: null };
}

export function newScene(style = ''): Scene {
  return { id: newId(), name: '', description: '', style, candidates: [], selectedCandidateId: null, status: 'idle', error: null, generationId: null, generationStartedAt: null };
}

export function removeScene(project: Project, id: string): Project {
  return { ...project, scenes: (project.scenes ?? []).filter(s => s.id !== id), shots: project.shots.map(s => s.sceneId === id ? { ...s, sceneId: null } : s) };
}

export function getTimeline(shots: Shot[]): { shot: Shot; start: number; end: number }[] {
  let start = 0;
  return shots.map(shot => {
    const item = { shot, start, end: start + shot.duration };
    start = item.end;
    return item;
  });
}

export function shotAtTime(shots: Shot[], time: number): Shot | null {
  if (!Number.isFinite(time) || time < 0) return null;
  return getTimeline(shots).find(({ start, end }) => time >= start && time < end)?.shot ?? null;
}

export function isShotAudioStale(project:Project,shot:Shot):boolean {
  if (!shot.audio.url) return false;
  const speaker=shot.speakerCharacterId ? project.characters.find(character=>character.id===shot.speakerCharacterId) : null;
  return !speaker || shot.audio.sourceText !== shot.dialogue.trim() || shot.audio.sourceVoice !== speaker.voice;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const internalImage = (url: unknown): url is string => isString(url) && (/^\/api\/assets\/[a-f0-9-]{36}$/.test(url) || /^\/samples\/(?:summer|linxia|chenyu)\.png$/.test(url));
const internalAudio = (url: unknown): url is string => isString(url) && /^\/api\/assets\/[a-f0-9-]{36}$/.test(url);

export function normalizeProject(value: unknown): Project {
  if (!isRecord(value)) return value as Project;
  const characters = Array.isArray(value.characters) ? value.characters.map(character => {
    if (!isRecord(character) || character.voice !== undefined) return character;
    return { ...character, voice: 'female' };
  }) : value.characters;
  const shots = Array.isArray(value.shots) ? value.shots.map(shot => {
    if (!isRecord(shot)) return shot;
    return {
      ...shot,
      speakerCharacterId: shot.speakerCharacterId === undefined ? null : shot.speakerCharacterId,
      audio: shot.audio === undefined ? emptyShotAudio() : shot.audio,
    };
  }) : value.shots;
  return { ...value, scenes: Array.isArray(value.scenes) ? value.scenes : [], characters, shots } as Project;
}

function validateCandidates(value: Record<string, unknown>): void {
  if (!Array.isArray(value.candidates) || value.candidates.length > 200) throw new Error('Invalid candidates');
  const ids = new Set<string>();
  for (const c of value.candidates) {
    if (!isRecord(c) || !isString(c.id) || !internalImage(c.url) || !isString(c.createdAt) || !isString(c.prompt) || !isString(c.batchId) || !['generated','uploaded','sample'].includes(String(c.source)) || ids.has(c.id)) throw new Error('Invalid candidate');
    ids.add(c.id);
  }
  if (!(value.selectedCandidateId === null || (isString(value.selectedCandidateId) && ids.has(value.selectedCandidateId)))) throw new Error('Invalid selected candidate');
}

export function validateProject(value: unknown): asserts value is Project {
  if (!isRecord(value) || !isString(value.id) || !isString(value.name) || !isString(value.description) || !isString(value.style) || !['16:9','9:16'].includes(String(value.aspectRatio)) || !Array.isArray(value.characters) || !Array.isArray(value.shots) || !Number.isInteger(value.revision) || !isString(value.createdAt) || !isString(value.updatedAt)) throw new Error('Invalid project');
  if (value.name.trim().length < 1 || value.name.length > 120 || value.description.length > 5000 || value.style.length > 2000 || value.shots.length > 200 || value.characters.length > 100) throw new Error('Invalid project fields');
  const characterIds = new Set<string>();
  for (const c of value.characters) {
    if (!isRecord(c) || !isString(c.id) || !isString(c.name) || !isString(c.description) || !['female','male'].includes(String(c.voice)) || !Array.isArray(c.references) || c.references.length > 20 || c.name.length > 120 || c.description.length > 3000 || characterIds.has(c.id)) throw new Error('Invalid character');
    characterIds.add(c.id);
    for (const ref of c.references) if (!isRecord(ref) || !isString(ref.id) || !isString(ref.name) || !internalImage(ref.url)) throw new Error('Invalid reference image');
  }
  if (value.scenes !== undefined && (!Array.isArray(value.scenes) || value.scenes.length > 100)) throw new Error('Invalid scenes');
  const sceneIds = new Set<string>();
  for (const s of (value.scenes ?? []) as unknown[]) {
    if (!isRecord(s) || !isString(s.id) || !isString(s.name) || !s.name.trim() || s.name.length > 120 || !isString(s.description) || s.description.length > 4000 || !(s.style === undefined || (isString(s.style) && s.style.length <= 2000)) || sceneIds.has(s.id) || !['idle','generating','failed'].includes(String(s.status)) || !(s.error === null || isString(s.error)) || !(s.generationId === null || isString(s.generationId)) || !(s.generationStartedAt === null || isString(s.generationStartedAt))) throw new Error('Invalid scene');
    sceneIds.add(s.id);
    validateCandidates(s);
  }
  const shotIds = new Set<string>();
  for (const s of value.shots) {
    if (!isRecord(s) || !isString(s.id) || !isString(s.title) || !Array.isArray(s.characterIds) || !isString(s.scene) || !isString(s.description) || !isString(s.dialogue) || !Array.isArray(s.candidates) || s.candidates.length > 200 || !['idle','generating','failed'].includes(String(s.status)) || !(s.error === null || isString(s.error)) || !(s.generationId === null || isString(s.generationId)) || !(s.generationStartedAt === null || isString(s.generationStartedAt)) || shotIds.has(s.id)) throw new Error('Invalid shot');
    shotIds.add(s.id);
    if (!Number.isFinite(s.duration) || Number(s.duration) <= 0 || Number(s.duration) > 600) throw new Error('Invalid shot duration');
    if (s.characterIds.some((id: unknown) => !isString(id) || !characterIds.has(id))) throw new Error('Invalid shot character');
    if (!(s.speakerCharacterId === null || (isString(s.speakerCharacterId) && s.characterIds.includes(s.speakerCharacterId)))) throw new Error('Invalid shot speaker');
    if (s.sceneId !== undefined && s.sceneId !== null && (!isString(s.sceneId) || !sceneIds.has(s.sceneId))) throw new Error('Invalid shot scene');
    if (!isRecord(s.audio) || !['idle','generating','failed'].includes(String(s.audio.status)) || !(s.audio.url === null || internalAudio(s.audio.url)) || !(s.audio.duration === null || (Number.isFinite(s.audio.duration) && Number(s.audio.duration) > 0 && Number(s.audio.duration) <= 3600)) || !(s.audio.sourceText === null || (isString(s.audio.sourceText) && s.audio.sourceText.length <= 1000)) || !(s.audio.sourceVoice === null || ['female','male'].includes(String(s.audio.sourceVoice))) || !(s.audio.error === null || isString(s.audio.error)) || !(s.audio.generationId === null || isString(s.audio.generationId)) || !(s.audio.generationStartedAt === null || isString(s.audio.generationStartedAt))) throw new Error('Invalid shot audio');
    if (s.audio.url !== null && (s.audio.duration === null || s.audio.sourceText === null || s.audio.sourceVoice === null)) throw new Error('Invalid shot audio');
    if (s.audio.url === null && (s.audio.duration !== null || s.audio.sourceText !== null || s.audio.sourceVoice !== null)) throw new Error('Invalid shot audio');
    if (s.audio.status === 'generating' && (!s.audio.generationId || !s.audio.generationStartedAt)) throw new Error('Invalid shot audio generation');
    validateCandidates(s);
  }
}

export function mergeGeneration(current: Project, shotId: string, generationId: string, candidates: Candidate[], kind: GenerationKind = 'shots'): Project {
  const items = current[kind] ?? [];
  const shot = items.find(s => s.id === shotId);
  if (!shot || shot.generationId !== generationId || shot.status !== 'generating') throw new Error('Generation superseded');
  if (shot.candidates.length + candidates.length > 200) throw new Error('Too many candidates');
  return { ...current, [kind]: items.map(s => s.id === shotId ? { ...s, candidates: [...s.candidates, ...candidates], status: 'idle' as const, error: null, generationId: null, generationStartedAt: null } : s) };
}

export function summarizeProject(project: Project): ProjectSummary {
  const selected = project.shots.map(s => s.candidates.find(c => c.id === s.selectedCandidateId)).filter((c): c is Candidate => !!c);
  return { id: project.id, name: project.name, description: project.description, updatedAt: project.updatedAt, shotCount: project.shots.length, selectedCount: selected.length, duration: project.shots.reduce((n,s) => n + s.duration, 0), cover: selected[0]?.url ?? null };
}
