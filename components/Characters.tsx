'use client';
import { useState } from 'react';
import { Plus, Upload, Trash2, ImagePlus, UserRound, X, LoaderCircle, Pencil } from 'lucide-react';
import type { Character, Project } from '../lib/types';
import { uploadImage } from '../lib/client';
import { newId } from '../lib/id';
import { Modal } from './Modal';

export function Characters({ project, update, busy }: { project: Project; update: (fn: (p: Project) => Project) => void; busy: boolean }) {
  const [editing, setEditing] = useState<Character | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<Character | null>(null);
  function save() {
    if (!editing?.name.trim()) { setError('请填写角色名称。'); return; }
    const character = { ...editing, name: editing.name.trim() };
    update(p => ({ ...p, characters: p.characters.some(c => c.id === character.id) ? p.characters.map(c => c.id === character.id ? character : c) : [...p.characters, character] }));
    setEditing(null); setError('');
  }
  async function upload(files: FileList | null) {
    if (!files || !editing) return;
    if (editing.references.length + files.length > 20) { setError('每个角色最多保留 20 张参考图，请先移除不需要的图片。'); return; }
    setUploading(true); setError('');
    try { for (const file of Array.from(files)) { const image = await uploadImage(file); setEditing(c => c ? { ...c, references: [...c.references, image] } : c); } }
    catch (e) { setError((e as Error).message); }
    finally { setUploading(false); }
  }
  return <section className="characters-page">
    <div className="section-heading"><div><span className="eyebrow">CHARACTER LIBRARY</span><h1>故事，从角色开始</h1><p>建立角色设定，在每一个镜头里延续同一份个性。</p></div><button className="button primary" disabled={busy} onClick={() => { setError(''); setEditing({ id: newId(), name: '', description: '', voice: 'female', references: [] }); }}><Plus size={17} />创建角色</button></div>
    <div className="character-grid">{project.characters.map((character, i) => <article className="character-card" key={character.id}>
      <div className={`character-portrait portrait-${i % 2}`}>
        {character.references[0] ? <img src={character.references[0].url} alt={character.name} /> : <UserRound size={60} strokeWidth={1} />}
        <span className="character-number">CHARACTER {String(i + 1).padStart(2, '0')}</span>
      </div>
      <div className="character-info"><div className="row spread"><h2>{character.name}</h2><div className="row"><span className="tag">{character.voice === 'female' ? '女声' : '男声'}</span><span className="tag">{character.references.length} 张参考图</span></div></div><p>{character.description || '尚未填写外观描述'}</p><div className="row spread"><small className="muted">出场于 {project.shots.filter(s => s.characterIds.includes(character.id)).length} 个镜头</small><div className="row"><button className="icon-button" aria-label={`编辑${character.name}`} disabled={busy} onClick={() => { setError(''); setEditing(structuredClone(character)); }}><Pencil size={16} /></button><button className="icon-button danger-hover" aria-label={`删除${character.name}`} disabled={busy} onClick={() => setDeleting(character)}><Trash2 size={16} /></button></div></div></div>
    </article>)}<button className="character-add" disabled={busy} onClick={() => { setError(''); setEditing({ id: newId(), name: '', description: '', voice: 'female', references: [] }); }}><Plus size={28} /><strong>添加新的角色</strong><span>让故事拥有更多可能</span></button></div>
    <div className="notice"><UserRound size={17} />更新角色后，已有候选图会保留，后续生成将使用最新设定和参考图。</div>
    {editing && <Modal title={project.characters.some(c => c.id === editing.id) ? '编辑角色' : '创建角色'} onClose={() => { if (!uploading) setEditing(null); }}>
      <form onSubmit={e => { e.preventDefault(); save(); }} className="modal-form">
        <label>角色名称<input autoFocus required maxLength={80} placeholder="例如：林夏" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></label>
        <label>外观设定<textarea rows={4} maxLength={3000} placeholder="描述发型、脸部特征、服装和标志性配饰，让角色在不同画面中保持一致…" value={editing.description} onChange={e => setEditing({ ...editing, description: e.target.value })} /></label>
        <label>角色音色<select value={editing.voice} onChange={e => setEditing({ ...editing, voice: e.target.value as Character['voice'] })}><option value="female">女声 · 晓晓</option><option value="male">男声 · 云希</option></select><span className="muted">用于该角色在分镜中的对白配音</span></label>
        <label>角色参考图 <span className="muted">建议上传清晰的正面、侧面和全身图</span></label>
        <div className="reference-grid">{editing.references.map(ref => <div className="reference-image" key={ref.id}><img src={ref.url} alt={ref.name} /><button type="button" aria-label={`移除${ref.name}`} className="remove-reference" disabled={uploading} onClick={() => setEditing({ ...editing, references: editing.references.filter(r => r.id !== ref.id) })}><X size={14} /></button></div>)}<label className={`upload-box ${uploading ? 'disabled' : ''}`}>{uploading ? <LoaderCircle className="spin" size={23} /> : <ImagePlus size={23} />}<span>{uploading ? '上传中' : '上传参考图'}</span><input type="file" className="sr-only" accept="image/png,image/jpeg,image/webp" multiple disabled={uploading} onChange={e => { void upload(e.target.files); e.target.value = ''; }} /></label></div>
        <small className="muted">PNG、JPG、WebP，每张不超过 10 MB。生成时会使用该角色的全部参考图。</small>
        {error && <p role="alert" className="notice error">{error}</p>}
        <div className="modal-actions"><button type="button" className="button" disabled={uploading} onClick={() => setEditing(null)}>取消</button><button className="button primary" disabled={uploading}><Upload size={16} />保存角色</button></div>
      </form>
    </Modal>}
    {deleting && <Modal title="删除角色" onClose={() => setDeleting(null)}><p className="modal-copy">确定删除「{deleting.name}」？分镜中的关联和说话角色将移除，已有画面、选图和配音会保留。</p><div className="modal-actions"><button className="button" onClick={() => setDeleting(null)}>取消</button><button className="button danger" onClick={() => { update(p => ({ ...p, characters: p.characters.filter(c => c.id !== deleting.id), shots: p.shots.map(s => ({ ...s, characterIds: s.characterIds.filter(id => id !== deleting.id), speakerCharacterId: s.speakerCharacterId === deleting.id ? null : s.speakerCharacterId })) })); setDeleting(null); }}>删除角色</button></div></Modal>}
  </section>;
}
