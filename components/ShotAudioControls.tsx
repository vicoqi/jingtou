'use client';
import { AlertCircle, LoaderCircle, Mic2, RefreshCw, Settings2, Volume2 } from 'lucide-react';
import { isShotAudioStale } from '../lib/domain';
import type { Project, Shot } from '../lib/types';

export function ShotAudioControls({project,shot,disabled,speechConfigured,onChange,onInstructionChange,onGenerate,onSettings}:{
  project:Project;
  shot:Shot;
  disabled:boolean;
  speechConfigured:boolean;
  onChange:(speakerCharacterId:string | null)=>void;
  onInstructionChange:(instruction:string)=>void;
  onGenerate:()=>void;
  onSettings:()=>void;
}) {
  const speakers=project.characters.filter(character=>shot.characterIds.includes(character.id));
  const speaker=speakers.find(character=>character.id===shot.speakerCharacterId);
  const stale=isShotAudioStale(project,shot);
  const generating=shot.audio.status==='generating';
  const ready=!!shot.audio.url;
  const invalid=!shot.dialogue.trim() || !speaker;
  const status=generating ? '正在生成配音…' : shot.audio.status==='failed' ? '生成失败，可重试' : stale ? '对白、语气或音色已修改，建议更新' : ready ? '配音已就绪' : '尚未生成配音';
  return <div className="shot-audio">
    <div className="shot-audio-heading"><span><Mic2 size={14} />对白配音</span><span className={`audio-status ${generating ? 'generating' : shot.audio.status==='failed' ? 'failed' : stale ? 'stale' : ready ? 'ready' : ''}`}>{generating && <LoaderCircle size={11} className="spin" />}{status}</span></div>
    <label>说话角色<select value={shot.speakerCharacterId ?? ''} onChange={event=>onChange(event.target.value || null)}><option value="">请选择出场角色</option>{speakers.map(character=><option key={character.id} value={character.id}>{character.name} · {character.voice==='female' ? '女声' : '男声'}</option>)}</select></label>
    <label className="shot-audio-instruction">语气描述（可选）<textarea rows={2} maxLength={500} value={shot.voiceInstruction} onChange={event=>onInstructionChange(event.target.value)} placeholder="例如：温柔地说，语速稍慢，结尾带一点释然" /><span className="audio-hint">可描述情绪、语速、音调和表达风格。</span></label>
    {!speakers.length && <p className="audio-hint">先在上方选择出场角色，再指定本镜头的说话角色。</p>}
    {shot.audio.url && <audio key={shot.audio.url} className="shot-audio-player" controls preload="metadata" src={shot.audio.url}>浏览器不支持音频播放。</audio>}
    {shot.audio.error && <p className="audio-error"><AlertCircle size={13} />{shot.audio.error}</p>}
    <div className="shot-audio-actions"><button type="button" className="button compact" disabled={disabled || generating || invalid} onClick={speechConfigured ? onGenerate : onSettings}>{generating ? <LoaderCircle size={14} className="spin" /> : ready ? <RefreshCw size={14} /> : <Volume2 size={14} />}{generating ? '生成中' : ready ? '重新生成配音' : '生成配音'}</button><button type="button" className="icon-button" aria-label="查看配音配置" title="配音配置" onClick={onSettings}><Settings2 size={13} /></button></div>
    <p className="audio-hint">生成失败时会保留上一版配音；修改对白、语气或角色音色后需手动重新生成。</p>
  </div>;
}
