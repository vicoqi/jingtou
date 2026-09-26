import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function migrateLocalOwner(db:DatabaseSync,email:string,options:{apply?:boolean;backupPath?:string}={}) {
  const normalized=email.trim().toLowerCase();
  const user=db.prepare('SELECT id, email FROM auth_users WHERE email = ?').get(normalized);
  if (!user) throw new Error('请先注册目标邮箱账号，再执行迁移。');
  const projects=Number(db.prepare("SELECT count(*) AS count FROM projects WHERE owner = 'local-development'").get()!.count);
  const assets=Number(db.prepare("SELECT count(*) AS count FROM assets WHERE owner = 'local-development'").get()!.count);
  const result={email:normalized,projects,assets,applied:false,backupPath:undefined as string | undefined};
  if (!options.apply || (!projects && !assets)) return result;
  if (!options.backupPath) throw new Error('迁移前必须指定数据库备份路径。');
  if (existsSync(options.backupPath)) throw new Error('备份文件已存在，请选择新的路径。');
  mkdirSync(dirname(options.backupPath),{recursive:true});
  db.prepare('VACUUM INTO ?').run(options.backupPath);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE projects SET owner = ? WHERE owner = 'local-development'").run(user.id);
    db.prepare("UPDATE assets SET owner = ? WHERE owner = 'local-development'").run(user.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return {...result,applied:true,backupPath:options.backupPath};
}

export function findLocalDatabase(root=resolve('.wrangler/state/v3/d1')):string {
  function scan(path:string):string[] {
    return readdirSync(path,{withFileTypes:true}).flatMap(entry=>entry.isDirectory() ? scan(join(path,entry.name)) : entry.name.endsWith('.sqlite') && entry.name!=='metadata.sqlite' ? [join(path,entry.name)] : []);
  }
  if (!existsSync(root)) throw new Error('未找到本地数据库，请先启动工作台。');
  const files=scan(root).filter(path=>{
    const candidate=new DatabaseSync(path,{readOnly:true});
    try { return !!candidate.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get(); }
    finally { candidate.close(); }
  });
  if (files.length!==1) throw new Error('未找到唯一的作品数据库，请检查本地存储目录。');
  return files[0];
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args=process.argv.slice(2),email=args.find(arg=>!arg.startsWith('--'));
    if (!email || args.some(arg=>arg.startsWith('--') && arg!=='--apply')) throw new Error('用法：npm run data:migrate -- 邮箱 [--apply]；默认仅预览，执行前请停止开发服务。');
    const db=new DatabaseSync(findLocalDatabase());
    try {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_users'").get()) throw new Error('请先启动新版工作台并注册目标邮箱。');
      const result=migrateLocalOwner(db,email,{apply:args.includes('--apply'),backupPath:resolve('.wrangler/backups',`before-owner-migration-${Date.now()}.sqlite`)});
      console.log(JSON.stringify(result,null,2));
      if (!args.includes('--apply')) console.log('当前只预览；确认后停止开发服务，加 --apply 执行。');
    } finally {db.close();}
  } catch(error) { console.error(error instanceof Error ? error.message : String(error));process.exitCode=1; }
}
