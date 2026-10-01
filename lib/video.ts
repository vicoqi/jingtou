import type { ImageBytes } from './generation.ts';
import { isRecord } from './domain.ts';
import { publicHttpsUrl } from './http.ts';
import type { Project, Shot } from './types.ts';
import { getVideoFrameContext } from './video-frames.ts';

export const DEFAULT_WAN_VIDEO_MODEL = 'wan3.0-video';
export const WAN_VIDEO_BASE_URL = 'https://maas.qianwenaiapi.com';
export const WAN_VIDEO_RESOLUTION = '720P';
export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
export const MIN_WAN_VIDEO_DURATION = 2;
export const MAX_WAN_VIDEO_DURATION = 30;

const VIDEO_TASK_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'UNKNOWN'] as const;
export type VideoTaskStatus = typeof VIDEO_TASK_STATUSES[number];
export type VideoTask = { status: VideoTaskStatus; videoUrl: string | null; duration: number | null; error: string | null };
export type FirstFrameImage = ImageBytes;

export function clampVideoDuration(duration: number): number {
  const seconds = Math.round(Number(duration));
  if (!Number.isFinite(seconds)) return 5;
  return Math.min(MAX_WAN_VIDEO_DURATION, Math.max(MIN_WAN_VIDEO_DURATION, seconds));
}

export function buildVideoPrompt(project: Project, shot: Shot): string {
  const description = shot.description.trim();
  if (!description) throw new Error('请先填写画面描述。');
  const dialogue = shot.dialogue.trim();
  const speaker = shot.speakerCharacterId ? project.characters.find(character => character.id === shot.speakerCharacterId) : null;
  if (dialogue && !speaker) throw new Error('请从出场角色中选择说话角色。');
  const duration = clampVideoDuration(shot.duration);
  const style = project.style.trim();
  const { currentFrame, endFrame } = getVideoFrameContext(project, shot);
  if (!currentFrame) throw new Error('请先为当前镜头选定首帧画面。');
  const lines = [
    `生成连续单镜头，总时长约 ${duration} 秒，画幅比例 ${project.aspectRatio}，一镜到底，不切镜头。`,
    endFrame
      ? '首尾帧约束：从首帧画面开始连续运动，平滑过渡到尾帧画面；在视频结束时到达尾帧的角色姿势、位置和构图，避免提前到达尾帧后长时间停住。'
      : '首帧约束：从当前镜头的首帧画面开始，按描述连续完成动作与运镜。不要求与其他镜头画面相接，不要在开头重复起步或加入无意义的静止等待。',
    `画风：遵循${endFrame ? '首尾两张参考图' : '首帧参考图'}的画风${style ? `（${style}）` : ''}，保持同一角色的身份、服装、主要配饰与场景布局一致。`,
    `剧情与动作：${description}`,
  ];
  if (shot.audioLeadIn > 0) lines.push(`开场先铺垫约 ${shot.audioLeadIn} 秒，角色尚未开口，之后再进入台词。`);
  if (dialogue) {
    const tone = shot.voiceInstruction.trim();
    lines.push(`台词：${speaker!.name}${tone ? `（${tone}）` : ''}说："${dialogue.replace(/"/g, '＂')}"，台词语音与角色口型同步。`);
  } else {
    lines.push('台词：无台词。');
  }
  lines.push('音效：保留台词人声与环境音效，无背景音乐。');
  lines.push('负向清单：不要字幕、不要水印、不要复杂文字、不要人脸变形、不要人物换脸、不要肢体扭曲、不要多余手指。');
  return lines.join('\n');
}

function toDataUri(image: FirstFrameImage): string {
  // 3-byte aligned chunks keep every intermediate btoa output padding-free, so
  // no full-length binary string is ever built.
  let base64 = '';
  const chunk = 3 * 0x4000;
  for (let offset = 0; offset < image.bytes.length; offset += chunk) {
    base64 += btoa(String.fromCharCode(...image.bytes.subarray(offset, offset + chunk)));
  }
  return `data:${image.mime};base64,${base64}`;
}

export function detectVideoMime(bytes: Uint8Array): 'video/mp4' | null {
  if (bytes.length < 12) return null;
  return String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === 'ftyp' ? 'video/mp4' : null;
}

export function wanVideoDownloadUrl(value: unknown): string {
  // The endpoint may be a relay (e.g. qianwenaiapi.com) whose download URLs are not Alibaba OSS
  // hosts, so trust any public https URL via the shared SSRF floor.
  return publicHttpsUrl(value, 'Video provider').toString();
}

export async function submitWanVideoTask(options: { key: string; model?: string; baseUrl?: string; prompt: string; firstFrame: FirstFrameImage; lastFrame?: FirstFrameImage | null; duration: number; fetcher?: typeof fetch }): Promise<string> {
  if (!options.key) throw new Error('Qwen API key is required');
  const fetcher = options.fetcher ?? fetch;
  const base = (options.baseUrl?.trim() || WAN_VIDEO_BASE_URL).replace(/\/$/, '');
  const response = await fetcher(`${base}/api/v1/services/aigc/video-generation/video-synthesis`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.key}`, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({
      model: options.model?.trim() || DEFAULT_WAN_VIDEO_MODEL,
      input: { prompt: options.prompt, media: [
        { type: 'first_frame', url: toDataUri(options.firstFrame) },
        ...(options.lastFrame ? [{ type: 'last_frame', url: toDataUri(options.lastFrame) }] : []),
      ] },
      parameters: { resolution: WAN_VIDEO_RESOLUTION, ratio: 'adaptive', duration: clampVideoDuration(options.duration), audio: true, prompt_extend: false },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Video provider failed (${response.status})`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error('Video provider returned an invalid response'); }
  const output = isRecord(payload) && isRecord(payload.output) ? payload.output : null;
  const taskId = output && typeof output.task_id === 'string' ? output.task_id : '';
  if (!taskId) throw new Error('Video provider returned no task id');
  return taskId;
}

export async function checkWanVideoTask(options: { key: string; taskId: string; baseUrl?: string; fetcher?: typeof fetch }): Promise<VideoTask> {
  if (!options.key) throw new Error('Qwen API key is required');
  const fetcher = options.fetcher ?? fetch;
  const base = (options.baseUrl?.trim() || WAN_VIDEO_BASE_URL).replace(/\/$/, '');
  const response = await fetcher(`${base}/api/v1/tasks/${encodeURIComponent(options.taskId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${options.key}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Video task query failed (${response.status})`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error('Video provider returned an invalid response'); }
  const output = isRecord(payload) && isRecord(payload.output) ? payload.output : null;
  const rawStatus = output ? String(output.task_status) : '';
  if (!VIDEO_TASK_STATUSES.includes(rawStatus as VideoTaskStatus)) throw new Error('Video provider returned an invalid task status');
  const status = rawStatus as VideoTaskStatus;
  const videoUrl = status === 'SUCCEEDED' && typeof output!.video_url === 'string' ? wanVideoDownloadUrl(output!.video_url) : null;
  if (status === 'SUCCEEDED' && !videoUrl) throw new Error('Video provider returned no video URL');
  const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : null;
  const usageDuration = usage && Number.isFinite(Number(usage.duration)) && Number(usage.duration) > 0 ? Number(usage.duration) : null;
  const code = output && typeof output.code === 'string' ? output.code : '';
  const message = output && typeof output.message === 'string' ? output.message : '';
  const error = status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN' ? `${message || '视频生成失败'}${code ? `（${code}）` : ''}`.slice(0, 500) : null;
  return { status, videoUrl, duration: usageDuration, error };
}

export async function downloadWanVideo(url: string, fetcher?: typeof fetch): Promise<{ bytes: Uint8Array; mime: 'video/mp4' }> {
  const response = await (fetcher ?? fetch)(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Video download failed (${response.status})`);
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > MAX_VIDEO_BYTES) throw new Error('Video provider response is too large');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_VIDEO_BYTES) throw new Error('Video provider response is too large');
  const mime = detectVideoMime(bytes);
  if (!mime) throw new Error('Video provider returned an invalid video file');
  return { bytes, mime };
}
