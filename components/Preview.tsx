'use client';
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { Play, Pause, SkipBack, SkipForward, ImageOff, Volume2, VolumeX, LoaderCircle } from 'lucide-react';
import type { Project } from '../lib/types';
import { isShotAudioStale, isShotVideoStale } from '../lib/domain';
import { previewFrame, formatTime, advancePlayback, selectedMediaUrl } from '../lib/playback';
import { syncPreviewAudio } from '../lib/preview-audio';
import { advanceVideoPlayback, syncPreviewVideo } from '../lib/preview-video';
import { videoFirstFrameUrl } from '../lib/video-frames';

const videoKey = (shotId: string, url: string) => `${shotId}:${url}`;

export function Preview({ project }: { project: Project }) {
  const videoUsable = (shot: Project['shots'][number]) => !!selectedMediaUrl(shot.video, shot.video.selectedVideoId);
  const outdatedVideoShots=project.shots.flatMap((shot,i)=>isShotVideoStale(shot,project) ? [String(i+1).padStart(2,'0')] : []);
  const [{ time, playing }, setPlayback] = useState({ time: 0, playing: false });
  const [muted,setMuted]=useState(false);
  const [seekVersion,setSeekVersion]=useState(0);
  const [videoLoading,setVideoLoading]=useState(false);
  const [mediaError,setMediaError]=useState('');
  const timeRef=useRef(0);
  const audioRef=useRef<HTMLAudioElement>(null);
  const videosRef=useRef(new Map<string,HTMLVideoElement>());
  const videoSyncVersion=useRef(0);
  const frame = previewFrame(project.shots, time,
    shot=>!!shot.audio.url && !isShotAudioStale(project,shot),
    videoUsable);
  // Old candidates retain a compact input fingerprint, not their original dialogue.
  // Keep the chosen media, but don't put newly edited words over its old speech.
  const subtitle=frame.video && frame.shot && isShotVideoStale(frame.shot,project) ? '' : frame.subtitle;
  const activeVideoKey=frame.video && frame.shot ? videoKey(frame.shot.id,frame.video) : null;
  const nextVideoShot=project.shots.slice(frame.index+1).find(videoUsable);
  const nextVideoUrl=selectedMediaUrl(nextVideoShot?.video,nextVideoShot?.video.selectedVideoId);
  // Keep the next native element mounted when it becomes active: replacing src would
  // discard its buffer at exactly the cut, even when a hidden element had preloaded it.
  const videoClips=[
    ...(frame.video && frame.shot ? [{key:activeVideoKey!,url:frame.video,poster:videoFirstFrameUrl(project,frame.shot),active:true}] : []),
    ...(nextVideoShot && nextVideoUrl ? [{key:videoKey(nextVideoShot.id,nextVideoUrl),url:nextVideoUrl,poster:videoFirstFrameUrl(project,nextVideoShot),active:false}] : []),
  ];
  const clippedShots = frame.timingIssues.filter(issue=>issue.kind==='speech').map(issue=>String(issue.index+1).padStart(2,'0'));
  const shortTailShots = frame.timingIssues.filter(issue=>issue.kind==='tail').map(issue=>String(issue.index+1).padStart(2,'0'));
  const shotDuration = frame.duration;
  const audioLeadIn = frame.shot?.audioLeadIn ?? 0;
  const audioTailOut = frame.shot?.audioTailOut ?? 0;
  const audioDuration = frame.shot?.audio.duration ?? null;
  const seek=(nextTime:number)=>{
    const next=Math.max(0,Math.min(frame.total,nextTime));
    timeRef.current=next;
    setPlayback(state=>({...state,time:next}));
    setSeekVersion(version=>version + 1);
    setMediaError('');
  };
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last: number | null = null;
    const tick = (now: number) => {
      const delta = last === null ? 0 : (now - last) / 1000; last = now;
      setPlayback(state => {
        const next=activeVideoKey
          ? advanceVideoPlayback(state,Math.min(delta,0.25),frame.total,{start:frame.start,duration:shotDuration,mediaStart:frame.videoWindow.start,mediaEnd:frame.videoWindow.end},videosRef.current.get(activeVideoKey) ?? null)
          : advancePlayback(state,Math.min(delta,0.25),frame.total);
        timeRef.current=next.time;
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, frame.total, activeVideoKey, frame.start, shotDuration,frame.videoWindow.start,frame.videoWindow.end]);
  useEffect(()=>{
    const audio=audioRef.current;
    if (!audio) return;
    audio.muted=muted;
  },[muted]);
  useEffect(()=>{
    const audio=audioRef.current;
    if (!audio) return;
    audio.pause();
    if (!frame.audio) {
      audio.removeAttribute('src');
      audio.load();
      return;
    }
    if (audio.getAttribute('src')!==frame.audio) {
      audio.src=frame.audio;
      audio.load();
    }
    const sync=()=>{
      const localTime=Math.max(0,Math.min(shotDuration,timeRef.current - frame.start));
      void syncPreviewAudio(audio,{duration:shotDuration,audioLeadIn,audioTailOut,audio:{url:frame.audio,duration:audioDuration}},localTime,playing);
    };
    if (audio.readyState>=1) sync();
    else audio.addEventListener('loadedmetadata',sync,{once:true});
    return ()=>audio.removeEventListener('loadedmetadata',sync);
  },[frame.audio,frame.audioActive,frame.index,frame.start,shotDuration,audioLeadIn,audioTailOut,audioDuration,playing,seekVersion]);
  useEffect(()=>()=>{ const audio=audioRef.current; if (audio) { audio.pause(); audio.removeAttribute('src'); } },[]);
  const syncActiveVideo=useCallback(async()=>{
    if (!activeVideoKey) return;
    const video=videosRef.current.get(activeVideoKey);
    if (!video) return;
    const version=++videoSyncVersion.current;
    const localTime=Math.max(0,Math.min(shotDuration,timeRef.current - frame.start));
    const result=await syncPreviewVideo(video,localTime,playing,{start:frame.videoWindow.start,end:frame.videoWindow.end});
    if (version!==videoSyncVersion.current) return;
    setVideoLoading(result==='loading');
    if (result==='blocked') {
      setMediaError('浏览器未能开始播放，请再次点击播放。');
      setPlayback(state=>({...state,playing:false}));
    }
  },[activeVideoKey,frame.start,shotDuration,playing,frame.videoWindow.start,frame.videoWindow.end]);
  useLayoutEffect(()=>{
    for (const [key,video] of videosRef.current) if (key!==activeVideoKey) video.pause();
    const active=activeVideoKey ? videosRef.current.get(activeVideoKey) : null;
    const pendingSync=videoSyncVersion;
    void syncActiveVideo();
    return ()=>{ pendingSync.current++; active?.pause(); };
  },[activeVideoKey,syncActiveVideo,seekVersion]);
  const toggle = () => {
    if (!frame.total) return;
    const nextTime=time>=frame.total ? 0 : time;
    timeRef.current=nextTime;
    setPlayback({time:nextTime,playing:!playing});
    setMediaError('');
    if (nextTime!==time) setSeekVersion(version=>version + 1);
  };
  return <div className="preview-player" onKeyDown={e => { if (e.key === ' ' && (e.target as HTMLElement).tagName !== 'BUTTON' && (e.target as HTMLElement).tagName !== 'INPUT') { e.preventDefault(); toggle(); } }} tabIndex={0}>
    <audio ref={audioRef} preload="metadata" hidden />
    <div className={`preview-screen ratio-${project.aspectRatio === '9:16' ? 'portrait' : 'landscape'}`}>
      {videoClips.map(clip=><video key={clip.key} ref={node=>{ if (node) videosRef.current.set(clip.key,node); else videosRef.current.delete(clip.key); }} src={clip.url} poster={clip.poster} playsInline preload="auto" muted={clip.active ? muted : true} aria-hidden={!clip.active} className={`preview-video ${clip.active ? 'active' : ''}`}
        onLoadedMetadata={()=>{ if (clip.active) void syncActiveVideo(); }}
        onCanPlay={()=>{ if (clip.active) void syncActiveVideo(); }}
        onSeeked={()=>{ if (clip.active) void syncActiveVideo(); }}
        onPlaying={()=>{ if (clip.active) setVideoLoading(false); }}
        onWaiting={()=>{ if (clip.active) setVideoLoading(true); }}
        onSeeking={()=>{ if (clip.active) setVideoLoading(true); }}
        onError={()=>{ if (clip.active) { setVideoLoading(false); setMediaError(`镜头 ${frame.index+1} 的视频加载失败，请重新打开预览。`); setPlayback(state=>({...state,playing:false})); } }} />)}
      {!frame.video && (frame.image ? <img src={frame.image} alt={`镜头 ${frame.index + 1}：${frame.shot?.dialogue || '预览画面'}`} /> : <div className="empty-frame"><ImageOff size={36} /><h3>{frame.shot ? `镜头 ${String(frame.index + 1).padStart(2, '0')} 暂无选定画面` : '还没有分镜'}</h3><p>返回分镜台，为这个镜头选择一张画面</p></div>)}
      {frame.video && videoLoading && <div className="preview-buffering" role="status"><LoaderCircle size={16} className="spin" />视频缓冲中…</div>}
      {subtitle && <div className="subtitle">{subtitle}</div>}
      <span className="screen-label">{String(frame.index + 1).padStart(2, '0')} / {String(project.shots.length).padStart(2, '0')}</span>
    </div>
    {mediaError && <p className="notice error" role="alert">{mediaError}</p>}
    <div className="player-controls">
      <button className="icon-button" aria-label="回到开头" onClick={() => seek(0)}><SkipBack size={18} /></button>
      <button className="play-circle" aria-label={playing ? '暂停' : '播放'} disabled={!frame.total} onClick={toggle}>{playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button>
      <span className="timecode">{formatTime(time)}</span>
      <input aria-label="预览进度" type="range" min="0" max={frame.total || 1} step="0.05" value={Math.min(time, frame.total)} onChange={e => seek(Number(e.target.value))} />
      <span className="timecode muted">{formatTime(frame.total)}</span>
      <button className="icon-button" aria-label={muted ? '打开声音' : '静音'} aria-pressed={muted} onClick={()=>setMuted(value=>!value)}>{muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
      <button className="icon-button" aria-label="下一镜头" onClick={() => seek(frame.durations.slice(0, frame.index + 1).reduce((n, duration) => n + duration, 0))}><SkipForward size={18} /></button>
    </div>
    {frame.missing > 0 && <p className="notice warning">还有 {frame.missing} 个镜头未选图，将在对应位置显示缺失提示。</p>}
    {outdatedVideoShots.length>0 && <p className="notice warning">镜头 {outdatedVideoShots.join('、')} 的选定视频与当前设定不同，预览仍使用已选视频，并暂时隐藏该段字幕以免与原对白不一致；可切换候选或重新生成。</p>}
    {frame.missingAudio > 0 && <p className="notice warning preview-audio-warning">还有 {frame.missingAudio} 个对白镜头缺少最新配音，将在对应位置静音播放。</p>}
    {clippedShots.length>0 && <p className="notice warning preview-timing-warning">镜头 {clippedShots.join('、')} 的配音会在切镜头时截断，请在「对白与节奏」中调整时长。</p>}
    {shortTailShots.length>0 && <p className="notice warning preview-timing-warning">镜头 {shortTailShots.join('、')} 说完后的停留不足，可在「对白与节奏」中按配音适配时长。</p>}
    <div className="preview-sequence">{project.shots.map((shot, i) => <button key={shot.id} className={i === frame.index ? 'active' : ''} onClick={() => seek(frame.durations.slice(0, i).reduce((n, duration) => n + duration, 0))}><span>{String(i + 1).padStart(2, '0')}</span><span>{frame.durations[i]}s</span></button>)}</div>
    <p className="preview-note">视频按完整时长播放，静图按镜头设定时长播放 · 当前版本暂不支持视频导出</p>
  </div>;
}
