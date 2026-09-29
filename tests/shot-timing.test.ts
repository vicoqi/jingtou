import test from 'node:test';
import assert from 'node:assert/strict';

const timing=await import('../lib/shot-timing.ts').catch(()=>null);
const voiced={duration:5,audioLeadIn:0.2,audioTailOut:0.5,audio:{url:'/voice.wav',duration:6.8}};

test('fitting uses real speech plus both pauses without changing the shot', () => {
  assert.ok(timing,'shot timing calculations must be available');
  const result=timing.getShotTiming(voiced);
  assert.equal(result.audioDuration,6.8);
  assert.equal(result.audioStart,0.2);
  assert.equal(result.audioEnd,7);
  assert.equal(result.requiredDuration,7.5);
  assert.equal(result.fitDuration,7.5);
  assert.equal(result.truncatedBy,2);
  assert.equal(result.shortfall,2.5);
  assert.equal(voiced.duration,5);
});

test('missing, outdated, or invalid audio cannot supply an automatic duration', () => {
  assert.ok(timing);
  for (const duration of [null,undefined,0,NaN,Infinity]) {
    const result=timing.getShotTiming({...voiced,audio:{url:'/voice.wav',duration}});
    assert.equal(result.fitDuration,null);
    assert.equal(result.truncatedBy,0);
  }
  assert.equal(timing.getShotTiming({...voiced,audio:{url:null,duration:6.8}}).fitDuration,null);
  assert.equal(timing.getShotTiming(voiced,false).fitDuration,null);
});

test('fitting rounds up to a tenth, supports long dialogue and never silently clips to the limit', () => {
  assert.ok(timing);
  const fit=(duration:number,lead=0,tail=0)=>timing.getShotTiming({...voiced,audioLeadIn:lead,audioTailOut:tail,audio:{url:'/voice.wav',duration}}).fitDuration;
  assert.equal(fit(6.81,0.2,0.5),7.6);
  assert.equal(fit(0.1,0.1,0.1),1);
  assert.equal(fit(0.9,0.1,0.1),1.1);
  assert.equal(fit(61.2),61.2);
  assert.equal(fit(599,0.5,0.5),600);
  assert.equal(fit(600,0.1),null);
});

test('a missing tail is distinguished from clipped dialogue', () => {
  assert.ok(timing);
  const result=timing.getShotTiming({...voiced,duration:7.2});
  assert.equal(result.truncatedBy,0);
  assert.ok(Math.abs(result.shortfall - 0.3)<1e-9);
  const fitted=timing.getShotTiming({...voiced,duration:7.5});
  assert.equal(fitted.truncatedBy,0);
  assert.equal(fitted.shortfall,0);
});

test('audio windows handle lead-in, speech, tail-out, seeks and the shot endpoint', () => {
  assert.ok(timing);
  const fitted={...voiced,duration:7.5};
  assert.deepEqual(timing.getShotAudioPosition(fitted,0),{currentTime:0,active:false});
  assert.deepEqual(timing.getShotAudioPosition(fitted,0.2),{currentTime:0,active:true});
  assert.deepEqual(timing.getShotAudioPosition(fitted,1.7),{currentTime:1.5,active:true});
  assert.deepEqual(timing.getShotAudioPosition(fitted,7),{currentTime:6.8,active:false});
  assert.deepEqual(timing.getShotAudioPosition(fitted,7.5),{currentTime:6.8,active:false});
  assert.deepEqual(timing.getShotAudioPosition(fitted,0.1),{currentTime:0,active:false});
  assert.equal(timing.getShotAudioPosition(voiced,5).active,false);
  assert.equal(timing.getShotAudioPosition(fitted,1,false).active,false);
  assert.equal(timing.getShotAudioPosition(fitted,NaN).active,false);
});
