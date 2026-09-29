import { getShotAudioPosition, type ShotTimingInput } from './shot-timing.ts';

type PreviewAudioElement = Pick<HTMLAudioElement, 'currentTime' | 'duration' | 'play' | 'pause'>;

export async function syncPreviewAudio(audio: PreviewAudioElement, shot: ShotTimingInput, localTime: number, playing: boolean): Promise<void> {
  audio.pause();
  const position = getShotAudioPosition(shot, localTime);
  const decodedEnd = Number.isFinite(audio.duration) ? audio.duration : Infinity;
  try {
    audio.currentTime = Math.min(position.currentTime, decodedEnd);
  } catch {
    // Wait for metadata before seeking; never play from the wrong position.
    return;
  }
  if (playing && position.active && position.currentTime < decodedEnd) {
    await audio.play().catch(() => {});
  }
}
