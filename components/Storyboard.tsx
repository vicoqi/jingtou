'use client';
import { useState } from 'react';
import { Check, LoaderCircle, Trash2, UsersRound, WandSparkles } from 'lucide-react';
import type { Project, StoryboardDraft } from '../lib/types';
import { Modal } from './Modal';

const MAX_STORY_LENGTH = 20000;
const nameKey = (name: string) => name.trim().toLowerCase();

export function StoryboardComposer({ busy, configured, initialStory, onClose, onSubmit }: { busy: boolean; configured: boolean; initialStory?: string; onClose: () => void; onSubmit: (story: string, count: number | null) => Promise<void> }) {
  const [story, setStory] = useState(initialStory ?? '');
  const [count, setCount] = useState('');
  const [working, setWorking] = useState(false);
  const trimmed = story.trim();
  const parsedCount = count.trim() ? Number(count) : null;
  const countValid = parsedCount === null || (Number.isInteger(parsedCount) && parsedCount >= 4 && parsedCount <= 60);
  const invalid = !trimmed || trimmed.length > MAX_STORY_LENGTH || !countValid;
  return <Modal title="AI 拆镜头" onClose={onClose}>
    <form className="modal-form" onSubmit={async e => {
      e.preventDefault();
      if (invalid || working) return;
      setWorking(true);
      try { await onSubmit(trimmed, parsedCount); onClose(); } finally { setWorking(false); }
    }}>
      <p className="muted">粘贴一段故事，AI 会拆解成分镜草稿；确认之前不会改动作品。</p>
      <label>故事文本<textarea rows={10} value={story} maxLength={MAX_STORY_LENGTH} onChange={e => setStory(e.target.value)} placeholder="把你的故事粘贴到这里…" /></label>
      <p className="field-hint">{trimmed.length}/{MAX_STORY_LENGTH} 字符</p>
      <label>期望镜头数（可选）<input inputMode="numeric" value={count} onChange={e => setCount(e.target.value.replace(/[^0-9]/g, ''))} placeholder="4–60，留空由 AI 根据故事长度决定" /></label>
      {!configured && <p className="notice warning">尚未配置百炼 API Key，请先在生成服务设置中了解配置方式。</p>}
      {!countValid && <p className="notice warning">期望镜头数必须是 4–60 的整数。</p>}
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>取消</button>
        <button className="button primary" disabled={invalid || working || !configured || busy}>{working ? <LoaderCircle size={16} className="spin" /> : <WandSparkles size={16} />}开始拆分</button>
      </div>
    </form>
  </Modal>;
}

export function StoryboardDraftModal({ project, draft, busy, onClose, onDiscard, onConfirm }: { project: Project; draft: StoryboardDraft; busy: boolean; onClose: (selectId?: string) => void; onDiscard: () => void; onConfirm: (keptIndexes: number[]) => Promise<string | null> }) {
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const keptIndexes = draft.shots.map((_, i) => i).filter(i => !removed.has(i));
  const usedNames = new Map<string, string>();
  for (const shot of keptIndexes.map(i => draft.shots[i])) for (const name of [...shot.characters, ...(shot.speaker ? [shot.speaker] : [])]) { const key = nameKey(name); if (key && !usedNames.has(key)) usedNames.set(key, name.trim()); }
  const confirm = async () => {
    setWorking(true); setError('');
    try { const selectId = await onConfirm(keptIndexes); onClose(selectId ?? undefined); }
    catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  };
  return <Modal title="AI 分镜草稿" wide onClose={() => onClose()}>
    <div className="modal-form">
      {error && <p className="notice error">{error}</p>}
      <div className="storyboard-summary">
        <strong>识别出 {usedNames.size} 个人物</strong>
        <div className="character-chips">
          {[...usedNames.entries()].map(([key, name]) => {
            const existing = project.characters.find(c => nameKey(c.name) === key);
            const description = draft.characters.find(c => nameKey(c.name) === key)?.description;
            return <span key={key} className="character-chip selected" title={description || '外观待补充'}><UsersRound size={14} />{name}{existing ? ' · 复用' : ' · 新建'}</span>;
          })}
        </div>
      </div>
      <div className="storyboard-shot-list">
        {draft.shots.map((shot, i) => removed.has(i) ? null : <article key={i} className="storyboard-shot-card">
          <header><span>{String(i + 1).padStart(2, '0')}</span><strong>{shot.title}</strong><span className="tag">{shot.duration}s</span><button className="icon-button danger-hover" aria-label={`删除草稿镜头${i + 1}`} disabled={busy} onClick={() => setRemoved(prev => new Set(prev).add(i))}><Trash2 size={14} /></button></header>
          <dl>
            <div><dt>场景</dt><dd>{shot.scene || '—'}</dd></div>
            <div><dt>画面</dt><dd>{shot.description}</dd></div>
            <div><dt>对白</dt><dd>{shot.dialogue || '—'}</dd></div>
            <div><dt>人物</dt><dd>{[...new Set([...shot.characters, ...(shot.speaker ? [shot.speaker] : [])])].join('、') || '—'}</dd></div>
          </dl>
        </article>)}
      </div>
      <div className="modal-actions spread">
        <button className="text-button danger-text" disabled={busy || working} onClick={onDiscard}><Trash2 size={15} />放弃草稿</button>
        <div className="row">
          <button className="button" disabled={busy || working} onClick={() => onClose()}>稍后再说</button>
          <button className="button primary" disabled={busy || working || !keptIndexes.length} onClick={() => void confirm()}>{working ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}添加 {keptIndexes.length} 个分镜</button>
        </div>
      </div>
      <p className="muted small">写入后可在镜头设定中继续微调；同名角色已自动复用。</p>
    </div>
  </Modal>;
}
