import type { Candidate, GeneratedFrame, GenerationKind, Project, ProjectSummary, Scene, Shot, ShotAudio, ShotVideo, StoryboardDraft, VideoCandidate, VideoSource } from './types.ts';
import { newId } from './id.ts';
import { MAX_PAUSE_DURATION, MAX_SHOT_DURATION } from './shot-timing.ts';
import { getVideoFrameContext, isVideoFrameLocked } from './video-frames.ts';
import { validVideoTrim } from './video-trim.ts';

export const MAX_STORY_LENGTH = 20_000;
export const MIN_REQUESTED_SHOTS = 4;
export const MAX_REQUESTED_SHOTS = 60;

export function emptyShotAudio(): ShotAudio {
  return { url: null, duration: null, sourceText: null, sourceVoice: null, sourceInstruction: null, status: 'idle', error: null, generationId: null, generationStartedAt: null };
}

export function emptyShotVideo(): ShotVideo {
  return { candidates: [], selectedVideoId: null, taskId: null, polledAt: null, source: null, status: 'idle', error: null, generationId: null, generationStartedAt: null };
}

export function newShot(): Shot {
  return { id: newId(), title: '新镜头', characterIds: [], scene: '', sceneId: null, description: '', endFrameDescription: '', selectedEndCandidateId: null, dialogue: '', showSubtitle: true, voiceInstruction: '', duration: 5, audioLeadIn: 0, audioTailOut: 0, speakerCharacterId: null, audio: emptyShotAudio(), video: emptyShotVideo(), candidates: [], selectedCandidateId: null, status: 'idle', error: null, generationId: null, generationStartedAt: null };
}

export function newScene(style = ''): Scene {
  return { id: newId(), name: '', description: '', style, candidates: [], selectedCandidateId: null, status: 'idle', error: null, generationId: null, generationStartedAt: null };
}

export function newStoryboardDraft(story: string, requestedCount: number | null, generationId: string): StoryboardDraft {
  return { status: 'generating', error: null, generationId, generationStartedAt: new Date().toISOString(), story, requestedCount, characters: [], shots: [] };
}

export const MAX_VIDEO_CANDIDATES = 20;

export const STALE_STORYBOARD_MS = 10 * 60 * 1000;
// wan3.0 video tasks run minutes (official examples up to 12); stale recovery for
// video is driven by DashScope task polling in server.ts rather than this cutoff.
export const STALE_VIDEO_MS = 25 * 60 * 1000;

export function recoverStoryboardDraft(project: Project, now = Date.now()): Project | null {
  const draft = project.storyboardDraft;
  if (!draft || draft.status !== 'generating' || !draft.generationStartedAt || now - Date.parse(draft.generationStartedAt) <= STALE_STORYBOARD_MS) return null;
  return { ...project, storyboardDraft: { ...draft, status: 'failed', error: '故事拆分已中断，请重试。', generationId: null, generationStartedAt: null } };
}

export function removeScene(project: Project, id: string): Project {
  return { ...project, scenes: (project.scenes ?? []).filter(s => s.id !== id), shots: project.shots.map(s => s.sceneId === id ? { ...s, sceneId: null } : s) };
}

export function generationDeletionConflict(current:Project,proposed:Project):string|null {
  for (const shot of current.shots) {
    if ((shot.status==='generating' || shot.audio.status==='generating' || shot.video.status==='generating') && !proposed.shots.some(item=>item.id===shot.id)) return '生成期间不能删除正在生成的镜头，请等待生成完成。';
  }
  for (const scene of current.scenes ?? []) {
    if (scene.status==='generating' && !proposed.scenes?.some(item=>item.id===scene.id)) return '生成期间不能删除正在生成的场景，请等待生成完成。';
  }
  return null;
}

// Selected candidates anchor validateProject's selected-id rule; generated
// takes keep referencing their source frames for posters; any running image or
// video job locks the list. Only truly unreferenced ones may be removed.
export function isShotCandidateRemovable(project: Project, shot: Shot, candidateId: string): boolean {
  if (shot.status === 'generating' || isVideoFrameLocked(project, shot.id)) return false;
  if (candidateId === shot.selectedCandidateId || candidateId === shot.selectedEndCandidateId) return false;
  return !shot.video.candidates.some(take => take.sourceFirstFrameId === candidateId || take.sourceLastFrameId === candidateId);
}

export function isSceneCandidateRemovable(scene: Scene, candidateId: string): boolean {
  if (scene.status === 'generating') return false;
  return candidateId !== scene.selectedCandidateId;
}

export function isVideoCandidateRemovable(shot: Shot, videoId: string): boolean {
  if (shot.video.status === 'generating') return false;
  return videoId !== shot.video.selectedVideoId;
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
  return !speaker || shot.audio.sourceText !== shot.dialogue.trim() || shot.audio.sourceVoice !== speaker.voice || shot.audio.sourceInstruction !== shot.voiceInstruction.trim();
}

// Compact fingerprint of the shot inputs a video is generated from. Equal keys mean the
// stored video still matches the current description/dialogue/duration — hashing keeps
// per-candidate snapshots at ~20 bytes instead of full text copies.
export function videoSourceKey(description:string,dialogue:string,duration:number):string {
  const input=`${description}\u0000${dialogue}\u0000${duration}`;
  let h1=0x811c9dc5,h2=0x9e3779b9;
  for (let i=0;i<input.length;i++) {
    const code=input.charCodeAt(i);
    h1=Math.imul(h1^code,0x01000193)>>>0;
    h2=Math.imul(h2+code,0x85ebca6b)>>>0;
  }
  return h1.toString(16).padStart(8,'0')+h2.toString(16).padStart(8,'0');
}

export function shotVideoSource(project: Project, shot: Shot): VideoSource {
  const { currentFrame, endFrame } = getVideoFrameContext(project, shot);
  const speaker = project.characters.find(character => character.id === shot.speakerCharacterId);
  return {
    sourceMode: 'independent',
    sourceFirstFrameId: currentFrame?.id ?? '',
    sourceLastFrameId: endFrame?.id ?? '',
    sourceDuration: shot.duration,
    sourceKey: videoSourceKey(JSON.stringify([
      'independent-frames-v1', currentFrame?.id ?? '', currentFrame?.url ?? '', endFrame?.id ?? '', endFrame?.url ?? '',
      project.style.trim(), project.aspectRatio, shot.description.trim(), shot.dialogue.trim(), shot.duration,
      shot.dialogue.trim() ? [shot.speakerCharacterId, speaker?.name ?? '', shot.voiceInstruction.trim()] : null, shot.audioLeadIn,
    ]), '', shot.duration),
  };
}

// Preserve the original fingerprint for videos and tasks made before independent
// frames. Reading an old project must not change its existing video selections.
function legacyChainedVideoSource(project: Project, shot: Shot): VideoSource {
  const { previousShot, previousFrame, currentFrame } = getVideoFrameContext(project, shot);
  const firstFrame = previousFrame;
  const lastFrame = currentFrame;
  const speaker = project.characters.find(character => character.id === shot.speakerCharacterId);
  return {
    sourceFirstFrameId: firstFrame?.id ?? '',
    sourceLastFrameId: lastFrame?.id ?? '',
    sourcePreviousShotId: previousShot?.id ?? '',
    sourceDuration: shot.duration,
    sourceKey: videoSourceKey(JSON.stringify([
      'frame-chain-v1', previousShot?.id ?? '', firstFrame?.id ?? '', firstFrame?.url ?? '', lastFrame?.id ?? '', lastFrame?.url ?? '',
      project.style.trim(), project.aspectRatio, shot.description.trim(), shot.dialogue.trim(), shot.duration,
      shot.dialogue.trim() ? [shot.speakerCharacterId, speaker?.name ?? '', shot.voiceInstruction.trim()] : null, shot.audioLeadIn,
    ]), '', shot.duration),
  };
}

export function isShotVideoStale(shot:Shot,project?:Project):boolean {
  const video=shot.video;
  const selected=video.candidates.find(candidate=>candidate.id===video.selectedVideoId);
  if (!selected) return false;
  if (selected.sourceMode === 'independent') {
    if (!project) return true;
    const source = shotVideoSource(project, shot);
    return selected.sourceFirstFrameId !== source.sourceFirstFrameId
      || selected.sourceLastFrameId !== source.sourceLastFrameId || selected.sourceKey !== source.sourceKey;
  }
  if (selected.sourceLastFrameId !== undefined || selected.sourcePreviousShotId !== undefined) {
    if (!project) return true;
    const source = legacyChainedVideoSource(project, shot);
    return !!shot.selectedEndCandidateId || selected.sourceFirstFrameId !== source.sourceFirstFrameId
      || selected.sourceLastFrameId !== source.sourceLastFrameId
      || selected.sourcePreviousShotId !== source.sourcePreviousShotId
      || selected.sourceKey !== source.sourceKey;
  }
  return !!shot.selectedEndCandidateId || selected.sourceFirstFrameId !== (shot.selectedCandidateId ?? '')
    || selected.sourceKey !== videoSourceKey(shot.description.trim(),shot.dialogue.trim(),shot.duration);
}

export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const internalImage = (url: unknown): url is string => isString(url) && (/^\/api\/assets\/[a-f0-9-]{36}$/.test(url) || /^\/samples\/(?:summer|linxia|chenyu)\.png$/.test(url));
const internalAssetUrl = (url: unknown): url is string => isString(url) && /^\/api\/assets\/[a-f0-9-]{36}$/.test(url);

function validVideoSource(value: unknown): boolean {
  return isRecord(value)
    && (value.sourceMode === undefined || value.sourceMode === 'independent')
    && isString(value.sourceFirstFrameId) && value.sourceFirstFrameId.length <= 200
    && (value.sourceLastFrameId === undefined || (isString(value.sourceLastFrameId) && value.sourceLastFrameId.length <= 200))
    && (value.sourcePreviousShotId === undefined || (isString(value.sourcePreviousShotId) && value.sourcePreviousShotId.length <= 200))
    && (value.sourceDuration === undefined || (typeof value.sourceDuration === 'number' && Number.isFinite(value.sourceDuration) && value.sourceDuration > 0 && value.sourceDuration <= MAX_SHOT_DURATION))
    && isString(value.sourceKey) && /^[0-9a-f]{16}$/.test(value.sourceKey);
}

const normalizeTombstones = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value) || !value.length) return undefined;
  const ids = value.filter(isString);
  return ids.length ? ids : undefined;
};

function normalizeShotVideo(value: unknown): ShotVideo {
  const { removedCandidateIds, ...rest } = { ...emptyShotVideo(), ...(isRecord(value) ? value : {}) } as ShotVideo;
  const tombstones = normalizeTombstones(removedCandidateIds);
  const base = { ...rest, ...(tombstones ? { removedCandidateIds: tombstones } : {}) } as ShotVideo & { candidates: unknown[] };
  // Candidates written before source keys stored full text snapshots; fold them into the
  // compact key on read so oversized documents shrink below D1's 1MB row limit.
  base.candidates = base.candidates.map((candidate: unknown): VideoCandidate => {
    if (!isRecord(candidate) || typeof candidate.sourceKey === 'string' || !isString(candidate.url)) return candidate as unknown as VideoCandidate;
    return {
      id: isString(candidate.id) ? candidate.id : newId(),
      url: candidate.url,
      createdAt: isString(candidate.createdAt) ? candidate.createdAt : new Date().toISOString(),
      duration: typeof candidate.duration === 'number' && Number.isFinite(candidate.duration) ? candidate.duration : null,
      sourceFirstFrameId: isString(candidate.sourceFirstFrameId) ? candidate.sourceFirstFrameId : '',
      sourceKey: videoSourceKey(isString(candidate.sourceDescription) ? candidate.sourceDescription : '', isString(candidate.sourceDialogue) ? candidate.sourceDialogue : '', typeof candidate.sourceDuration === 'number' && Number.isFinite(candidate.sourceDuration) ? candidate.sourceDuration : 0),
    };
  });
  return base;
}

export function normalizeProject(value: unknown): Project {
  if (!isRecord(value)) return value as Project;
  const characters = Array.isArray(value.characters) ? value.characters.map(character => {
    if (!isRecord(character) || character.voice !== undefined) return character;
    return { ...character, voice: 'female' };
  }) : value.characters;
  const shots = Array.isArray(value.shots) ? value.shots.map(shot => {
    if (!isRecord(shot)) return shot;
    const audio = shot.audio === undefined
      ? emptyShotAudio()
      : isRecord(shot.audio) && shot.audio.sourceInstruction === undefined
        ? { ...shot.audio, sourceInstruction: shot.audio.url ? '' : null }
        : shot.audio;
    const video = normalizeShotVideo(shot.video);
    const { removedCandidateIds, ...rest } = shot;
    const tombstones = normalizeTombstones(removedCandidateIds);
    return {
      ...rest,
      ...(tombstones ? { removedCandidateIds: tombstones } : {}),
      showSubtitle: shot.showSubtitle === undefined ? true : shot.showSubtitle,
      voiceInstruction: shot.voiceInstruction === undefined ? '' : shot.voiceInstruction,
      endFrameDescription: shot.endFrameDescription === undefined ? '' : shot.endFrameDescription,
      selectedEndCandidateId: shot.selectedEndCandidateId === undefined ? null : shot.selectedEndCandidateId,
      audioLeadIn: shot.audioLeadIn === undefined ? 0 : shot.audioLeadIn,
      audioTailOut: shot.audioTailOut === undefined ? 0 : shot.audioTailOut,
      speakerCharacterId: shot.speakerCharacterId === undefined ? null : shot.speakerCharacterId,
      audio,
      video,
    };
  }) : value.shots;
  const scenes = Array.isArray(value.scenes) ? value.scenes.map(scene => {
    if (!isRecord(scene)) return scene;
    const { removedCandidateIds, ...rest } = scene;
    const tombstones = normalizeTombstones(removedCandidateIds);
    return tombstones ? { ...rest, removedCandidateIds: tombstones } : rest;
  }) : [];
  return { ...value, scenes, characters, shots, storyboardDraft: value.storyboardDraft === undefined ? null : value.storyboardDraft } as Project;
}

function assertSelectedId(selected: unknown, ids: Set<string>, label: string): void {
  if (!(selected === null || (isString(selected) && ids.has(selected)))) throw new Error(label);
}

function validateTombstones(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 400 || value.some(id => !isString(id))) throw new Error('Invalid removed candidate ids');
}

function validateCandidates(value: Record<string, unknown>): void {
  if (!Array.isArray(value.candidates) || value.candidates.length > 200) throw new Error('Invalid candidates');
  const ids = new Set<string>();
  for (const c of value.candidates) {
    if (!isRecord(c) || !isString(c.id) || !internalImage(c.url) || !isString(c.createdAt) || !isString(c.prompt) || !isString(c.batchId) || !['generated','uploaded','sample'].includes(String(c.source)) || ids.has(c.id)) throw new Error('Invalid candidate');
    if (c.frame !== undefined && !['start', 'end'].includes(String(c.frame))) throw new Error('Invalid candidate frame');
    ids.add(c.id);
  }
  assertSelectedId(value.selectedCandidateId, ids, 'Invalid selected candidate');
  validateTombstones(value.removedCandidateIds);
}

function validateStoryboardDraft(value: unknown): void {
  if (value === null || value === undefined) return;
  if (!isRecord(value) || !['generating', 'ready', 'failed'].includes(String(value.status))) throw new Error('Invalid storyboard draft');
  if (!(value.error === null || isString(value.error) && value.error.length <= 500)) throw new Error('Invalid storyboard draft');
  if (!(value.generationId === null || isString(value.generationId))) throw new Error('Invalid storyboard draft');
  if (!(value.generationStartedAt === null || isString(value.generationStartedAt))) throw new Error('Invalid storyboard draft');
  if (!isString(value.story) || !value.story.trim() || value.story.length > MAX_STORY_LENGTH) throw new Error('Invalid storyboard draft');
  if (!(value.requestedCount === null || (Number.isInteger(value.requestedCount) && (value.requestedCount as number) >= MIN_REQUESTED_SHOTS && (value.requestedCount as number) <= MAX_REQUESTED_SHOTS))) throw new Error('Invalid storyboard draft');
  if (!Array.isArray(value.characters) || value.characters.length > 20) throw new Error('Invalid storyboard draft');
  for (const c of value.characters as unknown[]) if (!isRecord(c) || !isString(c.name) || !c.name.trim() || c.name.length > 120 || !isString(c.description) || c.description.length > 3000) throw new Error('Invalid storyboard draft');
  if (!Array.isArray(value.shots) || value.shots.length > 60) throw new Error('Invalid storyboard draft');
  for (const s of value.shots as unknown[]) {
    if (!isRecord(s) || !isString(s.title) || s.title.length > 120 || !isString(s.scene) || s.scene.length > 500 || !isString(s.description) || s.description.length > 4000 || !isString(s.dialogue) || s.dialogue.length > 600 || !(s.speaker === null || (isString(s.speaker) && !!s.speaker.trim())) || !Array.isArray(s.characters) || (s.characters as unknown[]).some(n => !isString(n) || !n.trim())) throw new Error('Invalid storyboard draft');
    if (!Number.isFinite(s.duration) || Number(s.duration) <= 0 || Number(s.duration) > MAX_SHOT_DURATION) throw new Error('Invalid storyboard draft');
  }
  if (value.status === 'generating' && (!isString(value.generationId) || !isString(value.generationStartedAt))) throw new Error('Invalid storyboard draft generation');
  if (value.status !== 'generating' && (value.generationId !== null || value.generationStartedAt !== null)) throw new Error('Invalid storyboard draft generation');
  if (value.status !== 'ready' && ((value.shots as unknown[]).length || (value.characters as unknown[]).length)) throw new Error('Invalid storyboard draft');
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
  validateStoryboardDraft((value as Record<string, unknown>).storyboardDraft ?? null);
  const shotIds = new Set<string>();
  for (const s of value.shots) {
    if (!isRecord(s) || !isString(s.id) || !isString(s.title) || !Array.isArray(s.characterIds) || !isString(s.scene) || !isString(s.description) || !isString(s.dialogue) || typeof s.showSubtitle !== 'boolean' || !isString(s.voiceInstruction) || s.voiceInstruction.length > 500 || !Array.isArray(s.candidates) || s.candidates.length > 200 || !['idle','generating','failed'].includes(String(s.status)) || !(s.error === null || isString(s.error)) || !(s.generationId === null || isString(s.generationId)) || !(s.generationStartedAt === null || isString(s.generationStartedAt)) || shotIds.has(s.id)) throw new Error('Invalid shot');
    shotIds.add(s.id);
    if (s.endFrameDescription !== undefined && (!isString(s.endFrameDescription) || s.endFrameDescription.length > 4000)) throw new Error('Invalid end frame description');
    if (s.generationFrame !== undefined && !['start', 'end'].includes(String(s.generationFrame))) throw new Error('Invalid image generation frame');
    if (!Number.isFinite(s.duration) || Number(s.duration) <= 0 || Number(s.duration) > MAX_SHOT_DURATION) throw new Error('Invalid shot duration');
    if ([s.audioLeadIn,s.audioTailOut].some(pause=>typeof pause!=='number' || !Number.isFinite(pause) || pause<0 || pause>MAX_PAUSE_DURATION)) throw new Error('Invalid dialogue pause');
    if (s.characterIds.some((id: unknown) => !isString(id) || !characterIds.has(id))) throw new Error('Invalid shot character');
    if (!(s.speakerCharacterId === null || (isString(s.speakerCharacterId) && s.characterIds.includes(s.speakerCharacterId)))) throw new Error('Invalid shot speaker');
    if (s.sceneId !== undefined && s.sceneId !== null && (!isString(s.sceneId) || !sceneIds.has(s.sceneId))) throw new Error('Invalid shot scene');
    if (!isRecord(s.audio) || !['idle','generating','failed'].includes(String(s.audio.status)) || !(s.audio.url === null || internalAssetUrl(s.audio.url)) || !(s.audio.duration === null || (Number.isFinite(s.audio.duration) && Number(s.audio.duration) > 0 && Number(s.audio.duration) <= 3600)) || !(s.audio.sourceText === null || (isString(s.audio.sourceText) && s.audio.sourceText.length <= 1000)) || !(s.audio.sourceVoice === null || ['female','male'].includes(String(s.audio.sourceVoice))) || !(s.audio.sourceInstruction === null || (isString(s.audio.sourceInstruction) && s.audio.sourceInstruction.length <= 500)) || !(s.audio.error === null || isString(s.audio.error)) || !(s.audio.generationId === null || isString(s.audio.generationId)) || !(s.audio.generationStartedAt === null || isString(s.audio.generationStartedAt))) throw new Error('Invalid shot audio');
    if (s.audio.url !== null && (s.audio.duration === null || s.audio.sourceText === null || s.audio.sourceVoice === null || s.audio.sourceInstruction === null)) throw new Error('Invalid shot audio');
    if (s.audio.url === null && (s.audio.duration !== null || s.audio.sourceText !== null || s.audio.sourceVoice !== null || s.audio.sourceInstruction !== null)) throw new Error('Invalid shot audio');
    if (s.audio.status === 'generating' && (!s.audio.generationId || !s.audio.generationStartedAt)) throw new Error('Invalid shot audio generation');
    const v = s.video;
    if (!isRecord(v) || !Array.isArray(v.candidates) || v.candidates.length > MAX_VIDEO_CANDIDATES || !['idle','generating','failed'].includes(String(v.status)) || !(v.taskId === null || isString(v.taskId)) || !(v.polledAt === null || isString(v.polledAt)) || !(v.error === null || isString(v.error)) || !(v.generationId === null || isString(v.generationId)) || !(v.generationStartedAt === null || isString(v.generationStartedAt))) throw new Error('Invalid shot video');
    validateTombstones(v.removedCandidateIds);
    if (v.source !== undefined && v.source !== null && !validVideoSource(v.source)) throw new Error('Invalid shot video source');
    const videoIds = new Set<string>();
    for (const c of v.candidates as unknown[]) {
      if (!isRecord(c) || !isString(c.id) || !internalAssetUrl(c.url) || !isString(c.createdAt) || !(c.duration === null || (Number.isFinite(c.duration) && Number(c.duration) > 0 && Number(c.duration) <= 3600)) || !validVideoSource(c) || videoIds.has(c.id)) throw new Error('Invalid shot video');
      if ((c.trimStart !== undefined && typeof c.trimStart !== 'number') || (c.trimEnd !== undefined && typeof c.trimEnd !== 'number') || !validVideoTrim(c as VideoCandidate)) throw new Error('视频裁剪时间无效，请至少保留 0.1 秒。');
      videoIds.add(c.id);
    }
    assertSelectedId(v.selectedVideoId, videoIds, 'Invalid shot video');
    if (v.status === 'generating' && (!v.generationId || !v.generationStartedAt)) throw new Error('Invalid shot video generation');
    if (v.status !== 'generating' && (v.generationId !== null || v.generationStartedAt !== null)) throw new Error('Invalid shot video generation');
    validateCandidates(s);
    assertSelectedId(s.selectedEndCandidateId ?? null, new Set(s.candidates.map((c:Candidate) => c.id)), 'Invalid selected end frame');
  }
}

export function mergeGeneration(current: Project, shotId: string, generationId: string, candidates: Candidate[], kind: GenerationKind = 'shots'): Project {
  const items = current[kind] ?? [];
  const shot = items.find(s => s.id === shotId);
  if (!shot || shot.generationId !== generationId || shot.status !== 'generating') throw new Error('Generation superseded');
  if (shot.candidates.length + candidates.length > 200) throw new Error('Too many candidates');
  return { ...current, [kind]: items.map(s => s.id === shotId ? { ...s, candidates: [...s.candidates, ...candidates], status: 'idle' as const, error: null, generationId: null, generationStartedAt: null } : s) };
}

function mergeGeneratedFrame<T extends GeneratedFrame>(local:T,remote:T):T {
  const { removedCandidateIds: localRemoved, ...localRest } = local;
  const removed=new Set(localRemoved ?? []);
  const candidates=[...local.candidates];
  const ids=new Set(candidates.map(candidate=>candidate.id));
  for (const candidate of remote.candidates) if (!ids.has(candidate.id) && !removed.has(candidate.id)) candidates.push(candidate);
  const selectedCandidateId=local.selectedCandidateId && candidates.some(candidate=>candidate.id===local.selectedCandidateId)
    ? local.selectedCandidateId
    : remote.selectedCandidateId;
  // Tombstones for ids the server no longer carries have done their job: the
  // deletion persisted, so they are dropped instead of accumulating forever.
  const remainingRemoved=[...removed].filter(id=>remote.candidates.some(candidate=>candidate.id===id));
  return {
    ...localRest,
    candidates,
    selectedCandidateId,
    ...(remainingRemoved.length ? { removedCandidateIds: remainingRemoved } : {}),
    status:remote.status,
    error:remote.error,
    generationId:remote.generationId,
    generationStartedAt:remote.generationStartedAt,
  } as T;
}

export function rebaseProjectEdits(local:Project,remote:Project):Project {
  const remoteShots=new Map(remote.shots.map(shot=>[shot.id,shot]));
  const remoteScenes=new Map((remote.scenes ?? []).map(scene=>[scene.id,scene]));
  return {
    ...local,
    revision:remote.revision,
    updatedAt:remote.updatedAt,
    storyboardDraft:remote.storyboardDraft ?? null,
    shots:local.shots.map(shot=>{
      const remoteShot=remoteShots.get(shot.id);
      if (!remoteShot) return shot;
      const localVideos = new Map(shot.video.candidates.map(candidate=>[candidate.id,candidate]));
      // Local deletions win over the remote union; remote additions are adopted.
      const removedVideos = new Set(shot.video.removedCandidateIds ?? []);
      const candidates = shot.video.candidates.map(candidate=>{
        const remoteCandidate=remoteShot.video.candidates.find(item=>item.id===candidate.id);
        return remoteCandidate ? {...remoteCandidate,trimStart:candidate.trimStart ?? 0,trimEnd:candidate.trimEnd ?? 0} : candidate;
      });
      for (const candidate of remoteShot.video.candidates) {
        if (!localVideos.has(candidate.id) && !removedVideos.has(candidate.id)) candidates.push(candidate);
      }
      const remainingRemovedVideos=[...removedVideos].filter(id=>remoteShot.video.candidates.some(candidate=>candidate.id===id));
      const selectedVideoId=shot.video.selectedVideoId && candidates.some(candidate=>candidate.id===shot.video.selectedVideoId)
        ? shot.video.selectedVideoId : remoteShot.video.selectedVideoId;
      const video={...remoteShot.video,candidates,selectedVideoId};
      if (remainingRemovedVideos.length) video.removedCandidateIds=remainingRemovedVideos;
      else delete video.removedCandidateIds;
      const merged={...mergeGeneratedFrame(shot,remoteShot),audio:remoteShot.audio,video};
      // Absent on the remote means no pending frame generation; do not leave the key behind.
      if (remoteShot.generationFrame!==undefined) merged.generationFrame=remoteShot.generationFrame;
      else delete merged.generationFrame;
      return merged;
    }),
    scenes:(local.scenes ?? []).map(scene=>{
      const remoteScene=remoteScenes.get(scene.id);
      return remoteScene ? mergeGeneratedFrame(scene,remoteScene) : scene;
    }),
  };
}

export function summarizeProject(project: Project): ProjectSummary {
  const selected = project.shots.map(s => s.candidates.find(c => c.id === s.selectedCandidateId)).filter((c): c is Candidate => !!c);
  return { id: project.id, name: project.name, description: project.description, updatedAt: project.updatedAt, shotCount: project.shots.length, selectedCount: selected.length, duration: project.shots.reduce((n,s) => n + s.duration, 0), cover: selected[0]?.url ?? null };
}
