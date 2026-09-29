import type { Character, DraftShot, Project, Shot, StoryboardDraft } from './types.ts';
import { newShot } from './domain.ts';
import { newId } from './id.ts';

export const nameKey = (name: string) => name.trim().toLowerCase();

export function shotCharacterNames(shot: DraftShot): string[] {
  return [...shot.characters, ...(shot.speaker ? [shot.speaker] : [])];
}

export function collectDraftCharacterUsage(draft: StoryboardDraft, keptIndexes: number[]): Map<string, string> {
  const usedNames = new Map<string, string>();
  for (const shot of keptIndexes.map(i => draft.shots[i]).filter(s => !!s)) {
    for (const name of shotCharacterNames(shot)) {
      const key = nameKey(name);
      if (key && !usedNames.has(key)) usedNames.set(key, name.trim());
    }
  }
  return usedNames;
}

export function applyStoryboardDraft(project: Project, draft: StoryboardDraft, keptIndexes: number[]): { project: Project; insertedShotIds: string[] } {
  const kept = keptIndexes.map(i => draft.shots[i]).filter(s => !!s);
  if (project.shots.length + kept.length > 200) throw new Error('镜头总数不能超过 200，请先删减现有镜头或减少导入的草稿镜头。');

  const characters = [...project.characters];
  const nameToId = new Map<string, string>();
  for (const [key, original] of collectDraftCharacterUsage(draft, keptIndexes)) {
    const existing = characters.find(c => nameKey(c.name) === key);
    if (existing) { nameToId.set(key, existing.id); continue; }
    if (characters.length >= 100) throw new Error('角色总数不能超过 100，请先整理角色库再导入。');
    const draftCharacter = draft.characters.find(c => nameKey(c.name) === key);
    const created: Character = { id: newId(), name: original, description: draftCharacter?.description ?? '', voice: 'female', references: [] };
    characters.push(created);
    nameToId.set(key, created.id);
  }

  const shots: Shot[] = kept.map((s, i) => {
    const characterIds = [...new Set(s.characters.map(nameKey).filter(k => nameToId.has(k)).map(k => nameToId.get(k)!))];
    const speakerId = s.speaker ? nameToId.get(nameKey(s.speaker)) ?? null : null;
    if (speakerId && !characterIds.includes(speakerId)) characterIds.push(speakerId);
    return { ...newShot(), title: s.title.trim() || `镜头 ${project.shots.length + i + 1}`, scene: s.scene, description: s.description, dialogue: s.dialogue, duration: s.duration, showSubtitle: true, characterIds, speakerCharacterId: speakerId };
  });

  return { project: { ...project, characters, shots: [...project.shots, ...shots], storyboardDraft: null }, insertedShotIds: shots.map(s => s.id) };
}
