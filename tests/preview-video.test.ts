import test from 'node:test';
import assert from 'node:assert/strict';

const playback = await import('../lib/preview-video.ts').catch(() => null);
const clip = { start: 5, duration: 5 };
const state = { time: 6, playing: true };
const element = () => ({
  currentTime: 1, duration: 5, readyState: 4, seeking: false, paused: false, ended: false,
  async play() { this.paused = false; },
  pause() { this.paused = true; },
});

test('video buffering, seeking and pending playback freeze the preview clock', () => {
  assert.ok(playback, 'video playback synchronization must be available');
  for (const override of [{ readyState: 2 }, { seeking: true }, { paused: true }]) {
    assert.deepEqual(playback.advanceVideoPlayback(state, 2, 15, clip, { ...element(), ...override }), state);
  }
});

test('video playback uses decoded position rather than elapsed wall time', () => {
  assert.ok(playback);
  const video = { ...element(), currentTime: 2.4 };
  assert.deepEqual(playback.advanceVideoPlayback(state, 3, 15, clip, video), { time: 7.4, playing: true });
  assert.deepEqual(playback.advanceVideoPlayback({ time: 7.4, playing: false }, 3, 15, clip, video), { time: 7.4, playing: false });
});

test('a cut waits for the next clip and resumes from its decoded start', () => {
  assert.ok(playback);
  const first = playback.advanceVideoPlayback({ time: 4.9, playing: true }, 0.2, 10, { start: 0, duration: 5 }, { ...element(), currentTime: 5 });
  assert.deepEqual(first, { time: 5, playing: true });
  const next = { ...element(), currentTime: 0, readyState: 0, paused: true };
  assert.deepEqual(playback.advanceVideoPlayback(first, 2, 10, clip, next), first);
  next.readyState = 4;
  next.paused = false;
  next.currentTime = 0.2;
  assert.deepEqual(playback.advanceVideoPlayback(first, 2, 10, clip, next), { time: 5.2, playing: true });
});

test('short video holds its last frame and a longer video cuts at the shot boundary', () => {
  assert.ok(playback);
  const ended = { ...element(), currentTime: 3, duration: 3, ended: true, paused: true };
  assert.deepEqual(playback.advanceVideoPlayback({ time: 8, playing: true }, 0.25, 15, clip, ended), { time: 8.25, playing: true });
  assert.deepEqual(playback.advanceVideoPlayback({ time: 9.8, playing: true }, 1, 15, clip, ended), { time: 10, playing: true });
  assert.deepEqual(playback.advanceVideoPlayback(state, 1, 10, clip, { ...element(), currentTime: 5.1, duration: 8 }), { time: 10, playing: false });
});

test('video synchronization waits for metadata and seeks before playing', async () => {
  assert.ok(playback);
  const video = element();
  video.readyState = 0;
  assert.equal(await playback.syncPreviewVideo(video, 2, true), 'loading');
  assert.equal(video.paused, true);
  assert.equal(video.currentTime, 1);
  video.readyState = 4;
  assert.equal(await playback.syncPreviewVideo(video, 2, true), 'ready');
  assert.equal(video.currentTime, 2);
  assert.equal(video.paused, false);
  assert.equal(await playback.syncPreviewVideo(video, 2, false), 'ready');
  assert.equal(video.paused, true);
});

test('seeking a short clip into its held tail does not replay its audio', async () => {
  assert.ok(playback);
  const video = element();
  assert.equal(await playback.syncPreviewVideo(video, 7, true), 'ended');
  assert.equal(video.paused, true);
  assert.equal(video.currentTime, 5);
  assert.equal(await playback.syncPreviewVideo(video, 1, true), 'ready');
  assert.equal(video.currentTime, 1);
  assert.equal(video.paused, false);
});

test('rejected playback and unavailable seeks never run the video from the wrong position', async () => {
  assert.ok(playback);
  const video = element();
  video.paused = true;
  video.play = async () => { throw new Error('NotAllowedError'); };
  assert.equal(await playback.syncPreviewVideo(video, 1, true), 'blocked');
  Object.defineProperty(video, 'currentTime', { get() { return 0; }, set() { throw new Error('Metadata unavailable'); } });
  assert.equal(await playback.syncPreviewVideo(video, 2, true), 'loading');
  assert.equal(video.paused, true);
});
