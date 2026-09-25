import { Mountain } from 'lucide-react';
import type { Scene, Shot } from '../lib/types';

export function ShotSceneField({ scenes, shot, disabled, onChange, onManage }: {
  scenes: Scene[];
  shot: Shot;
  disabled: boolean;
  onChange: (patch: Partial<Shot>) => void;
  onManage: () => void;
}) {
  const scene = scenes.find(s => s.id === shot.sceneId);
  const selected = scene?.candidates.find(c => c.id === scene.selectedCandidateId);
  return <div className="shot-scene-fields">
    <label>关联场景<select value={shot.sceneId ?? ''} disabled={disabled} onChange={e => onChange({ sceneId: e.target.value || null })}><option value="">不关联，仅使用场景描述</option>{scenes.map(s => <option key={s.id} value={s.id}>{s.name}{s.selectedCandidateId ? '' : ' · 待选图'}</option>)}</select></label>
    {scene && <button type="button" className={`shot-scene-reference ${!selected ? 'missing' : ''}`} disabled={disabled} onClick={onManage}>{selected ? <img src={selected.url} alt={`${scene.name}参考图`} /> : <Mountain size={18} />}<span>{selected ? '生成时使用此场景参考图' : '请先在场景生成中选定参考图'}</span></button>}
    {!scenes.length && <button type="button" className="text-button" disabled={disabled} onClick={onManage}><Mountain size={13} />创建可复用场景</button>}
    <label>{scene ? '场景补充说明' : '场景描述'}<input value={shot.scene} maxLength={500} disabled={disabled} onChange={e => onChange({ scene: e.target.value })} placeholder={scene ? '例如：改为雨夜，从长椅另一侧取景' : '例如：海边车站 · 黄昏'} /></label>
  </div>;
}
