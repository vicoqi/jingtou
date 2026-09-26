import assert from 'node:assert/strict';
import test from 'node:test';
import { canDeleteProject, SAMPLE_PROJECT_ID } from '../lib/project-access.ts';

test('saved works can be deleted but the bundled sample cannot', () => {
  assert.equal(canDeleteProject({id:'work-1'}),true);
  assert.equal(canDeleteProject({id:SAMPLE_PROJECT_ID}),false);
  assert.equal(canDeleteProject(null),false);
});
