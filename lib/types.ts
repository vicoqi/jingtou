export type AuthUser = { id: string; email: string };
export type ReferenceImage = { id: string; url: string; name: string };
export type VoiceGender = 'female' | 'male';
export type Character = { id: string; name: string; description: string; voice: VoiceGender; references: ReferenceImage[] };
export type Candidate = { id: string; url: string; createdAt: string; prompt: string; batchId: string; source: 'generated' | 'uploaded' | 'sample'; frame?: 'start' | 'end' };
export type GeneratedFrame = { id: string; candidates: Candidate[]; selectedCandidateId: string | null; status: 'idle' | 'generating' | 'failed'; error: string | null; generationId: string | null; generationStartedAt: string | null };
export type ShotAudio = { url: string | null; duration: number | null; sourceText: string | null; sourceVoice: VoiceGender | null; sourceInstruction: string | null; status: 'idle' | 'generating' | 'failed'; error: string | null; generationId: string | null; generationStartedAt: string | null };
// Each candidate records a compact key of the shot inputs it was generated from (hash, not
// full text — the project document must stay under D1's 1MB row limit), so staleness is judged
// against the selected candidate. Optional frame fields distinguish legacy single-frame
// videos from historical frame chains and new independent shot frames.
export type VideoSource = { sourceMode?: 'independent'; sourceFirstFrameId: string; sourceLastFrameId?: string; sourcePreviousShotId?: string; sourceDuration?: number; sourceKey: string };
export type VideoCandidate = VideoSource & { id: string; url: string; createdAt: string; duration: number | null; trimStart?: number; trimEnd?: number };
export type ShotVideo = { candidates: VideoCandidate[]; selectedVideoId: string | null; taskId: string | null; polledAt: string | null; source?: VideoSource | null; status: 'idle' | 'generating' | 'failed'; error: string | null; generationId: string | null; generationStartedAt: string | null };
export type GenerationKind = 'shots' | 'scenes';
export type Scene = GeneratedFrame & { name: string; description: string; style?: string };
export type Shot = GeneratedFrame & { title: string; characterIds: string[]; scene: string; sceneId?: string | null; description: string; endFrameDescription?: string; selectedEndCandidateId?: string | null; generationFrame?: 'start' | 'end'; dialogue: string; showSubtitle: boolean; voiceInstruction: string; duration: number; audioLeadIn: number; audioTailOut: number; speakerCharacterId: string | null; audio: ShotAudio; video: ShotVideo };
export type DraftCharacter = { name: string; description: string };
export type DraftShot = { title: string; scene: string; description: string; dialogue: string; speaker: string | null; characters: string[]; duration: number };
export type StoryboardDraft = { status: 'generating' | 'ready' | 'failed'; error: string | null; generationId: string | null; generationStartedAt: string | null; story: string; requestedCount: number | null; characters: DraftCharacter[]; shots: DraftShot[] };
export type Project = { id: string; name: string; description: string; aspectRatio: '16:9' | '9:16'; style: string; characters: Character[]; scenes?: Scene[]; shots: Shot[]; storyboardDraft?: StoryboardDraft | null; revision: number; createdAt: string; updatedAt: string };
export type ProjectSummary = { id: string; name: string; description: string; updatedAt: string; shotCount: number; selectedCount: number; duration: number; cover: string | null };
export type LibraryCharacter = Character & { projectId: string; projectName: string; shotCount: number };
export type LibraryScene = Pick<Scene, 'id' | 'name' | 'description' | 'style' | 'status'> & { projectId: string; projectName: string; shotCount: number; candidateCount: number; previewUrl: string | null };
export type ResourceLibrary = { characters: LibraryCharacter[]; scenes: LibraryScene[] };
