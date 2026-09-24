type PreviewShot = { id: string; duration: number; dialogue: string; selectedCandidateId: string | null; candidates: { id: string; url: string }[] };

export function advancePlayback(state: { time: number; playing: boolean }, delta: number, total: number) {
  if (!state.playing) return state;
  const time = Math.min(total, state.time + Math.max(0, delta));
  return { time, playing: time < total };
}

export function previewFrame<T extends PreviewShot>(shots: T[], time: number) {
  const total = shots.reduce((n, s) => n + s.duration, 0);
  const position = Math.max(0, Math.min(Number.isFinite(time) ? time : 0, total));
  let start = 0;
  let index = shots.length ? shots.length - 1 : -1;
  for (let i = 0; i < shots.length; i++) {
    if (position < start + shots[i].duration) { index = i; break; }
    start += shots[i].duration;
  }
  const shot = shots[index] ?? null;
  const image = shot?.candidates.find(c => c.id === shot.selectedCandidateId)?.url ?? null;
  return { shot, image, index, total, missing: shots.filter(s => !s.candidates.some(c => c.id === s.selectedCandidateId)).length };
}

export function formatTime(seconds: number) {
  const n = Math.floor(Math.max(0, seconds));
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const result = [...items];
  result.splice(to, 0, result.splice(from, 1)[0]);
  return result;
}
