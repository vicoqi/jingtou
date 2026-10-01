/* eslint-disable @typescript-eslint/no-explicit-any -- In-memory fixture responses mirror heterogeneous provider JSON. */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest } from '../lib/server.ts';
import { emptyShotVideo, newShot } from '../lib/domain.ts';
import { apiRequest, testEnvironment } from './helpers/database.ts';

const { db, env } = testEnvironment();
const videoEnv = () => ({ ...env, DASHSCOPE_API_KEY: 'dashscope-key' });
let cookie = '';
const json = async (response: Response) => response.json() as Promise<any>;

const pngFile = () => {
  const bytes = new Uint8Array(16);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  return new File([bytes], 'frame.png', { type: 'image/png' });
};
const mp4Bytes = () => {
  const bytes = new Uint8Array(64);
  bytes.set([0, 0, 0, 24], 0);
  bytes.set([...'ftyp'].map(c => c.charCodeAt(0)), 4);
  return bytes;
};

async function uploadFrame(): Promise<string> {
  const form = new FormData();
  form.append('file', pngFile());
  const response = await handleApiRequest(new Request('https://studio.example/api/upload', { method: 'POST', headers: { cookie }, body: form }), env);
  assert.equal(response.status, 201);
  return (await json(response)).image.url as string;
}

async function projectWithShot(): Promise<{ id: string; shotId: string }> {
  const created = await json(await handleApiRequest(apiRequest('/api/projects', 'POST', { name: '视频测试' }, cookie), env));
  const frameUrl = await uploadFrame();
  const shot = { ...newShot(), title: '海边', description: '夕阳下少女回眸。', dialogue: '你来了。', speakerCharacterId: 'c1', characterIds: ['c1'], duration: 6, candidates: [{ id: 'cand-1', url: frameUrl, createdAt: new Date().toISOString(), prompt: 'p', batchId: 'b1', source: 'uploaded' as const }], selectedCandidateId: 'cand-1' };
  const previous = { ...newShot(), title: '开场静图', candidates: [{ ...shot.candidates[0], id: 'cand-start', url: await uploadFrame() }], selectedCandidateId: 'cand-start' };
  const project = { ...created.project, characters: [{ id: 'c1', name: '林夏', description: '短发少女', voice: 'female', references: [] }], shots: [previous, shot] };
  const saved = await json(await handleApiRequest(apiRequest(`/api/projects/${created.project.id}`, 'PUT', { project }, cookie), env));
  return { id: saved.project.id, shotId: shot.id };
}

function wanFetcher(task: object) {
  const urls: string[] = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    calls.push({ url, init });
    if (url.includes('/video-synthesis')) return Response.json({ output: { task_id: 'task-1', task_status: 'PENDING' } });
    if (url.includes('/api/v1/tasks/')) return Response.json(task);
    return new Response(mp4Bytes().buffer as ArrayBuffer, { headers: { 'content-length': '64', 'content-type': 'video/mp4' } });
  };
  return { urls, calls, fetcher };
}

const succeededTask = { output: { task_status: 'SUCCEEDED', video_url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/video/r.mp4' }, usage: { duration: 6, fps: 30, SR: 720 } };

before(async () => {
  const response = await handleApiRequest(apiRequest('/api/auth/register', 'POST', { email: 'video@example.com', password: 'test password 123' }), env);
  assert.equal(response.status, 201);
  cookie = response.headers.get('set-cookie')!.split(';')[0];
});

test('video generation stores mp4 asset and records source snapshot', async () => {
  const { id, shotId } = await projectWithShot();
  const { urls, fetcher } = wanFetcher(succeededTask);
  const response = await handleApiRequest(apiRequest(`/api/projects/${id}/generate-video`, 'POST', { shotId }, cookie), videoEnv(), { fetcher });
  assert.equal(response.status, 200);
  const { project } = await json(response);
  const video = project.shots[1].video;
  assert.equal(video.status, 'idle');
  assert.equal(video.candidates.length, 1);
  assert.equal(video.selectedVideoId, video.candidates[0].id);
  assert.match(video.candidates[0].url, /^\/api\/assets\//);
  assert.equal(video.candidates[0].duration, 6);
  assert.equal(video.candidates[0].sourceMode, 'independent');
  assert.equal(video.candidates[0].sourceFirstFrameId, 'cand-1');
  assert.equal(video.candidates[0].sourceLastFrameId, '');
  assert.match(video.candidates[0].sourceKey, /^[0-9a-f]{16}$/);
  assert.ok(urls.some(url => url.includes('/video-synthesis')));
  assert.ok(urls.some(url => url.includes('/api/v1/tasks/task-1')));
  assert.ok(urls.some(url => url.includes('r.mp4')));
  const asset = await handleApiRequest(apiRequest(video.candidates[0].url, 'GET', undefined, cookie), env);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'video/mp4');
});

test('video generation request carries prompt, first frame and fixed parameters', async () => {
  const { id, shotId } = await projectWithShot();
  const { calls, fetcher } = wanFetcher(succeededTask);
  await handleApiRequest(apiRequest(`/api/projects/${id}/generate-video`, 'POST', { shotId }, cookie), videoEnv(), { fetcher });
  const submitted = JSON.parse(String(calls.find(call => call.url.includes('/video-synthesis'))?.init?.body));
  assert.equal(submitted.model, 'wan3.0-video');
  assert.match(submitted.input.prompt, /生成连续单镜头，总时长约 6 秒/);
  assert.match(submitted.input.prompt, /林夏说："你来了。"/);
  assert.equal(submitted.input.media[0].type, 'first_frame');
  assert.match(submitted.input.media[0].url, /^data:image\/png;base64,/);
  assert.equal(submitted.input.media.length, 1, 'no tail image is sent unless one is selected');
  assert.equal(submitted.parameters.audio, true);
  assert.equal(submitted.parameters.prompt_extend, false);
  assert.equal(submitted.parameters.ratio, 'adaptive');
});

test('video generation failure records error without keeping a url', async () => {
  const { id, shotId } = await projectWithShot();
  const { fetcher } = wanFetcher({ output: { task_status: 'FAILED', code: 'InvalidParameter', message: '首帧图无效' } });
  const response = await handleApiRequest(apiRequest(`/api/projects/${id}/generate-video`, 'POST', { shotId }, cookie), videoEnv(), { fetcher });
  assert.equal(response.status, 502);
  const { project } = await json(await handleApiRequest(apiRequest(`/api/projects/${id}`, 'GET', undefined, cookie), env));
  const video = project.shots[1].video;
  assert.equal(video.status, 'failed');
  assert.match(video.error, /首帧图无效/);
  assert.equal(video.candidates.length, 0);
  assert.equal(video.selectedVideoId, null);
});

test('video generation validates configuration and shot prerequisites', async () => {
  const { id, shotId } = await projectWithShot();
  assert.equal((await handleApiRequest(apiRequest(`/api/projects/${id}/generate-video`, 'POST', { shotId }, cookie), env)).status, 503);
  const noFrame = await projectWithShot();
  const current = await json(await handleApiRequest(apiRequest(`/api/projects/${noFrame.id}`, 'GET', undefined, cookie), env));
  current.project.shots[1].selectedCandidateId = null;
  await handleApiRequest(apiRequest(`/api/projects/${noFrame.id}`, 'PUT', { project: current.project }, cookie), env);
  const rejected = await handleApiRequest(apiRequest(`/api/projects/${noFrame.id}/generate-video`, 'POST', { shotId: current.project.shots[1].id }, cookie), videoEnv(), { fetcher: async () => { throw new Error('should not call provider'); } });
  assert.equal(rejected.status, 400);
  assert.match((await json(rejected)).error, /请先为镜头选定一张候选图/);
});

test('GET advances a generating video task recorded on the project', async () => {
  const { id } = await projectWithShot();
  const started = new Date(Date.now() - 60_000).toISOString();
  const doc = JSON.parse(db.sqlite.prepare('SELECT document FROM projects WHERE id = ?').get(id)!.document as string);
  doc.shots[1].video = { ...emptyShotVideo(), status: 'generating', generationId: 'g-lazy', generationStartedAt: started, taskId: 'task-lazy', polledAt: started };
  db.sqlite.prepare('UPDATE projects SET document = ? WHERE id = ?').run(JSON.stringify(doc), id);
  const { urls, fetcher } = wanFetcher({ output: { task_status: 'SUCCEEDED', video_url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/video/lazy.mp4' }, usage: { duration: 5 } });
  const response = await handleApiRequest(apiRequest(`/api/projects/${id}`, 'GET', undefined, cookie), videoEnv(), { fetcher });
  assert.equal(response.status, 200);
  const { project } = await json(response);
  const video = project.shots[1].video;
  assert.equal(video.status, 'idle');
  assert.equal(video.candidates.length, 1);
  assert.equal(video.selectedVideoId, video.candidates[0].id);
  assert.match(video.candidates[0].url, /^\/api\/assets\//);
  assert.equal(video.candidates[0].duration, 5);
  assert.equal(video.candidates[0].sourceFirstFrameId, 'cand-1');
  assert.ok(urls.some(url => url.includes('/api/v1/tasks/task-lazy')));
  assert.ok(urls.some(url => url.includes('lazy.mp4')));
});

test('PUT keeps a generating video job untouched while other edits land', async () => {
  const { id } = await projectWithShot();
  const started = new Date(Date.now() - 60_000).toISOString();
  const doc = JSON.parse(db.sqlite.prepare('SELECT document FROM projects WHERE id = ?').get(id)!.document as string);
  doc.shots[1].video = { ...emptyShotVideo(), status: 'generating', generationId: 'g-put', generationStartedAt: started, taskId: 'task-put', polledAt: started };
  db.sqlite.prepare('UPDATE projects SET document = ? WHERE id = ?').run(JSON.stringify(doc), id);
  const current = await json(await handleApiRequest(apiRequest(`/api/projects/${id}`, 'GET', undefined, cookie), videoEnv(), { fetcher: async () => { throw new Error('no provider in this test'); } }));
  const proposed = { ...current.project, shots: current.project.shots.map((shot: any) => ({ ...shot, title: '改过的标题。' })) };
  const saved = await json(await handleApiRequest(apiRequest(`/api/projects/${id}`, 'PUT', { project: proposed }, cookie), env));
  assert.equal(saved.project.shots[1].title, '改过的标题。');
  assert.equal(saved.project.shots[1].video.status, 'generating');
  assert.equal(saved.project.shots[1].video.generationId, 'g-put');
  assert.equal(saved.project.shots[1].video.taskId, 'task-put');
});

for (const phase of ['query', 'download'] as const) {
  test(`a temporary video ${phase} failure preserves the submitted task and resumes it without resubmission`, async () => {
    const { id, shotId } = await projectWithShot();
    const { fetcher: success, calls } = wanFetcher(succeededTask);
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if ((phase === 'query' && url.includes('/api/v1/tasks/')) || (phase === 'download' && url.endsWith('/r.mp4'))) return new Response('temporary outage', { status: 503 });
      return success(input, init);
    };
    const response = await handleApiRequest(apiRequest(`/api/projects/${id}/generate-video`, 'POST', { shotId }, cookie), videoEnv(), { fetcher });
    assert.equal(response.status, 200);
    const pending = (await json(response)).project;
    assert.equal(pending.shots[1].video.status, 'generating');
    assert.equal(pending.shots[1].video.taskId, 'task-1');
    const doc = JSON.parse(db.sqlite.prepare('SELECT document FROM projects WHERE id = ?').get(id)!.document as string);
    doc.shots[1].video.polledAt = new Date(Date.now() - 60_000).toISOString();
    db.sqlite.prepare('UPDATE projects SET document = ? WHERE id = ?').run(JSON.stringify(doc), id);
    const recovered = await json(await handleApiRequest(apiRequest(`/api/projects/${id}`, 'GET', undefined, cookie), videoEnv(), { fetcher: success }));
    assert.equal(recovered.project.shots[1].video.status, 'idle');
    assert.equal(recovered.project.shots[1].video.candidates.length, 1);
    assert.equal(calls.filter(call => call.url.includes('/video-synthesis')).length, 1);
  });

  test(`an older video task survives temporary ${phase} failure during GET recovery`, async () => {
    const { id } = await projectWithShot();
    const started = new Date(Date.now() - 26 * 60_000).toISOString();
    const doc = JSON.parse(db.sqlite.prepare('SELECT document FROM projects WHERE id = ?').get(id)!.document as string);
    doc.shots[1].video = { ...emptyShotVideo(), status: 'generating', generationId: 'g-recovery', generationStartedAt: started, taskId: 'task-recovery', polledAt: started };
    db.sqlite.prepare('UPDATE projects SET document = ? WHERE id = ?').run(JSON.stringify(doc), id);
    const { fetcher: success } = wanFetcher(succeededTask);
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if ((phase === 'query' && url.includes('/api/v1/tasks/')) || (phase === 'download' && url.endsWith('/r.mp4'))) throw new Error('connection interrupted');
      return success(input, init);
    };
    const recovered = await json(await handleApiRequest(apiRequest(`/api/projects/${id}`, 'GET', undefined, cookie), videoEnv(), { fetcher }));
    assert.equal(recovered.project.shots[1].video.status, 'generating');
    assert.equal(recovered.project.shots[1].video.taskId, 'task-recovery');
  });
}

for (const field of ['description', 'selectedCandidateId', 'firstFrameUrl'] as const) {
  test(`PUT rejects changing ${field} while video generation is running`, async () => {
    const { id } = await projectWithShot();
    const started = new Date().toISOString();
    const doc = JSON.parse(db.sqlite.prepare('SELECT document FROM projects WHERE id = ?').get(id)!.document as string);
    doc.shots[1].video = { ...emptyShotVideo(), status: 'generating', generationId: 'g-locked', generationStartedAt: started, taskId: 'task-locked', polledAt: started };
    db.sqlite.prepare('UPDATE projects SET document = ? WHERE id = ?').run(JSON.stringify(doc), id);
    const proposed = structuredClone(doc);
    if (field === 'description') proposed.shots[1].description = '不同的动作';
    else if (field === 'selectedCandidateId') {
      proposed.shots[1].candidates.push({ ...proposed.shots[1].candidates[0], id: 'second-frame' });
      proposed.shots[1].selectedCandidateId = 'second-frame';
    } else proposed.shots[1].candidates[0].url = await uploadFrame();
    const rejected = await handleApiRequest(apiRequest(`/api/projects/${id}`, 'PUT', { project: proposed }, cookie), env);
    assert.equal(rejected.status, 400);
    assert.match((await json(rejected)).error, /视频生成期间.*(?:描述|画面)/);
    const stored = JSON.parse(db.sqlite.prepare('SELECT document FROM projects WHERE id = ?').get(id)!.document as string);
    assert.deepEqual(stored.shots[1], doc.shots[1]);
  });
}

test('other shots stay editable during video generation and locked inputs unlock after completion', async () => {
  const { id } = await projectWithShot();
  const started = new Date(Date.now() - 60_000).toISOString();
  const doc = JSON.parse(db.sqlite.prepare('SELECT document FROM projects WHERE id = ?').get(id)!.document as string);
  doc.shots[1].video = { ...emptyShotVideo(), status: 'generating', generationId: 'g-unlock', generationStartedAt: started, taskId: 'task-unlock', polledAt: started };
  doc.shots.push(newShot());
  db.sqlite.prepare('UPDATE projects SET document = ? WHERE id = ?').run(JSON.stringify(doc), id);
  doc.shots[2].description = '其它镜头仍可编辑';
  const edited = await handleApiRequest(apiRequest(`/api/projects/${id}`, 'PUT', { project: doc }, cookie), env);
  assert.equal(edited.status, 200);
  const { fetcher } = wanFetcher(succeededTask);
  const completed = (await json(await handleApiRequest(apiRequest(`/api/projects/${id}`, 'GET', undefined, cookie), videoEnv(), { fetcher }))).project;
  completed.shots[1].description = '完成后修改动作';
  completed.shots[1].selectedCandidateId = null;
  const saved = await handleApiRequest(apiRequest(`/api/projects/${id}`, 'PUT', { project: completed }, cookie), env);
  assert.equal(saved.status, 200);
});

test('video assets support byte ranges and metadata without exposing another account\'s files', async () => {
  const { id, shotId } = await projectWithShot();
  const { fetcher } = wanFetcher(succeededTask);
  const generated = await json(await handleApiRequest(apiRequest(`/api/projects/${id}/generate-video`, 'POST', { shotId }, cookie), videoEnv(), { fetcher }));
  const url = generated.project.shots[1].video.candidates[0].url;
  const request = (method: string, range?: string, requestCookie = cookie) => new Request(`https://studio.example${url}`, { method, headers: { cookie: requestCookie, ...(range ? { range } : {}) } });
  const head = await handleApiRequest(request('HEAD'), env);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '64');
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(await head.text(), '');
  for (const [range, start, end] of [['bytes=4-11', 4, 11], ['bytes=60-', 60, 63], ['bytes=-8', 56, 63], ['bytes=60-100', 60, 63]] as const) {
    const response = await handleApiRequest(request('GET', range), env);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/64`);
    assert.equal(response.headers.get('content-length'), String(end - start + 1));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), mp4Bytes().slice(start, end + 1));
  }
  const invalid = await handleApiRequest(request('GET', 'bytes=100-200'), env);
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), 'bytes */64');
  const full = await handleApiRequest(request('GET'), env);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-length'), '64');
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), mp4Bytes());
  const registered = await handleApiRequest(apiRequest('/api/auth/register', 'POST', { email: 'other-video-viewer@example.com', password: 'test password 123' }), env);
  const otherCookie = registered.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await handleApiRequest(request('GET', 'bytes=0-10', otherCookie), env)).status, 404);
  assert.equal((await handleApiRequest(request('HEAD', undefined, otherCookie), env)).status, 404);
});
