import type { DraftCharacter, DraftShot } from './types.ts';
import { MAX_REQUESTED_SHOTS, MAX_STORY_LENGTH, MIN_REQUESTED_SHOTS } from './domain.ts';
import { MAX_SHOT_DURATION } from './shot-timing.ts';

export const DEFAULT_STORYBOARD_MODEL = 'qwen3.8-flash';
export const STORYBOARD_LLM_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const clip = (value: unknown, max: number): string => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function buildStoryboardMessages(story: string, requestedCount: number | null): { system: string; user: string } {
  const system = [
    '你是一位专业的短剧分镜师，负责把故事文本拆解成适合逐镜头生成视频的分镜脚本。',
    '要求：',
    '1. 按完整动作和叙事目的拆成有序镜头。同一场景、同一机位下连续发生的动作，尽量保留在一个镜头内，例如拿起杯子、喝水、放下杯子是一个完整动作。不要机械地按句子拆镜，不要把每个动作阶段或表情变化各拆成一段视频。',
    '2. 只有地点、时间、景别、机位或叙事重点需要改变时才切镜。同一主体并不意味着不能切镜，例如中景切面部特写可以是两个镜头。相邻镜头保持人物外观、场景布局、动作方向与剧情关系一致，但不必让上一镜头结束画面等于下一镜头起始画面。',
    '3. 每个镜头包含：title（简短镜头名）、scene（地点与环境短语）、description（约 40–300 字，依次写清起始画面的景别、人物姿态、光线与构图，动作的连续过程、结束状态及必要运镜；只描述一个可连续拍摄的镜头）、dialogue（该镜头说出的对白，尽量使用故事原文，无声镜头为空字符串）、duration（建议秒数，2–30 的整数）、speaker（说话人物名，无对白为 null）、characters（出场人物名数组）。',
    '4. 从故事细节推断每个出场人物的外观（发型发色、服装、年龄感、标志性配饰等，约 30–150 字），输出 characters 列表，必须覆盖所有出场人物，不要遗漏。只使用故事中出现的信息，不要虚构故事之外的关键设定。',
    '5. duration 要覆盖完整动作和对白，按正常语速约每秒 4 个中文字符估算对白，留出动作和停顿时间。不要因为无对白而限制在很短的时长。超过 30 秒的段落在自然叙事节点拆分，避免在连续动作中途切开。',
    '6. 当前每镜头只支持一位说话人物，不要把多位人物轮流说话拼入同一个 dialogue；确需换说话人时，在自然停顿或反应镜头处拆分，并保留动作和场景关系。',
    '7. 镜头数量只是参考，完整动作、叙事清晰和故事信息完整优先；不得为了凑数拆开连续动作，也不得为了减少镜头而省略关键剧情。',
    '8. 严格输出一个 JSON 对象，不要输出 markdown 代码块或其他文字。格式：',
    '{"characters":[{"name":"人物名","description":"外观描述"}],"shots":[{"title":"镜头名","scene":"场景","description":"画面描述","dialogue":"对白","duration":5,"speaker":"人物名或null","characters":["出场人物"]}]}',
  ].join('\n');
  const user = `${requestedCount ? `参考镜头数为 ${requestedCount} 个，请按完整动作和叙事需要决定实际数量，可偏离此参考，不要为了凑数拆开连续动作。\n\n` : ''}${story}`;
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
