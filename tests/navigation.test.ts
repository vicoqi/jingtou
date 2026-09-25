import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectNavigation, projectLocation, projectIdFromLocation, projectsLocation, resourceLibraryLocation, workspaceViewFromLocation } from '../lib/navigation.ts';

test('the home URL never implicitly opens a saved project', () => {
  assert.equal(projectIdFromLocation('http://localhost:3000/'), null);
  assert.equal(projectIdFromLocation('http://localhost:3000/?project='), null);
  assert.equal(projectLocation(null), '/');
});

test('project URLs round trip and can be reopened directly', () => {
  const id = 'f62c9014-6627-4fc7-924c-741e9ad73481';
  assert.equal(projectLocation(id), `/?project=${id}`);
  assert.equal(projectIdFromLocation(`http://localhost:3000${projectLocation(id)}`), id);
});

test('the storyboard workspace has a distinct, restorable URL', () => {
  assert.equal(projectsLocation(), '/?view=projects');
  assert.equal(resourceLibraryLocation('characters'), '/?view=characters');
  assert.equal(resourceLibraryLocation('scenes'), '/?view=scenes');
  assert.equal(workspaceViewFromLocation('http://localhost:3000/'), 'home');
  assert.equal(workspaceViewFromLocation('http://localhost:3000/?view=projects'), 'projects');
  assert.equal(workspaceViewFromLocation('http://localhost:3000/?view=characters'), 'characters');
  assert.equal(workspaceViewFromLocation('http://localhost:3000/?view=scenes'), 'scenes');
  assert.equal(workspaceViewFromLocation('http://localhost:3000/?view=unknown'), 'home');
});

function fixture(save: () => Promise<void> = async () => {}) {
  let current: { id: string } | null = { id: 'existing' };
  let url = projectLocation(current.id);
  const writes: string[] = [];
  const errors: string[] = [];
  const navigation = createProjectNavigation({
    current: () => current,
    save,
    load: async (id: string) => ({ id }),
    show: project => { current = project; },
    write: (id, mode) => { url = projectLocation(id); writes.push(`${mode}:${url}`); },
    loading: () => {},
    error: (message: string) => { errors.push(message); },
  });
  return { navigation, writes, errors, current: () => current, url: () => url };
}

test('returning home waits for saving before changing the screen or URL', async () => {
  let release!: () => void;
  const f = fixture(() => new Promise<void>(resolve => { release = resolve; }));
  const navigation = f.navigation.navigate(null);
  assert.equal(f.current()?.id, 'existing');
  assert.deepEqual(f.writes, []);
  release();
  assert.equal(await navigation, true);
  assert.equal(f.current(), null);
  assert.equal(f.url(), '/');
  assert.deepEqual(f.writes, ['push:/']);
});

test('back and forward restore the requested screen without creating new history entries', async () => {
  const f = fixture();
  await f.navigation.navigate(null, 'none');
  assert.equal(f.current(), null);
  await f.navigation.navigate('existing', 'none');
  assert.equal(f.current()?.id, 'existing');
  assert.deepEqual(f.writes, []);
});

test('a failed save preserves edits and restores the current URL after browser back', async () => {
  const f = fixture(async () => { throw new Error('保存失败'); });
  assert.equal(await f.navigation.navigate(null, 'none'), false);
  assert.equal(f.current()?.id, 'existing');
  assert.deepEqual(f.writes, ['replace:/?project=existing']);
  assert.equal(f.errors.at(-1), '保存失败');
});

test('rapid history navigation cannot let a slower project request reopen the wrong screen', async () => {
  let resolveProject!: (project: { id: string }) => void;
  let started!: () => void;
  const loading = new Promise<void>(resolve => { started = resolve; });
  let current: { id: string } | null = null;
  const navigation = createProjectNavigation({
    current: () => current, save: async () => {},
    load: async () => { started(); return new Promise<{ id: string }>(resolve => { resolveProject = resolve; }); },
    show: project => { current = project; }, write: () => {}, loading: () => {}, error: () => {},
  });
  const slow = navigation.navigate('older', 'none');
  await loading;
  await navigation.navigate(null, 'none');
  resolveProject({ id: 'older' });
  assert.equal(await slow, false);
  assert.equal(current, null);
});
