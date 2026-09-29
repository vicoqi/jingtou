import test from 'node:test';
import assert from 'node:assert/strict';

const playback=await import('../lib/preview-audio.ts').catch(()=>null);
const shot={duration:7.5,audioLeadIn:0.2,audioTailOut:0.5,audio:{url:'/voice.wav',duration:6.8}};
const audioElement=()=>({
  currentTime:0,
  duration:6.8,
  paused:true,
  async play(){this.paused=false;},
  pause(){this.paused=true;},
});

test('audio synchronization observes silence, speech and tail even while the timeline is playing', async () => {
  assert.ok(playback,'preview media synchronization must be available');
  const audio=audioElement();
  await playback.syncPreviewAudio(audio,shot,0.1,true);
  assert.equal(audio.paused,true);
  assert.equal(audio.currentTime,0);
  await playback.syncPreviewAudio(audio,shot,0.2,true);
  assert.equal(audio.paused,false);
  assert.equal(audio.currentTime,0);
  await playback.syncPreviewAudio(audio,shot,7,true);
  assert.equal(audio.paused,true);
  assert.equal(audio.currentTime,6.8);
});

test('pause, seek, resume and backward seek keep speech in the right position', async () => {
  assert.ok(playback);
  const audio=audioElement();
  await playback.syncPreviewAudio(audio,shot,1.7,false);
  assert.equal(audio.currentTime,1.5);
  assert.equal(audio.paused,true);
  await playback.syncPreviewAudio(audio,shot,1.7,true);
  assert.equal(audio.paused,false);
  await playback.syncPreviewAudio(audio,shot,0.1,true);
  assert.equal(audio.paused,true);
  assert.equal(audio.currentTime,0);
  await playback.syncPreviewAudio(audio,shot,3.2,true);
  assert.equal(audio.paused,false);
  assert.equal(audio.currentTime,3);
  await playback.syncPreviewAudio(audio,{...shot,duration:3.2},3.2,true);
  assert.equal(audio.paused,true);
});

test('decoded audio end never restarts speech and unavailable seeking stays silent', async () => {
  assert.ok(playback);
  const audio=audioElement();
  audio.duration=6.7;
  await playback.syncPreviewAudio(audio,shot,6.95,true);
  assert.equal(audio.currentTime,6.7);
  assert.equal(audio.paused,true);
  Object.defineProperty(audio,'currentTime',{set(){throw new Error('Metadata unavailable');}});
  await assert.doesNotReject(()=>playback.syncPreviewAudio(audio,shot,1,true));
  assert.equal(audio.paused,true);
});

test('browser playback rejection does not become an unhandled promise rejection', async () => {
  assert.ok(playback);
  const audio=audioElement();
  audio.play=async()=>{throw new Error('Playback blocked');};
  await assert.doesNotReject(()=>playback.syncPreviewAudio(audio,shot,1,true));
});
