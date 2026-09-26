import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateLocalOwner } from '../scripts/local-owner.ts';

function fixture() {
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE auth_users (id text, email text);
    CREATE TABLE projects (id text, owner text, document text);
    CREATE TABLE assets (id text, owner text, name text);
    INSERT INTO auth_users VALUES ('user-a','a@example.com');
    INSERT INTO projects VALUES ('legacy','local-development','unchanged'),('other','user-b','other content');
    INSERT INTO assets VALUES ('image','local-development','ref.png'),('other-image','user-b','other.png');`);
  return db;
}
test('legacy migration previews counts and requires a registered recipient without assigning first-registration ownership',()=>{
  const db=fixture();
  assert.throws(()=>migrateLocalOwner(db,'missing@example.com'),/先注册/);
  const preview=migrateLocalOwner(db,' A@Example.com ');
  assert.equal(preview.projects,1); assert.equal(preview.assets,1); assert.equal(preview.applied,false);
  assert.equal(db.prepare("SELECT owner FROM projects WHERE id='legacy'").get()!.owner,'local-development');
  db.close();
});
test('migration backs up and transfers only legacy projects and images, preserving content and IDs',()=>{
  const db=fixture();
  const dir=mkdtempSync(join(tmpdir(),'jingtou-migration-'));
  const backup=join(dir,'backup.sqlite');
  try {
    const result=migrateLocalOwner(db,'a@example.com',{apply:true,backupPath:backup});
    assert.equal(result.applied,true);
    assert.deepEqual({...db.prepare("SELECT * FROM projects WHERE id='legacy'").get()},{id:'legacy',owner:'user-a',document:'unchanged'});
    assert.equal(db.prepare("SELECT owner FROM assets WHERE id='image'").get()!.owner,'user-a');
    assert.equal(db.prepare("SELECT owner FROM projects WHERE id='other'").get()!.owner,'user-b');
    assert.equal(db.prepare("SELECT owner FROM assets WHERE id='other-image'").get()!.owner,'user-b');
    const saved=new DatabaseSync(backup,{readOnly:true});
    assert.equal(saved.prepare("SELECT owner FROM projects WHERE id='legacy'").get()!.owner,'local-development');
    saved.close();
    const again=migrateLocalOwner(db,'a@example.com',{apply:true,backupPath:backup});
    assert.equal(again.projects,0); assert.equal(again.assets,0);
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
test('a failed image transfer rolls the project transfer back',()=>{
  const db=fixture();
  const dir=mkdtempSync(join(tmpdir(),'jingtou-migration-'));
  try {
    db.exec("CREATE TRIGGER reject_owner BEFORE UPDATE ON assets BEGIN SELECT RAISE(ABORT,'blocked'); END;");
    assert.throws(()=>migrateLocalOwner(db,'a@example.com',{apply:true,backupPath:join(dir,'backup.sqlite')}),/blocked/);
    assert.equal(db.prepare("SELECT owner FROM projects WHERE id='legacy'").get()!.owner,'local-development');
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
