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
  assert.equal(frame.image, null);
  assert.equal(frame.missing, 1);
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
