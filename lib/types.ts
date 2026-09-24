export type ReferenceImage = { id: string; url: string; name: string };
export type Character = { id: string; name: string; description: string; references: ReferenceImage[] };
export type Candidate = { id: string; url: string; createdAt: string; prompt: string; batchId: string; source: 'generated' | 'uploaded' | 'sample' };
export type Shot = { id: string; title: string; characterIds: string[]; scene: string; description: string; dialogue: string; duration: number; candidates: Candidate[]; selectedCandidateId: string | null; status: 'idle' | 'generating' | 'failed'; error: string | null; generationId: string | null; generationStartedAt: string | null };
export type Project = { id: string; name: string; description: string; aspectRatio: '16:9' | '9:16'; style: string; characters: Character[]; shots: Shot[]; revision: number; createdAt: string; updatedAt: string };
export type ProjectSummary = { id: string; name: string; description: string; updatedAt: string; shotCount: number; selectedCount: number; duration: number; cover: string | null };
