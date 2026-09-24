import assert from 'node:assert/strict';
const origin = process.env.TEST_BASE_URL || 'http://localhost:3000';
const request = async (path, options) => {
  const response = await fetch(`${origin}${path}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
};
let id;
try {
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /镜头/);
  const created = await request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'HTTP 验收测试', demo: true }) });
  let project = created.project; id = project.id;
  assert.equal(project.characters.length, 2);
  assert.equal(project.shots.length, 12);
  assert.equal(project.shots.reduce((n, s) => n + s.duration, 0), 60);
  for (const url of new Set(project.shots.flatMap(s => s.candidates.map(c => c.url)).concat(project.characters.flatMap(c => c.references.map(r => r.url))))) {
    const response = await fetch(`${origin}${url}`);
    assert.equal(response.status, 200, `sample image ${url}`);
    assert.match(response.headers.get('content-type'), /^image\//);
  }
  const oldSelection = project.shots[0].selectedCandidateId;
  const originalRevision = project.revision;
  project.characters[0].description = '验收修改角色，旧画面应保留';
  project.shots[0].duration = 8;
  project.shots[0].dialogue = '新的对白应进入预览';
  const shot = project.shots.shift(); project.shots.push(shot);
  project = (await request(`/api/projects/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project }) })).project;
  assert.ok(project.revision > originalRevision);
  const reloaded = (await request(`/api/projects/${id}`)).project;
  assert.equal(reloaded.shots[11].dialogue, '新的对白应进入预览');
  assert.equal(reloaded.shots[11].selectedCandidateId, oldSelection);
  assert.equal(reloaded.shots.reduce((n, s) => n + s.duration, 0), 63);
  const staleResponse = await fetch(`${origin}/api/projects/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: { ...project, revision: originalRevision } }) });
  assert.equal(staleResponse.status, 409);
  const body = new FormData();
  body.set('file', new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j+V8AAAAASUVORK5CYII=', 'base64')], 'verification.png', { type: 'image/png' }));
  const uploaded = await request('/api/upload', { method: 'POST', body });
  assert.equal((await fetch(`${origin}${uploaded.image.url}`)).status, 200);
  project.characters[0].references.push(uploaded.image);
  const persisted = await request(`/api/projects/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project }) });
  assert.equal(persisted.project.characters[0].references.length, 2);
  console.log('HTTP smoke passed: rendered page, demo assets, 2 characters, 12 shots / 60s, reorder/edit/save/reload, preserved selection, revision conflict, uploaded reference persistence.');
} finally {
  if (id) await request(`/api/projects/${id}`, { method: 'DELETE' });
}
