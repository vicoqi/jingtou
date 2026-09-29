import { getShotAudioPosition, getShotTiming, type ShotTimingInput } from './shot-timing.ts';

type PreviewShot = ShotTimingInput & { id: string; dialogue: string; showSubtitle?: boolean; selectedCandidateId: string | null; candidates: { id: string; url: string }[] };

export function advancePlayback(state: { time: number; playing: boolean }, delta: number, total: number) {
  if (!state.playing) return state;
  const time = Math.min(total, state.time + Math.max(0, delta));
  return { time, playing: time < total };
}

export function previewFrame<T extends PreviewShot>(shots: T[], time: number, audioUsable:(shot:T)=>boolean = shot=>!!shot.audio?.url) {
  const total = shots.reduce((n, s) => n + s.duration, 0);
  const position = Math.max(0, Math.min(Number.isFinite(time) ? time : 0, total));
  let start = 0;
  let index = -1;
  for (let i = 0; i < shots.length; i++) {
    const end=start + shots[i].duration;
    if (position < end || i===shots.length - 1) { index = i; break; }
    start=end;
  }
  const shot = shots[index] ?? null;
  const image = shot?.candidates.find(c => c.id === shot.selectedCandidateId)?.url ?? null;
  const audio=shot && audioUsable(shot) ? shot.audio?.url ?? null : null;
  const localTime=shot ? Math.max(0,Math.min(shot.duration,position - start)) : 0;
  const audioPosition=shot ? getShotAudioPosition(shot,localTime,!!audio) : {currentTime:0,active:false};
  const timing=shot ? getShotTiming(shot,!!audio) : null;
  const hasPauses=!!shot && ((shot.audioLeadIn ?? 0)>0 || (shot.audioTailOut ?? 0)>0);
  const subtitleEnd=shot ? Math.min(shot.duration,timing?.audioEnd ?? shot.duration - (shot.audioTailOut ?? 0)) : 0;
  const subtitleVisible=!hasPauses || (localTime >= (shot?.audioLeadIn ?? 0) && localTime < subtitleEnd);
  const subtitle=shot?.showSubtitle !== false && subtitleVisible ? shot?.dialogue.trim() ?? '' : '';
  const timingIssues:{index:number;kind:'speech'|'tail'}[]=[];
  shots.forEach((s,i)=>{
    const shotTiming=getShotTiming(s,audioUsable(s));
    if (shotTiming.shortfall>0.001) timingIssues.push({index:i,kind:shotTiming.truncatedBy>0.001?'speech':'tail'});
  });
  return { shot, image, audio, audioTime:audioPosition.currentTime, audioActive:audioPosition.active, subtitle, index, start, localTime, total, timingIssues, missing: shots.filter(s => !s.candidates.some(c => c.id === s.selectedCandidateId)).length, missingAudio:shots.filter(s=>!!s.dialogue.trim() && !audioUsable(s)).length };
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
