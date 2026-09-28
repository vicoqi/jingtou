'use client';
import { useState, useEffect, useRef } from 'react';
import { Play, Pause, SkipBack, SkipForward, ImageOff, Volume2, VolumeX } from 'lucide-react';
import type { Project } from '../lib/types';
import { isShotAudioStale } from '../lib/domain';
import { previewFrame, formatTime, advancePlayback } from '../lib/playback';

export function Preview({ project }: { project: Project }) {
  const [{ time, playing }, setPlayback] = useState({ time: 0, playing: false });
  const [muted,setMuted]=useState(false);
  const [seekVersion,setSeekVersion]=useState(0);
  const timeRef=useRef(0);
  const audioRef=useRef<HTMLAudioElement>(null);
  const frame = previewFrame(project.shots, time, shot=>!!shot.audio.url && !isShotAudioStale(project,shot));
  const last = useRef(0);
  const seek=(nextTime:number)=>{
    const next=Math.max(0,Math.min(frame.total,nextTime));
    timeRef.current=next;
    setPlayback(state=>({...state,time:next}));
    setSeekVersion(version=>version + 1);
  };
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    last.current = performance.now();
    const tick = (now: number) => {
      const delta = (now - last.current) / 1000; last.current = now;
      setPlayback(state => {
        const next=advancePlayback(state, delta, frame.total);
        timeRef.current=next.time;
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, frame.total]);
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
      const localTime=Math.max(0,Math.min(frame.shot?.duration ?? 0,timeRef.current - frame.start));
      try { audio.currentTime=Number.isFinite(audio.duration) ? Math.min(localTime,audio.duration) : localTime; } catch { /* Metadata may still be loading. */ }
      if (playing) void audio.play().catch(()=>{});
    };
    if (audio.readyState>=1) sync();
    else audio.addEventListener('loadedmetadata',sync,{once:true});
    return ()=>audio.removeEventListener('loadedmetadata',sync);
  },[frame.audio,frame.index,frame.shot?.duration,frame.start,playing,seekVersion]);
  useEffect(()=>()=>{ const audio=audioRef.current; if (audio) { audio.pause(); audio.removeAttribute('src'); } },[]);
  const toggle = () => {
    if (!frame.total) return;
    const nextTime=time>=frame.total ? 0 : time;
    timeRef.current=nextTime;
    setPlayback({time:nextTime,playing:!playing});
    if (nextTime!==time) setSeekVersion(version=>version + 1);
  };
  return <div className="preview-player" onKeyDown={e => { if (e.key === ' ' && (e.target as HTMLElement).tagName !== 'BUTTON' && (e.target as HTMLElement).tagName !== 'INPUT') { e.preventDefault(); toggle(); } }} tabIndex={0}>
    <audio ref={audioRef} preload="metadata" hidden />
    <div className={`preview-screen ratio-${project.aspectRatio === '9:16' ? 'portrait' : 'landscape'}`}>
      {frame.image ? <img src={frame.image} alt={`镜头 ${frame.index + 1}：${frame.shot?.dialogue || '预览画面'}`} /> : <div className="empty-frame"><ImageOff size={36} /><h3>{frame.shot ? `镜头 ${String(frame.index + 1).padStart(2, '0')} 暂无选定画面` : '还没有分镜'}</h3><p>返回分镜台，为这个镜头选择一张画面</p></div>}
      {frame.subtitle && <div className="subtitle">{frame.subtitle}</div>}
      <span className="screen-label">{String(frame.index + 1).padStart(2, '0')} / {String(project.shots.length).padStart(2, '0')}</span>
    </div>
    <div className="player-controls">
      <button className="icon-button" aria-label="回到开头" onClick={() => seek(0)}><SkipBack size={18} /></button>
      <button className="play-circle" aria-label={playing ? '暂停' : '播放'} disabled={!frame.total} onClick={toggle}>{playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button>
      <span className="timecode">{formatTime(time)}</span>
      <input aria-label="预览进度" type="range" min="0" max={frame.total || 1} step="0.05" value={Math.min(time, frame.total)} onChange={e => seek(Number(e.target.value))} />
      <span className="timecode muted">{formatTime(frame.total)}</span>
      <button className="icon-button" aria-label={muted ? '打开声音' : '静音'} aria-pressed={muted} onClick={()=>setMuted(value=>!value)}>{muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
      <button className="icon-button" aria-label="下一镜头" onClick={() => seek(project.shots.slice(0, frame.index + 1).reduce((n, s) => n + s.duration, 0))}><SkipForward size={18} /></button>
    </div>
    {frame.missing > 0 && <p className="notice warning">还有 {frame.missing} 个镜头未选图，将在对应位置显示缺失提示。</p>}
    {frame.missingAudio > 0 && <p className="notice warning preview-audio-warning">还有 {frame.missingAudio} 个对白镜头缺少最新配音，将在对应位置静音播放。</p>}
    <div className="preview-sequence">{project.shots.map((shot, i) => <button key={shot.id} className={i === frame.index ? 'active' : ''} onClick={() => seek(project.shots.slice(0, i).reduce((n, s) => n + s.duration, 0))}><span>{String(i + 1).padStart(2, '0')}</span><span>{shot.duration}s</span></button>)}</div>
    <p className="preview-note">画面、对白字幕与已生成配音按分镜时间同步播放 · 当前版本暂不支持视频导出</p>
  </div>;
}
