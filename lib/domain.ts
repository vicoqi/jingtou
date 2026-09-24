import type { Candidate, Project, ProjectSummary, Shot } from './types.ts';

export function newShot(): Shot {
  return { id: crypto.randomUUID(), title: '新镜头', characterIds: [], scene: '', description: '', dialogue: '', duration: 5, candidates: [], selectedCandidateId: null, status: 'idle', error: null, generationId: null, generationStartedAt: null };
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

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const internalImage = (url: unknown): url is string => isString(url) && (/^\/api\/assets\/[a-f0-9-]{36}$/.test(url) || /^\/samples\/(?:summer|linxia|chenyu)\.png$/.test(url));

export function validateProject(value: unknown): asserts value is Project {
  if (!isRecord(value) || !isString(value.id) || !isString(value.name) || !isString(value.description) || !isString(value.style) || !['16:9','9:16'].includes(String(value.aspectRatio)) || !Array.isArray(value.characters) || !Array.isArray(value.shots) || !Number.isInteger(value.revision) || !isString(value.createdAt) || !isString(value.updatedAt)) throw new Error('Invalid project');
  if (value.name.trim().length < 1 || value.name.length > 120 || value.description.length > 5000 || value.style.length > 2000 || value.shots.length > 200 || value.characters.length > 100) throw new Error('Invalid project fields');
  const characterIds = new Set<string>();
  for (const c of value.characters) {
    if (!isRecord(c) || !isString(c.id) || !isString(c.name) || !isString(c.description) || !Array.isArray(c.references) || c.references.length > 20 || c.name.length > 120 || c.description.length > 3000 || characterIds.has(c.id)) throw new Error('Invalid character');
    characterIds.add(c.id);
    for (const ref of c.references) if (!isRecord(ref) || !isString(ref.id) || !isString(ref.name) || !internalImage(ref.url)) throw new Error('Invalid reference image');
  }
  const shotIds = new Set<string>();
  for (const s of value.shots) {
    if (!isRecord(s) || !isString(s.id) || !isString(s.title) || !Array.isArray(s.characterIds) || !isString(s.scene) || !isString(s.description) || !isString(s.dialogue) || !Array.isArray(s.candidates) || s.candidates.length > 200 || !['idle','generating','failed'].includes(String(s.status)) || !(s.error === null || isString(s.error)) || !(s.generationId === null || isString(s.generationId)) || !(s.generationStartedAt === null || isString(s.generationStartedAt)) || shotIds.has(s.id)) throw new Error('Invalid shot');
    shotIds.add(s.id);
    if (!Number.isFinite(s.duration) || Number(s.duration) <= 0 || Number(s.duration) > 600) throw new Error('Invalid shot duration');
    if (s.characterIds.some((id: unknown) => !isString(id) || !characterIds.has(id))) throw new Error('Invalid shot character');
    const candidateIds = new Set<string>();
    for (const c of s.candidates) {
      if (!isRecord(c) || !isString(c.id) || !internalImage(c.url) || !isString(c.createdAt) || !isString(c.prompt) || !isString(c.batchId) || !['generated','uploaded','sample'].includes(String(c.source)) || candidateIds.has(c.id)) throw new Error('Invalid candidate');
      candidateIds.add(c.id);
    }
    if (!(s.selectedCandidateId === null || (isString(s.selectedCandidateId) && candidateIds.has(s.selectedCandidateId)))) throw new Error('Invalid selected candidate');
  }
}

export function mergeGeneration(current: Project, shotId: string, generationId: string, candidates: Candidate[]): Project {
  const shot = current.shots.find(s => s.id === shotId);
  if (!shot || shot.generationId !== generationId || shot.status !== 'generating') throw new Error('Generation superseded');
  return { ...current, shots: current.shots.map(s => s.id === shotId ? { ...s, candidates: [...s.candidates, ...candidates], status: 'idle' as const, error: null, generationId: null, generationStartedAt: null } : s) };
}

export function summarizeProject(project: Project): ProjectSummary {
  const selected = project.shots.map(s => s.candidates.find(c => c.id === s.selectedCandidateId)).filter((c): c is Candidate => !!c);
  return { id: project.id, name: project.name, description: project.description, updatedAt: project.updatedAt, shotCount: project.shots.length, selectedCount: selected.length, duration: project.shots.reduce((n,s) => n + s.duration, 0), cover: selected[0]?.url ?? null };
}
