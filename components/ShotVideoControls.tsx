'use client';
import { AlertCircle, CheckCircle2, Film, LoaderCircle, RefreshCw, Settings2 } from 'lucide-react';
import { isShotVideoStale, MAX_VIDEO_CANDIDATES } from '../lib/domain';
import { selectedMediaUrl } from '../lib/playback';
import { getVideoFrameContext, videoFirstFrameUrl } from '../lib/video-frames';
import type { Candidate, Project, Shot } from '../lib/types';

function pad(index: number): string {
  return String(index + 1).padStart(2, '0');
}

export function ShotVideoControls({project,shot,disabled,videoConfigured,onGenerate,onSettings,onEndFrame,onRemoveEndFrame,onZoom,onSelect}:{
  project:Project;
  shot:Shot;
  disabled:boolean;
  videoConfigured:boolean;
  onGenerate:()=>void;
  onSettings:()=>void;
  onEndFrame:()=>void;
  onRemoveEndFrame:()=>void;
  onZoom:(candidate:Candidate)=>void;
  onSelect:(videoId:string)=>void;
}) {
  const stale=isShotVideoStale(shot,project);
  const { currentFrame, endFrame }=getVideoFrameContext(project,shot);
  const generating=shot.video.status==='generating';
  const selectedUrl=selectedMediaUrl(shot.video,shot.video.selectedVideoId);
  const selectedIndex=shot.video.candidates.findIndex(video=>video.id===shot.video.selectedVideoId);
  const invalid=!currentFrame || !shot.description.trim();
  const status=generating ? shot.video.error ? '等待恢复，将自动重试…' : '正在生成视频…' : shot.video.status==='failed' ? '生成失败，可重试' : stale ? '素材或生成设定已修改，建议更新' : selectedUrl ? `已选视频（共 ${shot.video.candidates.length} 个候选）` : shot.video.candidates.length ? '尚未选用视频' : '尚未生成视频';
  return <div className="shot-audio">
    <div className="shot-audio-heading"><span><Film size={14} />镜头视频</span><span className={`audio-status ${generating ? 'generating' : shot.video.status==='failed' ? 'failed' : stale ? 'stale' : selectedUrl ? 'ready' : ''}`}>{generating && <LoaderCircle size={11} className="spin" />}{status}</span></div>
    <div className="video-frame-pair">
      <div className="video-frame-reference"><strong>首帧 · 当前镜头</strong>{currentFrame ? <button type="button" className="video-frame-image" aria-label="放大首帧" onClick={()=>onZoom(currentFrame)}><img src={currentFrame.url} alt={`${shot.title}首帧`} loading="lazy" /></button> : <div className="video-frame-empty">请在候选画面中选图</div>}<span>沿用当前镜头选定画面</span></div>
      <div className="video-frame-reference"><strong>尾帧 · 可选</strong>{endFrame ? <button type="button" className="video-frame-image" aria-label="查看尾帧设置" onClick={onEndFrame}><img src={endFrame.url} alt={`${shot.title}尾帧`} loading="lazy" /></button> : <div className="video-frame-empty">由模型自然完成动作</div>}<div className="row"><button type="button" className="text-button" onClick={onEndFrame}>{endFrame ? '更换尾帧' : '添加尾帧'}</button>{endFrame && <button type="button" className="text-button" disabled={disabled || generating} onClick={onRemoveEndFrame}>移除</button>}</div></div>
    </div>
    {!currentFrame && <p className="audio-hint">请先为当前镜头选定首帧画面，再生成视频。</p>}
    {!!shot.video.candidates.length && <label className="shot-video-selection">成片视频<select disabled={disabled} value={shot.video.selectedVideoId ?? ''} onChange={event=>onSelect(event.target.value)}><option value="" disabled>请选择用于成片的视频</option>{shot.video.candidates.map((video,i)=><option key={video.id} value={video.id}>候选视频 {pad(i)}{video.duration ? ` · ${video.duration} 秒` : ''}</option>)}</select><span className="audio-hint">{selectedIndex >= 0 ? `成片预览使用候选视频 ${pad(selectedIndex)}；重新生成会保留当前选择。` : '选定一个视频后，用于这个镜头的成片预览。'}</span></label>}
    {selectedUrl && <video key={selectedUrl} className="shot-audio-player shot-video-player" controls playsInline preload="metadata" src={selectedUrl}>浏览器不支持视频播放。</video>}
    {stale && selectedUrl && <p className="audio-hint">已选视频与当前设定不同，成片预览仍使用这段视频，并暂时隐藏该段字幕；可选择其他候选或重新生成。</p>}
    {shot.video.error && <p className={generating ? 'audio-hint' : 'audio-error'}><AlertCircle size={13} />{shot.video.error}</p>}
    <div className="shot-audio-actions"><button type="button" className="button compact" disabled={disabled || generating || invalid} onClick={videoConfigured ? onGenerate : onSettings}>{generating ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{generating ? '生成中' : shot.video.candidates.length ? '再生成一个候选' : '生成视频'}</button><button type="button" className="icon-button" aria-label="查看视频生成配置" title="视频生成配置" onClick={onSettings}><Settings2 size={13} /></button></div>
    <p className="audio-hint">{endFrame ? '已启用首尾帧，描述从起始画面到结束画面的动作与运镜。' : '只使用当前首帧，按描述完成动作；需要指定结束画面时再添加尾帧。'}每次生成追加一个视频候选（最多 {MAX_VIDEO_CANDIDATES} 个），自带对白与环境音效，可同时生成多个镜头。</p>
  </div>;
}

export function ShotVideoCandidates({project,shot,disabled,onSelect}:{
  project:Project;
  shot:Shot;
  disabled:boolean;
  onSelect:(videoId:string)=>void;
}) {
  if (!shot.video.candidates.length) return null;
  return <>
    <div className="candidate-heading"><div><h3>视频候选 <span>{shot.video.candidates.length}</span></h3><p>每个镜头选定一个用于成片，可随时切换；选择会自动保存</p></div></div>
    <div className="candidates">{shot.video.candidates.map((video,i) => {
      const chosen=video.id===shot.video.selectedVideoId;
      return <div className={`candidate video-candidate ${chosen ? 'chosen' : ''}`} key={video.id}>
        <div className="video-candidate-media"><video src={video.url} poster={videoFirstFrameUrl(project,shot,video)} controls playsInline preload="none" aria-label={`视频候选 ${i + 1}`} />{chosen && <span className="video-candidate-selected"><CheckCircle2 size={12} />用于成片</span>}</div>
        <div className="candidate-footer"><span>{pad(i)}<small>{video.duration ? `${video.duration}s` : '视频'}</small></span><button type="button" disabled={disabled} aria-label={`选用视频候选${i + 1}`} aria-pressed={chosen} className={chosen ? 'is-selected' : ''} onClick={() => onSelect(video.id)}>{chosen ? <><CheckCircle2 size={13} />已选定</> : '选为成片'}</button></div>
      </div>;
    })}</div>
  </>;
}
