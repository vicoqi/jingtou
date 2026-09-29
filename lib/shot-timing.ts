export const MAX_SHOT_DURATION = 600;
export const MAX_PAUSE_DURATION = 30;

export type ShotTimingInput = {
  duration: number;
  audioLeadIn?: number;
  audioTailOut?: number;
  audio?: { url: string | null; duration?: number | null };
};

export function getShotTiming(shot: ShotTimingInput, audioUsable = true) {
  const audioStart = shot.audioLeadIn ?? 0;
  const storedDuration = shot.audio?.duration;
  const audioDuration = audioUsable && shot.audio?.url && typeof storedDuration === 'number' && Number.isFinite(storedDuration) && storedDuration > 0
    ? storedDuration : null;
  const audioEnd = audioDuration === null ? null : audioStart + audioDuration;
  const requiredDuration = audioEnd === null ? null : audioEnd + (shot.audioTailOut ?? 0);
  // Round up so fitting never shortens speech; tolerate floating-point addition noise.
  const rounded = requiredDuration === null ? null : Math.max(1, Math.ceil((requiredDuration - 1e-9) * 10) / 10);
  const fitDuration = rounded !== null && rounded <= MAX_SHOT_DURATION ? rounded : null;
  const truncatedBy = audioEnd === null ? 0 : Math.max(0, audioEnd - shot.duration);
  const shortfall = requiredDuration === null ? 0 : Math.max(0, requiredDuration - shot.duration);
  return { audioDuration, audioStart, audioEnd, requiredDuration, fitDuration, truncatedBy, shortfall };
}

export function getShotAudioPosition(shot: ShotTimingInput, localTime: number, audioUsable = true) {
  const timing = getShotTiming(shot, audioUsable);
  const time = Number.isFinite(localTime) ? localTime : 0;
  const audioDuration = timing.audioDuration ?? Math.max(0, shot.duration - timing.audioStart - (shot.audioTailOut ?? 0));
  const currentTime = Math.max(0, Math.min(audioDuration, time - timing.audioStart));
  const active = !!shot.audio?.url && audioUsable && Number.isFinite(localTime) && time >= timing.audioStart
    && time < Math.min(shot.duration, timing.audioStart + audioDuration);
  return { currentTime, active };
}
