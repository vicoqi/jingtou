'use client';
import { useRef, useState, type ChangeEvent } from 'react';
import { Check, CheckCircle2, LoaderCircle, Maximize2, Sparkles, Upload, X } from 'lucide-react';
import type { Candidate, Project, Shot } from '../lib/types';
import { isShotCandidateRemovable } from '../lib/domain';
import { Modal } from './Modal';

export function ShotEndFrameModal({project,shot,disabled,locked,configured,generationError,onChange,onRemoveCandidate,onGenerate,onUpload,onClose}:{
  project:Project;
  shot:Shot;
  disabled:boolean;
  locked:boolean;
  configured:boolean;
  generationError:string;
  onChange:(patch:Partial<Shot>)=>void;
  onRemoveCandidate:(candidateId:string)=>void;
  onGenerate:(count:number)=>void;
  onUpload:(files:File[])=>Promise<void>;
  onClose:()=>void;
}) {
  const [count,setCount]=useState(1);
  const [error,setError]=useState('');
  const [zoom,setZoom]=useState<Candidate|null>(null);
  const uploadRef=useRef<HTMLInputElement>(null);
  const generating=shot.status==='generating';
  const firstFrame=shot.candidates.find(candidate=>candidate.id===shot.selectedCandidateId);
  const endFrame=shot.candidates.find(candidate=>candidate.id===shot.selectedEndCandidateId);
  const displayedError=error || generationError || (shot.generationFrame==='end' ? shot.error : null);
  const select=(candidate:Candidate)=>{
    if (!disabled && !locked) onChange({selectedEndCandidateId:candidate.id});
  };
  const upload=async(event:ChangeEvent<HTMLInputElement>)=>{
    const files=Array.from(event.target.files ?? []);
    event.target.value='';
    if (disabled || !files.length) return;
    setError('');
    try { await onUpload(files); } catch(e) { setError((e as Error).message); }
  };
  const remove=(candidateId:string)=>{
    if (disabled || locked || !isShotCandidateRemovable(project,shot,candidateId)) return;
    onRemoveCandidate(candidateId);
    if (zoom?.id===candidateId) setZoom(null);
  };
  return <>
    <Modal title={`${shot.title || '当前镜头'} · 尾帧设置`} wide onClose={onClose}>
      <div className="modal-form end-frame-editor">
        <p className="muted">尾帧用于指定这个镜头的结束画面。可以生成、上传或选择已有候选图；不选尾帧时，模型会从首帧自然完成动作。</p>
        {firstFrame && <div className="end-frame-summary"><img src={firstFrame.url} alt="当前镜头首帧" /><span><strong>当前首帧</strong><small>生成尾帧时会参考这张图，保持角色与场景一致。</small></span></div>}
        <label>尾帧描述<textarea rows={3} maxLength={4000} disabled={disabled} value={shot.endFrameDescription ?? ''} onChange={e=>onChange({endFrameDescription:e.target.value})} placeholder="描述动作结束时的姿势、表情、位置与构图，例如：少女坐在台阶上，信已展开，抬头望向晨光。" /></label>
        <div className="row end-frame-actions">
          <select aria-label="尾帧候选数量" disabled={disabled || generating} value={count} onChange={e=>setCount(Number(e.target.value))}>{[1,2,3,4].map(n=><option key={n} value={n}>{n} 张</option>)}</select>
          <button type="button" className="button primary compact" disabled={disabled || generating || !configured || !firstFrame || !shot.endFrameDescription?.trim() || shot.candidates.length + count > 200} onClick={()=>{setError('');onGenerate(count);}}>{generating ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{generating ? '正在生成候选图' : shot.status==='failed' && shot.generationFrame==='end' ? '重试生成尾帧' : '生成尾帧候选'}</button>
          <button type="button" className="button compact" disabled={disabled || shot.candidates.length >= 200} onClick={()=>uploadRef.current?.click()}><Upload size={15} />上传尾帧</button>
          <input ref={uploadRef} className="sr-only" type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={e=>void upload(e)} />
        </div>
        {!firstFrame && <p className="notice warning">AI 生成尾帧前，请先为当前镜头选择首帧。也可以直接上传或选择已有图片。</p>}
        {!configured && <p className="notice warning">请先配置生图服务，再生成尾帧；仍可上传或选择已有图片。</p>}
        {locked && <p className="notice warning">当前镜头正在生成视频，首尾帧选图已锁定，完成后可更换。</p>}
        {displayedError && <p className="notice error" role="alert">{displayedError}</p>}
        <div className="candidate-heading"><div><h3>可选画面 <span>{shot.candidates.length}</span></h3><p>新图会保留在镜头候选中，由你决定是否选为尾帧。</p></div></div>
        <div className="candidates">{[...shot.candidates].reverse().map(candidate=>{
          const chosen=candidate.id===shot.selectedEndCandidateId;
          return <div className={`candidate ${chosen ? 'chosen' : ''}`} key={candidate.id}>
            <button type="button" className="candidate-image" aria-label="放大尾帧候选图" onClick={()=>setZoom(candidate)}><img src={candidate.url} alt="尾帧候选画面" loading="lazy" /><span className="candidate-zoom"><Maximize2 size={16} /></span></button>{isShotCandidateRemovable(project,shot,candidate.id) && <button type="button" className="remove-candidate" disabled={disabled || locked} onClick={()=>remove(candidate.id)} aria-label={`删除尾帧候选图${shot.candidates.findIndex(item=>item.id===candidate.id)+1}`} title="删除这张候选图"><X size={13} /></button>}
            <div className="candidate-footer"><span>{candidate.frame==='end' ? '尾帧候选' : candidate.id===shot.selectedCandidateId ? '当前首帧' : '已有画面'}</span><button type="button" disabled={disabled || locked} className={chosen ? 'is-selected' : ''} onClick={()=>select(candidate)}>{chosen ? <><CheckCircle2 size={13} />已选尾帧</> : '选为尾帧'}</button></div>
          </div>;
        })}</div>
        <div className="modal-actions spread"><button type="button" className="text-button" disabled={disabled || locked || !endFrame} onClick={()=>onChange({selectedEndCandidateId:null})}>移除尾帧选图</button><button type="button" className="button" onClick={onClose}>完成</button></div>
      </div>
    </Modal>
    {zoom && <Modal title="尾帧候选画面" wide onClose={()=>setZoom(null)}><div className="lightbox-image"><img src={zoom.url} alt="尾帧候选大图" /></div><div className="modal-actions"><button type="button" className="button" onClick={()=>setZoom(null)}>关闭大图</button><button type="button" className="button primary" disabled={disabled || locked} onClick={()=>{select(zoom);setZoom(null);}}><Check size={15} />选为尾帧</button></div></Modal>}
  </>;
}
