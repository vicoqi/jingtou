import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVideoPrompt, checkWanVideoTask, clampVideoDuration, DEFAULT_WAN_VIDEO_MODEL, detectVideoMime, downloadWanVideo, submitWanVideoTask, WAN_VIDEO_BASE_URL, wanVideoDownloadUrl } from '../lib/video.ts';
import { newShot } from '../lib/domain.ts';
import type { Project } from '../lib/types.ts';

const project = (): Project => ({
  id: 'p1', name: '测试作品', description: '', aspectRatio: '9:16', style: '宫崎骏动画',
  characters: [{ id: 'c1', name: '林夏', description: '深蓝短发少女', voice: 'female', references: [] }],
  scenes: [], shots: [{ ...newShot(), id: 'opening' }, shot()], revision: 1, createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
});

const shot = () => ({ ...newShot(), id: 's1', candidates: [{id:'first',url:'/samples/summer.png',createdAt:'2026-10-01',prompt:'p',batchId:'b',source:'sample' as const}], selectedCandidateId:'first', title: '重逢', description: '夕阳下的车站全景，林夏站在站台远望，风吹起发丝。', dialogue: '你来了。', speakerCharacterId: 'c1', characterIds: ['c1'], duration: 6 });

test('video duration clamps to the wan3.0 supported range', () => {
  assert.equal(clampVideoDuration(0.4), 2);
  assert.equal(clampVideoDuration(6), 6);
  assert.equal(clampVideoDuration(6.4), 6);
  assert.equal(clampVideoDuration(600), 30);
  assert.equal(clampVideoDuration(Number.NaN), 5);
});

test('video prompt describes a continuous first-frame shot, dialogue, tone and negative list', () => {
  const prompt = buildVideoPrompt(project(), { ...shot(), voiceInstruction: '温柔地说，语速稍慢', audioLeadIn: 1 });
  assert.match(prompt, /生成连续单镜头，总时长约 6 秒，画幅比例 9:16/);
  assert.match(prompt, /遵循首帧参考图的画风（宫崎骏动画）/);
  assert.match(prompt, /剧情与动作：夕阳下的车站全景/);
  assert.match(prompt, /开场先铺垫约 1 秒/);
  assert.match(prompt, /林夏（温柔地说，语速稍慢）说："你来了。"/);
  assert.match(prompt, /无背景音乐/);
  assert.match(prompt, /不要字幕/);
  assert.ok(!prompt.includes('reference image'));
});

test('video prompt falls back to no-dialogue line and escapes quotes', () => {
  const silent = buildVideoPrompt(project(), { ...shot(), dialogue: '', speakerCharacterId: null });
  assert.match(silent, /台词：无台词。/);
  assert.ok(!silent.includes('说："'));
  const quoted = buildVideoPrompt(project(), { ...shot(), dialogue: '她说"走吧"' });
  assert.match(quoted, /说："她说＂走吧＂"/);
});

test('video prompt rejects missing description and missing speaker', () => {
  assert.throws(() => buildVideoPrompt(project(), { ...shot(), description: '  ' }), /请先填写画面描述/);
  assert.throws(() => buildVideoPrompt(project(), { ...shot(), speakerCharacterId: null }), /请从出场角色中选择说话角色/);
});

const pngFrame = () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5]);
  return { bytes, mime: 'image/png' as const };
};

test('video task submission sends async first-frame request with fixed parameters', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const taskId = await submitWanVideoTask({ key: 'dashscope-secret', prompt: '提示词', firstFrame: pngFrame(), duration: 8, fetcher: async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ output: { task_id: 'task-1', task_status: 'PENDING' } });
  } });
  assert.equal(taskId, 'task-1');
  assert.equal(calls[0].url, `${WAN_VIDEO_BASE_URL}/api/v1/services/aigc/video-generation/video-synthesis`);
  assert.equal(new Headers(calls[0].init?.headers).get('X-DashScope-Async'), 'enable');
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.model, DEFAULT_WAN_VIDEO_MODEL);
  assert.equal(body.input.media[0].type, 'first_frame');
  assert.match(body.input.media[0].url, /^data:image\/png;base64,/);
  assert.equal(body.parameters.resolution, '720P');
  assert.equal(body.parameters.ratio, 'adaptive');
  assert.equal(body.parameters.duration, 8);
  assert.equal(body.parameters.audio, true);
  assert.equal(body.parameters.prompt_extend, false);
});

test('video task submission honours model, base url overrides and reports errors', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  await submitWanVideoTask({ key: 'k', model: 'wan3.0-video-prime', baseUrl: 'https://example.com/', prompt: 'p', firstFrame: pngFrame(), duration: 2, fetcher: async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ output: { task_id: 'task-2', task_status: 'PENDING' } });
  } });
  assert.equal(calls[0].url, 'https://example.com/api/v1/services/aigc/video-generation/video-synthesis');
  assert.equal(JSON.parse(String(calls[0].init?.body)).model, 'wan3.0-video-prime');
  await assert.rejects(() => submitWanVideoTask({ key: 'k', prompt: 'p', firstFrame: pngFrame(), duration: 2, fetcher: async () => Response.json({}, { status: 401 }) }), /Video provider failed \(401\)/);
  await assert.rejects(() => submitWanVideoTask({ key: 'k', prompt: 'p', firstFrame: pngFrame(), duration: 2, fetcher: async () => new Response('not json') }), /invalid response/);
});

test('video task query parses states, usage duration and failures', async () => {
  const succeeded = await checkWanVideoTask({ key: 'k', taskId: 'task-1', fetcher: async () => Response.json({ output: { task_status: 'SUCCEEDED', video_url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/video/result.mp4' }, usage: { duration: 5.5, fps: 30, SR: 720 } }) });
  assert.equal(succeeded.status, 'SUCCEEDED');
  assert.equal(succeeded.duration, 5.5);
  assert.match(succeeded.videoUrl!, /result\.mp4$/);
  const failed = await checkWanVideoTask({ key: 'k', taskId: 'task-1', fetcher: async () => Response.json({ output: { task_status: 'FAILED', code: 'InvalidParameter', message: 'bad input' } }) });
  assert.equal(failed.status, 'FAILED');
  assert.match(failed.error!, /bad input（InvalidParameter）/);
  await assert.rejects(() => checkWanVideoTask({ key: 'k', taskId: 'task-1', fetcher: async () => Response.json({ output: { task_status: 'WEIRD' } }) }), /invalid task status/);
  await assert.rejects(() => checkWanVideoTask({ key: 'k', taskId: 'task-1', fetcher: async () => Response.json({ output: { task_status: 'SUCCEEDED' } }) }), /no video URL/);
});

test('video download url accepts public https hosts and rejects private or odd forms', () => {
  assert.equal(wanVideoDownloadUrl('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/video/a.mp4'), 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/video/a.mp4');
  assert.equal(wanVideoDownloadUrl('https://maas.qianwenaiapi.com/api/v1/files/result.mp4'), 'https://maas.qianwenaiapi.com/api/v1/files/result.mp4');
  assert.equal(wanVideoDownloadUrl('https://cdn.example.com/video/a.mp4?signature=x'), 'https://cdn.example.com/video/a.mp4?signature=x');
  assert.throws(() => wanVideoDownloadUrl('http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/video/a.mp4'), /invalid URL \(http:\/\//);
  assert.throws(() => wanVideoDownloadUrl('https://10.0.0.5/video/a.mp4'), /invalid URL/);
  assert.throws(() => wanVideoDownloadUrl('https://bucket.oss.internal/video/a.mp4'), /invalid URL/);
  assert.throws(() => wanVideoDownloadUrl('https://user:pass@cdn.example.com/a.mp4'), /invalid URL/);
  assert.throws(() => wanVideoDownloadUrl('https://cdn.example.com:8443/a.mp4'), /invalid URL/);
});

test('video download validates size and mp4 signature', async () => {
  const mp4 = () => { const bytes = new Uint8Array(64); bytes.set([0, 0, 0, 24], 0); bytes.set([...'ftyp'].map(c => c.charCodeAt(0)), 4); return bytes; };
  const downloaded = await downloadWanVideo('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/video/a.mp4', async () => new Response(mp4().buffer as ArrayBuffer, { headers: { 'content-length': '64' } }));
  assert.equal(downloaded.mime, 'video/mp4');
  assert.equal(detectVideoMime(new Uint8Array(8)), null);
  assert.equal(detectVideoMime(mp4()), 'video/mp4');
  await assert.rejects(() => downloadWanVideo('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/video/a.mp4', async () => new Response('x'.repeat(10), { headers: { 'content-length': String(200 * 1024 * 1024) } })), /too large/);
});
