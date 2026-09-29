import test from 'node:test';
import assert from 'node:assert/strict';
import { previewFrame, formatTime, moveItem, advancePlayback } from '../lib/playback.ts';

const shots = Array.from({ length: 12 }, (_, i) => ({ id: String(i), duration: 5, dialogue: `对白 ${i}`, selectedCandidateId: i === 2 ? null : `c${i}`, candidates: [{ id: `c${i}`, url: `/frame${i}.png` }] }));
test('12 five-second shots form a 60-second preview with exact boundaries', () => {
  assert.equal(previewFrame(shots, 0).shot?.id, '0');
  assert.equal(previewFrame(shots, 5).shot?.id, '1');
  assert.equal(previewFrame(shots, 59.9).shot?.id, '11');
  assert.equal(previewFrame(shots, 60).shot?.id, '11');
  assert.equal(previewFrame(shots, 9).total, 60);
});
test('missing selections preserve timeline position and current dialogue', () => {
  const frame = previewFrame(shots, 12);
  assert.equal(frame.shot?.id, '2');
  assert.equal(frame.shot?.dialogue, '对白 2');
  assert.equal(frame.subtitle, '对白 2');
  assert.equal(frame.image, null);
  assert.equal(frame.missing, 1);
});
test('subtitle visibility is controlled per shot and defaults to visible', () => {
  assert.equal(previewFrame([{...shots[0],showSubtitle:false}],0).subtitle, '');
  assert.equal(previewFrame([{...shots[0],showSubtitle:true}],0).subtitle, '对白 0');
  assert.equal(previewFrame([shots[0]],0).subtitle, '对白 0');
});
test('preview exposes shot-relative time and playable audio at timeline boundaries', () => {
  const voiced=shots.map((shot,index)=>({...shot,audio:{url:index===1?'/api/assets/00000000-0000-0000-0000-000000000001':null}}));
  const frame=previewFrame(voiced,6.5);
  assert.equal(frame.index,1);
  assert.equal(frame.start,5);
  assert.equal(frame.localTime,1.5);
  assert.equal(frame.audio,'/api/assets/00000000-0000-0000-0000-000000000001');
  assert.equal(frame.missingAudio,11);
  const suppressed=previewFrame(voiced,6.5,()=>false);
  assert.equal(suppressed.audio,null);
  assert.equal(suppressed.missingAudio,12);
});
test('reordering and edits immediately change preview content', () => {
  const reordered = moveItem(shots, 1, 0);
  assert.equal(previewFrame(reordered, 0).shot?.id, '1');
  assert.equal(shots[0].id, '0');
  const edited = reordered.map((s, i) => i ? s : { ...s, duration: 8, dialogue: '新的对白', selectedCandidateId: 'replacement', candidates: [...s.candidates, {id: 'replacement', url: '/new.png'}] });
  assert.equal(previewFrame(edited, 7).shot?.dialogue, '新的对白');
  assert.equal(previewFrame(edited, 7).image, '/new.png');
  assert.equal(previewFrame(edited, 8).shot?.id, '0');
});
test('empty timeline and invalid reorder are safe', () => {
  assert.equal(previewFrame([], 10).shot, null);
  assert.deepEqual(moveItem(shots, 0, -1), shots);
  assert.equal(formatTime(60), '01:00');
});

test('playback stops exactly at the end and pause preserves the playhead', () => {
  assert.deepEqual(advancePlayback({ time: 59.8, playing: true }, 0.5, 60), { time: 60, playing: false });
  assert.deepEqual(advancePlayback({ time: 20, playing: false }, 3, 60), { time: 20, playing: false });
  assert.deepEqual(advancePlayback({ time: 0, playing: true }, 0.25, 60), { time: 0.25, playing: true });
});

const timedShot={...shots[0],duration:7.5,audioLeadIn:0.2,audioTailOut:0.5,audio:{url:'/voice.wav',duration:6.8}};

test('preview preloads speech but keeps lead-in and tail-out silent', () => {
  const lead=previewFrame([timedShot],0.1);
  assert.equal(lead.audio,'/voice.wav');
  assert.equal(lead.audioActive,false);
  assert.equal(lead.audioTime,0);
  assert.equal(lead.subtitle,'');
  const speaking=previewFrame([timedShot],0.2);
  assert.equal(speaking.audioActive,true);
  assert.equal(speaking.subtitle,'对白 0');
  const tail=previewFrame([timedShot],7);
  assert.equal(tail.audioActive,false);
  assert.equal(tail.audioTime,6.8);
  assert.equal(tail.subtitle,'');
  assert.equal(previewFrame([timedShot],7.5).audioActive,false);
});

test('seeking and crossing shots use the correct speech-relative offset', () => {
  const sequence=[shots[1],timedShot,{...timedShot,id:'last',audioLeadIn:1}];
  const middle=previewFrame(sequence,6.7);
  assert.equal(middle.start,5);
  assert.ok(Math.abs(middle.audioTime-1.5)<1e-9);
  assert.equal(middle.audioActive,true);
  const backward=previewFrame(sequence,5.1);
  assert.equal(backward.audioActive,false);
  assert.equal(backward.audioTime,0);
  const next=previewFrame(sequence,12.5);
  assert.equal(next.shot?.id,'last');
  assert.equal(next.audioActive,false);
  assert.equal(next.audioTime,0);
});

test('preview lists clipped speech and insufficient tails separately and ignores stale audio', () => {
  const sequence=[timedShot,{...timedShot,id:'cut',duration:5},{...timedShot,id:'tail',duration:7.2}];
  assert.deepEqual(previewFrame(sequence,0).timingIssues,[{index:1,kind:'speech'},{index:2,kind:'tail'}]);
  const stale=previewFrame(sequence,1,()=>false);
  assert.deepEqual(stale.timingIssues,[]);
  assert.equal(stale.audioActive,false);
  assert.equal(stale.audio,null);
});

test('zero pauses preserve legacy subtitles and missing audio still shows dialogue between pauses', () => {
  assert.equal(previewFrame([{...timedShot,audioLeadIn:0,audioTailOut:0}],7.4).subtitle,'对白 0');
  assert.equal(previewFrame([{...timedShot,showSubtitle:false}],1).subtitle,'');
  assert.equal(previewFrame([timedShot],1,()=>false).subtitle,'对白 0');
  assert.equal(previewFrame([timedShot],7.2,()=>false).subtitle,'');
  const empty=previewFrame([],0);
  assert.equal(empty.audioActive,false);
  assert.equal(empty.audioTime,0);
  assert.deepEqual(empty.timingIssues,[]);
});
