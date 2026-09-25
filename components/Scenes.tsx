'use client';
import { useRef, useState, type ChangeEvent } from 'react';
import { AlertCircle, Check, ImagePlus, LoaderCircle, Maximize2, Mountain, Pencil, Plus, RotateCcw, Sparkles, Trash2, Upload } from 'lucide-react';
import type { Candidate, Project, Scene } from '../lib/types';
import { newScene, removeScene } from '../lib/domain';
import { newId } from '../lib/id';
import { uploadImage } from '../lib/client';
import { Modal } from './Modal';

type Props = {
  project: Project;
  update: (fn: (project: Project) => Project) => void;
  busy: boolean;
  readOnly: boolean;
  onGenerate: (sceneId: string, count: number) => void;
  onUploadingChange: (value: boolean) => void;
};
const selectedImage = (scene: Scene) => scene.candidates.find(c => c.id === scene.selectedCandidateId);
const statusLabel = (scene: Scene) => scene.status === 'generating' ? '生成中' : scene.status === 'failed' ? '生成失败' : selectedImage(scene) ? '已选参考图' : scene.candidates.length ? '待选参考图' : '待生成';

export function Scenes({ project, update, busy, readOnly, onGenerate, onUploadingChange }: Props) {
  const scenes = project.scenes ?? [];
  const [activeId, setActiveId] = useState('');
  const [editing, setEditing] = useState<Scene | null>(null);
  const [deleting, setDeleting] = useState<Scene | null>(null);
  const [zoomId, setZoomId] = useState<string | null>(null);
  const [count, setCount] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const uploadRef = useRef<HTMLInputElement>(null);
  const scene = scenes.find(s => s.id === activeId) ?? scenes[0];
  const selected = scene && selectedImage(scene);
  const zoom = scene?.candidates.find(c => c.id === zoomId);
  const disabled = busy || uploading || readOnly;
  const atLimit = scenes.length >= 100;
  function create() { if (disabled || atLimit) return; setError(''); setEditing(newScene()); }
  function patch(patch: Partial<Scene>) {
    if (!scene || disabled) return;
    update(p => ({ ...p, scenes: (p.scenes ?? []).map(s => s.id === scene.id ? { ...s, ...patch } : s) }));
  }
  function save() {
    if (disabled || !editing?.name.trim()) return;
    const name = editing.name.trim();
    update(p => ({ ...p, scenes: (p.scenes ?? []).some(s => s.id === editing.id)
      ? p.scenes!.map(s => s.id === editing.id ? { ...s, name, description: editing.description } : s)
      : [...(p.scenes ?? []), { ...editing, name }] }));
    setActiveId(editing.id); setEditing(null); setError('');
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = '';
    if (!scene || disabled || !files.length) return;
    if (scene.candidates.length + files.length > 200) { setError('每个场景最多保留 200 张候选图。'); return; }
    const sceneId = scene.id;
    setUploading(true); onUploadingChange(true); setError('');
    try {
      for (const file of files) {
        const image = await uploadImage(file);
        const candidate: Candidate = { id: newId(), url: image.url, createdAt: new Date().toISOString(), prompt: '手动上传场景图', batchId: newId(), source: 'uploaded' };
        update(p => p.id !== project.id ? p : ({ ...p, scenes: (p.scenes ?? []).map(s => s.id === sceneId ? { ...s, candidates: [...s.candidates, candidate] } : s) }));
      }
    } catch (e) { setError((e as Error).message); }
    finally { setUploading(false); onUploadingChange(false); }
  }
  return <section className="scenes-page">
    <div className="section-heading"><div><span className="eyebrow">SCENE LIBRARY</span><h1>场景生成</h1><p>先定下故事发生的地方，再让多个镜头延续同一个环境。</p></div><button className="button primary" disabled={disabled || atLimit} onClick={create}><Plus size={17} />创建场景</button></div>
    {error && <div className="notice error" role="alert"><AlertCircle size={16} />{error}</div>}
    {!scene ? <div className="scene-empty"><Mountain size={52} strokeWidth={1} /><h2>为故事搭建第一个场景</h2><p>描述地点、布局与光线，生成不含人物的场景参考图。<br />也可以上传已有场景图，在分镜中重复使用。</p>{readOnly ? <span className="muted">复制样例后即可创建场景</span> : <button className="button primary" disabled={disabled} onClick={create}><Plus size={17} />创建第一个场景</button>}</div> : <div className="scene-workspace">
      <aside className="scene-list" aria-label="场景列表"><div className="panel-title"><span>作品场景</span><span className="muted">{scenes.length}</span></div>{scenes.map(s => <button key={s.id} className={`scene-list-item ${s.id === scene.id ? 'active' : ''}`} onClick={() => { setActiveId(s.id); setZoomId(null); }} aria-pressed={s.id === scene.id}><span className="scene-list-thumb">{selectedImage(s) ? <img src={selectedImage(s)!.url} alt="" loading="lazy" /> : <Mountain size={21} />}</span><span><strong>{s.name}</strong><small className={s.status === 'failed' ? 'danger-text' : ''}>{s.status === 'generating' && <LoaderCircle size={11} className="spin" />}{statusLabel(s)}</small></span></button>)}<button className="add-shot" disabled={disabled || atLimit} onClick={create}><Plus size={14} />添加场景</button></aside>
      <div className="scene-detail">
        <div className="scene-detail-heading"><div><h2>{scene.name}</h2><p>已关联 {project.shots.filter(s => s.sceneId === scene.id).length} 个分镜</p></div><div className="row"><button className="icon-button" aria-label="编辑当前场景" disabled={disabled} onClick={() => setEditing(structuredClone(scene))}><Pencil size={16} /></button><button className="icon-button danger-hover" aria-label="删除当前场景" disabled={disabled} onClick={() => setDeleting(scene)}><Trash2 size={16} /></button></div></div>
        <div className="scene-compose">
          <div className="scene-preview" style={{ aspectRatio: project.aspectRatio.replace(':', ' / ') }}>
            {selected ? <><img src={selected.url} alt={`${scene.name}选定参考图`} /><span className="selected-overlay"><Check size={12} />分镜参考图</span><button className="scene-zoom icon-button" aria-label="放大场景参考图" onClick={() => setZoomId(selected.id)}><Maximize2 size={17} /></button></> : <div className="empty-frame"><Mountain size={36} strokeWidth={1.2} /><h3>{scene.candidates.length ? '选择一张场景参考图' : '这个场景，等待你的描述'}</h3><p>{scene.candidates.length ? '点击下方「选用」，供关联分镜生成时参考' : '生成候选图，或上传已有的环境画面'}</p></div>}
            {scene.status === 'generating' && <div className="generating-overlay" role="status"><LoaderCircle className="spin" size={28} /><strong>正在生成场景候选图</strong><span>已有画面和选择会保留</span></div>}
          </div>
          <div className="scene-settings"><fieldset className="shot-form" disabled={disabled}><label>场景描述<textarea rows={6} maxLength={4000} value={scene.description} onChange={e => patch({ description: e.target.value })} placeholder="例如：海边车站，白色站棚、蓝色长椅，铁轨沿海岸延伸，夕阳从左侧照入。描述布局、建筑、光线和标志性物件…" /></label><label>候选数量<select value={count} onChange={e => setCount(Number(e.target.value))}>{[1,2,3,4].map(n => <option key={n} value={n}>{n} 张</option>)}</select></label></fieldset><p className="scene-style">沿用作品画风：{project.style}</p><button className="button primary" disabled={disabled || !scene.description.trim() || scene.candidates.length + count > 200} onClick={() => onGenerate(scene.id,count)}>{scene.status === 'generating' ? <LoaderCircle className="spin" size={16} /> : scene.candidates.length || scene.status === 'failed' ? <RotateCcw size={16} /> : <Sparkles size={16} />}{scene.status === 'generating' ? '生成中，请稍候' : scene.status === 'failed' ? '重试生成场景' : scene.candidates.length ? '重新生成场景' : '生成场景图'}</button><p className="scene-hint">生成纯环境参考图，人物在分镜中加入。</p></div>
        </div>
        {scene.error && <div className="notice error" role="alert"><AlertCircle size={16} /><span>{scene.error}</span></div>}
        <div className="candidate-heading"><div><h3>场景候选图 <span>{scene.candidates.length}</span></h3><p>选定一张后，在分镜的「关联场景」中使用</p></div><button className="text-button" disabled={disabled} onClick={() => uploadRef.current?.click()}>{uploading ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}上传场景图</button><input ref={uploadRef} type="file" className="sr-only" accept="image/png,image/jpeg,image/webp" multiple disabled={disabled} onChange={e => void upload(e)} /></div>
        <div className="candidates scene-candidates">{scene.candidates.map((c,i) => <div className={`candidate ${c.id === scene.selectedCandidateId ? 'chosen' : ''}`} key={c.id}><button className="candidate-image" aria-label={`放大场景候选图${i+1}`} onClick={() => setZoomId(c.id)}><img src={c.url} alt={`${scene.name}候选图 ${i+1}`} loading="lazy" /><span className="candidate-zoom"><Maximize2 size={17} /></span></button><div className="candidate-footer"><span>{String(i+1).padStart(2,'0')}<small>{c.source === 'generated' ? '生成' : c.source === 'sample' ? '示例' : '上传'}</small></span><button className={c.id === scene.selectedCandidateId ? 'is-selected' : ''} disabled={disabled} aria-label={`选用场景候选图${i+1}`} onClick={() => patch({ selectedCandidateId: c.id })}>{c.id === scene.selectedCandidateId ? <><Check size={13} />已选定</> : '选用'}</button></div></div>)}{!readOnly && <button className="candidate-add" disabled={disabled} onClick={() => uploadRef.current?.click()}><ImagePlus size={24} strokeWidth={1.3} /><span>上传已有场景</span><small>PNG、JPG、WebP · ≤10 MB</small></button>}</div>
        <div className="notice scene-note"><Mountain size={16} /><span>更新场景设定或参考图后，关联分镜的后续生成会使用新设定。已有分镜画面和选图会保留。</span></div>
      </div>
    </div>}
    {editing && <Modal title={scenes.some(s => s.id === editing.id) ? '编辑场景' : '创建场景'} onClose={() => setEditing(null)}><form className="modal-form" onSubmit={e => { e.preventDefault(); save(); }}><label>场景名称<input autoFocus required maxLength={120} value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="例如：海边车站 · 黄昏" /></label><label>场景描述<textarea rows={5} maxLength={4000} value={editing.description} onChange={e => setEditing({ ...editing, description: e.target.value })} placeholder="描述地点、空间布局、建筑、光线和标志性物件…" /></label><p className="muted small">保存后可生成候选图，或上传已有场景图。</p><div className="modal-actions"><button type="button" className="button" onClick={() => setEditing(null)}>取消</button><button className="button primary" disabled={disabled || !editing.name.trim()}>保存场景</button></div></form></Modal>}
    {deleting && <Modal title="删除场景" onClose={() => setDeleting(null)}><p className="modal-copy">确定删除「{deleting.name}」？{project.shots.filter(s => s.sceneId === deleting.id).length} 个分镜的场景关联将解除，已有分镜画面和选图会保留。</p><div className="modal-actions"><button className="button" onClick={() => setDeleting(null)}>取消</button><button className="button danger" disabled={disabled} onClick={() => { update(p => removeScene(p,deleting.id)); setDeleting(null); }}>删除场景</button></div></Modal>}
    {zoom && scene && <Modal title={`${scene.name} · 场景候选图`} wide onClose={() => setZoomId(null)}><div className="lightbox-image"><img src={zoom.url} alt={`${scene.name}场景大图`} /></div><div className="lightbox-controls"><button className="button" disabled={scene.candidates.length < 2} onClick={() => setZoomId(scene.candidates[(scene.candidates.findIndex(c => c.id === zoom.id) - 1 + scene.candidates.length) % scene.candidates.length].id)}>上一张</button><span className="muted">{scene.candidates.findIndex(c => c.id === zoom.id)+1} / {scene.candidates.length}</span><button className="button" disabled={scene.candidates.length < 2} onClick={() => setZoomId(scene.candidates[(scene.candidates.findIndex(c => c.id === zoom.id)+1) % scene.candidates.length].id)}>下一张</button><button className="button primary" disabled={disabled} onClick={() => { patch({ selectedCandidateId: zoom.id }); setZoomId(null); }}><Check size={16} />{scene.selectedCandidateId === zoom.id ? '已选为场景参考图' : '选为场景参考图'}</button></div></Modal>}
  </section>;
}
