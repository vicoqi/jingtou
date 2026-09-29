import type { DraftCharacter, DraftShot } from './types.ts';
import { MAX_REQUESTED_SHOTS, MAX_STORY_LENGTH, MIN_REQUESTED_SHOTS } from './domain.ts';
import { MAX_SHOT_DURATION } from './shot-timing.ts';

export const DEFAULT_STORYBOARD_MODEL = 'qwen-max';
export const STORYBOARD_LLM_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const clip = (value: unknown, max: number): string => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function buildStoryboardMessages(story: string, requestedCount: number | null): { system: string; user: string } {
  const system = [
    '你是一位专业的动漫短剧分镜师，负责把故事文本拆解成可直接制作的分镜脚本。',
    '要求：',
    '1. 按叙事节奏把故事拆成有序镜头。每个镜头包含：title（简短镜头名）、scene（地点与环境短语）、description（画面描述：景别、人物动作、表情、光线、构图，约 40–200 字）、dialogue（该镜头说出的对白，尽量使用故事原文，无声镜头为空字符串）、duration（建议秒数，1–60 的整数）、speaker（说话人物名，无对白为 null）、characters（出场人物名数组）。',
    '2. 从故事细节推断每个出场人物的外观（发型发色、服装、年龄感、标志性配饰等，约 30–150 字），输出 characters 列表，必须覆盖所有出场人物，不要遗漏。',
    '3. 只使用故事中出现的信息，不要虚构故事之外的关键设定。',
    '4. duration 参考对白长度与画面节奏：无对白镜头 1–6 秒，有对白镜头按语速估算。',
    '5. 严格输出一个 JSON 对象，不要输出 markdown 代码块或其他文字。格式：',
    '{"characters":[{"name":"人物名","description":"外观描述"}],"shots":[{"title":"镜头名","scene":"场景","description":"画面描述","dialogue":"对白","duration":5,"speaker":"人物名或null","characters":["出场人物"]}]}',
  ].join('\n');
  const user = `${requestedCount ? `请把故事拆成约 ${requestedCount} 个镜头（允许上下 20% 偏差）。\n\n` : ''}${story}`;
  return { system, user };
}

function normalizeShot(value: Record<string, unknown>): DraftShot {
  const dialogue = clip(value.dialogue, 600);
  const suggested = Number(value.duration);
  const fromDialogue = dialogue ? Math.ceil(dialogue.length / 4) : 0;
  const duration = clamp(Math.max(clamp(Number.isFinite(suggested) ? suggested : 5, 1, 60), fromDialogue), 1, MAX_SHOT_DURATION);
  const characters = Array.isArray(value.characters)
    ? [...new Set((value.characters as unknown[]).filter((n): n is string => typeof n === 'string' && !!n.trim()).map(n => n.trim()))]
    : [];
  const speaker = typeof value.speaker === 'string' && value.speaker.trim() ? value.speaker.trim().slice(0, 120) : null;
  if (speaker && !characters.includes(speaker)) characters.push(speaker);
  return { title: clip(value.title, 120) || '未命名镜头', scene: clip(value.scene, 500), description: clip(value.description, 4000), dialogue, duration, speaker, characters };
}

export function parseStoryboardPayload(content: unknown): { characters: DraftCharacter[]; shots: DraftShot[] } {
  let parsed: unknown = content;
  if (typeof content === 'string') {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('AI 返回格式异常，请重试。');
    try { parsed = JSON.parse(content.slice(start, end + 1)); } catch { throw new Error('AI 返回格式异常，请重试。'); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI 返回格式异常，请重试。');
  const body = parsed as Record<string, unknown>;
  const shots = (Array.isArray(body.shots) ? body.shots : []).slice(0, 60).map(s => normalizeShot(s as Record<string, unknown>));
  if (!shots.length) throw new Error('AI 未拆出任何镜头，请补充故事内容后重试。');
  const characters = new Map<string, DraftCharacter>();
  for (const c of (Array.isArray(body.characters) ? body.characters : []).slice(0, 20)) {
    if (!c || typeof c !== 'object') continue;
    const name = clip((c as Record<string, unknown>).name, 120);
    if (!name || characters.has(name)) continue;
    characters.set(name, { name, description: clip((c as Record<string, unknown>).description, 3000) });
  }
  for (const shot of shots) for (const name of [...shot.characters, ...(shot.speaker ? [shot.speaker] : [])]) {
    if (!characters.has(name) && characters.size < 20) characters.set(name, { name, description: '' });
  }
  return { characters: [...characters.values()], shots };
}

export async function requestStoryboard(options: { key: string; model?: string; baseUrl?: string; story: string; requestedCount: number | null; fetcher?: typeof fetch }): Promise<{ characters: DraftCharacter[]; shots: DraftShot[] }> {
  if (!options.key) throw new Error('Qwen API key is required');
  const story = options.story.trim();
  if (!story) throw new Error('请先粘贴故事文本。');
  if (story.length > MAX_STORY_LENGTH) throw new Error(`故事文本不能超过 ${MAX_STORY_LENGTH} 个字符。`);
  if (options.requestedCount !== null && (!Number.isInteger(options.requestedCount) || options.requestedCount < MIN_REQUESTED_SHOTS || options.requestedCount > MAX_REQUESTED_SHOTS)) throw new Error('期望镜头数必须在 4–60 之间。');
  const { system, user } = buildStoryboardMessages(story, options.requestedCount);
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`${(options.baseUrl || STORYBOARD_LLM_BASE_URL).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: options.model?.trim() || DEFAULT_STORYBOARD_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Storyboard provider failed (${response.status})`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error('AI 返回格式异常，请重试。'); }
  const content = payload && typeof payload === 'object' && 'choices' in payload && Array.isArray((payload as { choices: unknown }).choices)
    ? (payload as { choices: Array<{ message?: { content?: unknown } }> }).choices[0]?.message?.content
    : undefined;
  return parseStoryboardPayload(content);
}
