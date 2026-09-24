'use client';
import { useState, useEffect, useRef } from 'react';
import { Play, Pause, SkipBack, SkipForward, ImageOff, VolumeX } from 'lucide-react';
import type { Project } from '../lib/types';
import { previewFrame, formatTime, advancePlayback } from '../lib/playback';

export function Preview({ project }: { project: Project }) {
  const [{ time, playing }, setPlayback] = useState({ time: 0, playing: false });
  const setTime = (time: number) => setPlayback(state => ({ ...state, time }));
  const frame = previewFrame(project.shots, time);
  const last = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    last.current = performance.now();
    const tick = (now: number) => {
      const delta = (now - last.current) / 1000; last.current = now;
      setPlayback(state => advancePlayback(state, delta, frame.total));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, frame.total]);
  const toggle = () => setPlayback(state => ({ time: state.time >= frame.total ? 0 : state.time, playing: !state.playing }));
  return <div className="preview-player" onKeyDown={e => { if (e.key === ' ' && (e.target as HTMLElement).tagName !== 'BUTTON' && (e.target as HTMLElement).tagName !== 'INPUT') { e.preventDefault(); toggle(); } }} tabIndex={0}>
    <div className={`preview-screen ratio-${project.aspectRatio === '9:16' ? 'portrait' : 'landscape'}`}>
      {frame.image ? <img src={frame.image} alt={`镜头 ${frame.index + 1}：${frame.shot?.dialogue || '预览画面'}`} /> : <div className="empty-frame"><ImageOff size={36} /><h3>{frame.shot ? `镜头 ${String(frame.index + 1).padStart(2, '0')} 暂无选定画面` : '还没有分镜'}</h3><p>返回分镜台，为这个镜头选择一张画面</p></div>}
      <span className="screen-label">{String(frame.index + 1).padStart(2, '0')} / {String(project.shots.length).padStart(2, '0')}</span>
      {frame.shot?.dialogue && <div className="subtitle">{frame.shot.dialogue}</div>}
    </div>
    <div className="player-controls">
      <button className="icon-button" aria-label="回到开头" onClick={() => setTime(0)}><SkipBack size={18} /></button>
      <button className="play-circle" aria-label={playing ? '暂停' : '播放'} disabled={!frame.total} onClick={toggle}>{playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button>
      <span className="timecode">{formatTime(time)}</span>
      <input aria-label="预览进度" type="range" min="0" max={frame.total || 1} step="0.05" value={Math.min(time, frame.total)} onChange={e => setTime(Number(e.target.value))} />
      <span className="timecode muted">{formatTime(frame.total)}</span>
      <VolumeX size={17} className="muted" aria-label="静态画面预览，无音频" />
      <button className="icon-button" aria-label="下一镜头" onClick={() => setTime(Math.min(frame.total, project.shots.slice(0, frame.index + 1).reduce((n, s) => n + s.duration, 0)))}><SkipForward size={18} /></button>
    </div>
    {frame.missing > 0 && <p className="notice warning">还有 {frame.missing} 个镜头未选图，将在对应位置显示缺失提示。</p>}
    <div className="preview-sequence">{project.shots.map((shot, i) => <button key={shot.id} className={i === frame.index ? 'active' : ''} onClick={() => setTime(project.shots.slice(0, i).reduce((n, s) => n + s.duration, 0))}><span>{String(i + 1).padStart(2, '0')}</span><span>{shot.duration}s</span></button>)}</div>
    <p className="preview-note">画面按分镜时长连续播放 · 对白字幕已同步 · 当前版本不包含音频和视频导出</p>
  </div>;
}
