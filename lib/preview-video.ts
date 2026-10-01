type PreviewVideoElement = Pick<HTMLVideoElement, 'currentTime' | 'duration' | 'readyState' | 'seeking' | 'paused' | 'ended' | 'play' | 'pause'>;
type PlaybackState = { time: number; playing: boolean };

export function advanceVideoPlayback(state: PlaybackState, delta: number, total: number, clip: { start: number; duration: number; mediaStart?: number; mediaEnd?: number }, video: PreviewVideoElement | null): PlaybackState {
  if (!state.playing || !video || video.seeking) return state;
  const end = Math.min(total, clip.start + clip.duration);
  const mediaStart=clip.mediaStart ?? 0;
  const decodedTime = clip.start + Math.max(0, video.currentTime - mediaStart);
  if (clip.mediaEnd !== undefined && video.currentTime >= clip.mediaEnd) return {time:end,playing:end<total};
  const holdingTail = Number.isFinite(video.duration) && state.time >= clip.start + video.duration - mediaStart && video.currentTime >= video.duration;
  // The decoded media clock includes buffering and avoids cutting off the next shot
  // merely because its file took time to load. Only an intentional held tail uses RAF.
  if (video.ended || holdingTail) {
    const time = Math.min(end, Math.max(state.time, Math.min(end, decodedTime)) + Math.max(0, delta));
    return { time, playing: time < total };
  }
  if (video.readyState < 3 || video.paused) return state;
  const time = Math.min(end, Math.max(clip.start, decodedTime));
  return { time, playing: time < total };
}

export async function syncPreviewVideo(video: PreviewVideoElement, localTime: number, playing: boolean, window?: {start:number;end:number}): Promise<'loading' | 'ready' | 'ended' | 'blocked'> {
  if (video.readyState < 1 || !Number.isFinite(video.duration)) {
    video.pause();
    return 'loading';
  }
  const mediaStart=window?.start ?? 0;
  const mediaEnd=Math.min(window?.end ?? video.duration,video.duration);
  const target = Math.max(mediaStart, Math.min(mediaStart + localTime, mediaEnd));
  if (Math.abs(video.currentTime - target) > 0.05) {
    video.pause();
    try { video.currentTime = target; } catch { return 'loading'; }
  }
  if (mediaStart + localTime >= mediaEnd) {
    video.pause();
    return 'ended';
  }
  if (video.seeking || video.readyState < 3) {
    video.pause();
    return 'loading';
  }
  if (!playing) video.pause();
  else if (video.paused) {
    try { await video.play(); } catch { return 'blocked'; }
  }
  return 'ready';
}
