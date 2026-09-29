import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../lib/sample.ts';
import { newShot } from '../lib/domain.ts';
import { mergeGenerationAcknowledgement } from '../lib/workspace-state.ts';

test('background generation does not block interaction with other shots', async () => {
  const state=await import('../lib/workspace-state.ts').catch(()=>null);
  assert.ok(state,'workspace state helper should exist');
  assert.equal(state.isWorkspaceBusy({working:false,navigating:false,generating:true}),false);
  assert.equal(state.isWorkspaceBusy({working:true,navigating:false,generating:true}),true);
  assert.equal(state.isWorkspaceBusy({working:false,navigating:true,generating:false}),true);
});

test('an older generation acknowledgement cannot replace newer project state', async () => {
  const state=await import('../lib/workspace-state.ts');
  const newer={id:'project',revision:8,value:'two jobs'};
  const older={id:'project',revision:7,value:'one job'};
  assert.equal(typeof state.selectNewerProject,'function');
  assert.equal(state.selectNewerProject(newer,older),newer);
  assert.equal(state.selectNewerProject(older,newer),newer);
});

test('generation acknowledgement preserves edits made before its response and adopts job state', () => {
  const incoming=createProject('节奏测试');
  incoming.shots=[newShot(),newShot()];
  const local=structuredClone(incoming);
  local.shots[0].audioLeadIn=0.2;
  local.shots[0].audioTailOut=0.5;
  local.shots[0].duration=7.5;
  local.shots[1].description='请求返回前修改的另一个镜头';
  incoming.revision++;
  incoming.shots[0].audio={...incoming.shots[0].audio,status:'generating',generationId:'job',generationStartedAt:'2026-09-28T00:00:00Z'};
  const merged=mergeGenerationAcknowledgement(local,incoming,true);
  assert.equal(merged.shots[0].audioLeadIn,0.2);
  assert.equal(merged.shots[0].audioTailOut,0.5);
  assert.equal(merged.shots[0].duration,7.5);
  assert.equal(merged.shots[1].description,'请求返回前修改的另一个镜头');
  assert.equal(merged.shots[0].audio.generationId,'job');
  assert.equal(merged.revision,incoming.revision);
  assert.equal(mergeGenerationAcknowledgement(local,incoming,false),incoming);
});

test('older acknowledgement cannot downgrade job results even when local edits are pending', () => {
  const current=createProject('节奏测试');
  current.shots=[newShot()];
  current.revision=4;
  const incoming={...current,revision:3};
  assert.equal(mergeGenerationAcknowledgement(current,incoming,true),current);
  const other=createProject('另一个作品');
  assert.equal(mergeGenerationAcknowledgement(current,other,true),other);
});
