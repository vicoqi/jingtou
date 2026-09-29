'use client';
import { useState } from 'react';
import { AlertCircle, Clock3 } from 'lucide-react';
import { isShotAudioStale } from '../lib/domain';
import { getShotTiming, MAX_PAUSE_DURATION, MAX_SHOT_DURATION } from '../lib/shot-timing';
import type { Project, Shot } from '../lib/types';

const seconds = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);

function SecondsInput({ label, value, min = 0, max, onChange }: {
  label: string;
  value: number;
  min?: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return <label>{label}<div className="unit-input">
    <input type="number" min={min} max={max} step="0.1" value={draft ?? String(value)}
      onChange={event => {
        const raw = event.currentTarget.value;
        setDraft(raw);
        const next = Number(raw);
        if (raw.trim() && Number.isFinite(next) && next >= min && next <= max) onChange(next);
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
    <span>秒</span>
  </div></label>;
}

export function ShotTimingControls({ project, shot, disabled, onChange }: {
  project: Project;
  shot: Shot;
  disabled: boolean;
  onChange: (patch: Partial<Shot>) => void;
}) {
  const stale = isShotAudioStale(project, shot);
  const timing = getShotTiming(shot, !stale);
  const generating = shot.audio.status === 'generating';
  const canFit = !disabled && !generating && timing.fitDuration !== null;
  const tooLong = timing.requiredDuration !== null && timing.fitDuration === null;
  const audioDuration = shot.audio.url ? shot.audio.duration : null;
  return <div className="shot-timing">
    <div className="shot-timing-heading"><Clock3 size={14} /><span>对白与节奏</span></div>
    <fieldset disabled={disabled} className="shot-timing-fields">
      <SecondsInput label="镜头时长" value={shot.duration} min={1} max={MAX_SHOT_DURATION} onChange={duration => onChange({ duration })} />
      <div className="field-row">
        <SecondsInput label="开口前停顿" value={shot.audioLeadIn} max={MAX_PAUSE_DURATION} onChange={audioLeadIn => onChange({ audioLeadIn })} />
        <SecondsInput label="说完后停留" value={shot.audioTailOut} max={MAX_PAUSE_DURATION} onChange={audioTailOut => onChange({ audioTailOut })} />
      </div>
    </fieldset>
    <div className="shot-timing-summary">
      <span>配音时长<strong>{audioDuration === null ? '尚未生成' : `${seconds(audioDuration)} 秒${stale ? '（旧配音）' : ''}`}</strong></span>
      {timing.requiredDuration !== null && <span>含停顿需<strong>{seconds(timing.requiredDuration)} 秒</strong></span>}
    </div>
    {timing.truncatedBy > 0.001
      ? <p className="shot-timing-warning" role="status"><AlertCircle size={13} />镜头结束时对白尚未播完，还差 {seconds(timing.truncatedBy)} 秒。</p>
      : timing.shortfall > 0.001 && <p className="shot-timing-warning" role="status"><AlertCircle size={13} />对白可以播完，但说完后的停留还差 {seconds(timing.shortfall)} 秒。</p>}
    <button type="button" className="button compact shot-timing-fit" disabled={!canFit}
      onClick={() => { if (canFit && timing.fitDuration !== null) onChange({ duration: timing.fitDuration }); }}>
      按配音调整时长{timing.fitDuration !== null && <span>{seconds(timing.fitDuration)} 秒</span>}
    </button>
    <p className="audio-hint">{stale ? '对白、语气或音色已修改，请更新配音后再适配时长。'
      : generating ? '配音生成中，完成后可按最新配音适配时长。'
      : tooLong ? `所需时长超过 ${MAX_SHOT_DURATION} 秒，请拆分对白或缩短停顿。`
      : timing.audioDuration === null ? '生成配音后可一键适配时长。停顿可提前设置。'
      : '点击适配才会修改镜头时长；修改停顿无需重新生成配音。'}</p>
  </div>;
}
