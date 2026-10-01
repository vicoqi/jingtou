export const MIN_VIDEO_PLAYBACK_SECONDS = 0.1;

type TrimmedVideo = { duration?: number | null; trimStart?: number; trimEnd?: number };

export function videoPlaybackWindow(video: TrimmedVideo | null | undefined, fallbackDuration: number) {
  const fullDuration = video?.duration && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : fallbackDuration;
  const minimum = Math.min(MIN_VIDEO_PLAYBACK_SECONDS, fullDuration);
  const requestedStart = video?.trimStart ?? 0;
  const requestedEnd = video?.trimEnd ?? 0;
  const start = Math.min(Math.max(0, fullDuration - minimum), Number.isFinite(requestedStart) ? Math.max(0, requestedStart) : 0);
  const trimEnd = Math.min(Math.max(0, fullDuration - start - minimum), Number.isFinite(requestedEnd) ? Math.max(0, requestedEnd) : 0);
  const end = fullDuration - trimEnd;
  return { start, end, duration: end - start, fullDuration };
}

export function validVideoTrim(video: TrimmedVideo): boolean {
  const start = video.trimStart ?? 0;
  const end = video.trimEnd ?? 0;
  if (![start, end].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return false;
  if (start === 0 && end === 0) return true;
  return typeof video.duration === 'number' && Number.isFinite(video.duration) && video.duration > 0
    && start + end <= video.duration - Math.min(MIN_VIDEO_PLAYBACK_SECONDS, video.duration) + 1e-8;
}
