import test from 'node:test';
import assert from 'node:assert/strict';

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
