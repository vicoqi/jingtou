import { getShotAudioPosition, getShotTiming, type ShotTimingInput } from './shot-timing.ts';
import { videoPlaybackWindow } from './video-trim.ts';

type PreviewShot = ShotTimingInput & { id: string; dialogue: string; showSubtitle?: boolean; selectedCandidateId: string | null; candidates: { id: string; url: string }[]; video?: { candidates: { id: string; url: string; duration?: number | null; trimStart?: number; trimEnd?: number }[]; selectedVideoId: string | null } };

export function advancePlayback(state: { time: number; playing: boolean }, delta: number, total: number) {
  if (!state.playing) return state;
  const time = Math.min(total, state.time + Math.max(0, delta));
  return { time, playing: time < total };
}

export function selectedMediaUrl<C extends { id: string; url: string }>(list: { candidates: C[] } | undefined | null, selectedId: string | null | undefined): string | null {
  return list?.candidates.find(candidate => candidate.id === selectedId)?.url ?? null;
}

export function previewFrame<T extends PreviewShot>(shots: T[], time: number, audioUsable:(shot:T)=>boolean = shot=>!!shot.audio?.url, videoUsable:(shot:T)=>boolean = shot=>!!selectedMediaUrl(shot.video, shot.video?.selectedVideoId)) {
  const windows=shots.map(shot=>{
    const selected=videoUsable(shot) ? shot.video?.candidates.find(candidate=>candidate.id===shot.video?.selectedVideoId) : null;
    return videoPlaybackWindow(selected,shot.duration);
  });
  const durations=windows.map(window=>window.duration);
  const total = durations.reduce((n, duration) => n + duration, 0);
  const position = Math.max(0, Math.min(Number.isFinite(time) ? time : 0, total));
  let start = 0;
  let index = -1;
  for (let i = 0; i < shots.length; i++) {
    const end=start + durations[i];
    if (position < end || i===shots.length - 1) { index = i; break; }
    start=end;
  }
  const shot = shots[index] ?? null;
  const duration=durations[index] ?? 0;
  const videoWindow=windows[index] ?? {start:0,end:0,duration:0,fullDuration:0};
  const image = selectedMediaUrl(shot, shot?.selectedCandidateId ?? null);
  // A usable video replaces both the still frame and the TTS audio (it carries its own track).
  const video = shot && videoUsable(shot) ? selectedMediaUrl(shot.video, shot.video!.selectedVideoId) : null;
  const audio = shot && !video && audioUsable(shot) ? shot.audio?.url ?? null : null;
  const localTime=shot ? Math.max(0,Math.min(duration,position - start)) : 0;
  const audioPosition=shot ? getShotAudioPosition(shot,localTime,!!audio) : {currentTime:0,active:false};
  const timing=shot ? getShotTiming({...shot,duration:video ? videoWindow.fullDuration : duration},!!audio) : null;
  const hasPauses=!!shot && ((shot.audioLeadIn ?? 0)>0 || (shot.audioTailOut ?? 0)>0);
  const subtitleEnd=shot ? Math.min(video ? videoWindow.end : duration,timing?.audioEnd ?? (video ? videoWindow.fullDuration : duration) - (shot.audioTailOut ?? 0)) : 0;
  const subtitleTime=video ? localTime + videoWindow.start : localTime;
  const subtitleVisible=!hasPauses || (subtitleTime >= (shot?.audioLeadIn ?? 0) && subtitleTime < subtitleEnd);
  const subtitle=shot?.showSubtitle !== false && subtitleVisible ? shot?.dialogue.trim() ?? '' : '';
  const timingIssues:{index:number;kind:'speech'|'tail'}[]=[];
  shots.forEach((s,i)=>{
    if (videoUsable(s)) return;
    const shotTiming=getShotTiming(s,audioUsable(s));
    if (shotTiming.shortfall>0.001) timingIssues.push({index:i,kind:shotTiming.truncatedBy>0.001?'speech':'tail'});
  });
  return { shot, image, video, videoWindow, audio, audioTime:audioPosition.currentTime, audioActive:audioPosition.active, subtitle, index, start, duration, durations, localTime, total, timingIssues, missing: shots.filter(s => !videoUsable(s) && !s.candidates.some(c => c.id === s.selectedCandidateId)).length, missingAudio:shots.filter(s=>!!s.dialogue.trim() && !audioUsable(s) && !videoUsable(s)).length };
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
