# AI 拆镜头（故事 → 分镜）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户粘贴一段故事文本，由百炼 qwen 文本模型拆解为分镜草稿，预览确认后写入作品的分镜列表（同名角色复用、新人物自动建卡）。

**Architecture:** 与现有生图/配音任务同构的后台生成任务：`Project.storyboardDraft` 存草稿与任务状态，`POST /api/projects/:id/storyboard`（或创建作品时携带 story）返回 202 + `waitUntil` 后台调 LLM，前端复用 3 秒轮询，ready 后弹预览，客户端做角色映射并走现有自动保存写入。

**Tech Stack:** React 19 + TypeScript（现有栈，无新依赖）；百炼 OpenAI 兼容模式 `chat/completions` + `response_format: json_object`；node:test 单测。

**Spec:** `docs/superpowers/specs/2026-09-29-storyboard-generation-design.md`

## Global Constraints

- Node.js ≥ 22.13；测试命令 `npm test`（`node --experimental-strip-types --test tests/*.test.ts`）；`npm run typecheck`、`npm run lint` 必须通过。
- 测试风格：`node:test` + `node:assert/strict`，不引入 mock 库；外部服务用受控 `fetcher` 参数（见 `tests/speech.test.ts` 模式）。
- 所有 UI 文案为中文；代码注释密度与现有文件一致（稀疏、只在非显而易见处）。
- 数值约束（verbatim）：story trim 后非空 ≤ 20000 字符；期望镜头数 null 或 4–60 整数；草稿 shots ≤ 60、characters ≤ 20；镜头 title ≤ 120、scene ≤ 500、description ≤ 4000、dialogue ≤ 600；draft duration 为 1–600 的有限数；确认写入后项目 shots ≤ 200、characters ≤ 100；stale 恢复阈值 10 分钟。
- 提交信息用英文 conventional 风格（`feat:`/`docs:`/`test:`），与 git log 现有风格一致。
- 样例项目 `sample-summer-letter` 一切写操作 403；`DASHSCOPE_API_KEY` 缺失时 storyboard 相关入口禁用、API 返回 503。

## Review Focus

实施时除各任务测试外，重点核验以下五类输入/失败模式（均已绑定到对应任务的测试步骤）：

1. **LLM 返回带 markdown 围栏或前后杂文的 JSON** —— 解析必须提取首个 JSON 对象而不是直接 JSON.parse 失败（Task 2 测试）。
2. **AI 拆出 0 个镜头**（故事太短/模型异常）—— 任务应 failed 并给出「AI 未拆出任何镜头」而非写入空 ready 草稿（Task 2 测试）。
3. **AI 输出的 speaker 名未列在镜头 characters 数组中** —— 写入后 speakerCharacterId 必须仍在 characterIds 内，否则 validateProject 拒绝保存（Task 3 测试）。
4. **超长对白把时长校正推高**（600 字 → 150s）—— duration 最终 clamp 在 [1,600]，AI 建议值先 clamp [1,60]（Task 2 测试）。
5. **draft 为 ready 时重新提交新故事** —— 旧草稿被覆盖而非 409；仅 generating 中才 409（Task 4 测试）。

---

### Task 1: 类型与 domain 层草稿支持

**Files:**
- Modify: `lib/types.ts`
- Modify: `lib/domain.ts`
- Test: `tests/domain.test.ts`（增补，文件已有其他测试）

**Interfaces:**
- Consumes: 现有 `normalizeProject`/`validateProject`/`rebaseProjectEdits` 结构。
- Produces:
  - `type DraftCharacter = { name: string; description: string }`、`type DraftShot = { title: string; scene: string; description: string; dialogue: string; speaker: string | null; characters: string[]; duration: number }`、`type StoryboardDraft = { status: 'generating' | 'ready' | 'failed'; error: string | null; generationId: string | null; generationStartedAt: string | null; story: string; requestedCount: number | null; characters: DraftCharacter[]; shots: DraftShot[] }`（`lib/types.ts`）
  - `Project.storyboardDraft: StoryboardDraft | null`
  - `newStoryboardDraft(story: string, requestedCount: number | null, generationId: string): StoryboardDraft`（`lib/domain.ts`）
  - `recoverStoryboardDraft(project: Project, now?: number): Project | null`（null = 无变化）
  - `rebaseProjectEdits` 结果的 `storyboardDraft` 一律取远端 `remote.storyboardDraft ?? null`

- [ ] **Step 1: Write the failing tests**

在 `tests/domain.test.ts` 末尾追加（沿用文件顶部已有的 `shot()`/`project()` helper）：

```ts
import { newStoryboardDraft, recoverStoryboardDraft, rebaseProjectEdits } from '../lib/domain.ts';
import type { StoryboardDraft } from '../lib/types.ts';

const readyDraft = (): StoryboardDraft => ({
  status: 'ready', error: null, generationId: null, generationStartedAt: null,
  story: '夏日傍晚，林夏在车站重逢陈屿。',
  requestedCount: 8,
  characters: [{ name: '林夏', description: '深蓝短发、珊瑚发带的少女' }],
  shots: [{ title: '重逢', scene: '海边车站', description: '夕阳下的车站全景', dialogue: '你来了。', duration: 3, speaker: '林夏', characters: ['林夏'] }],
});

test('legacy projects gain a null storyboard draft', () => {
  const legacy = structuredClone(project([shot('x')])) as unknown as Record<string,unknown>;
  delete legacy.storyboardDraft;
  const normalized = normalizeProject(legacy);
  assert.equal(normalized.storyboardDraft, null);
  assert.doesNotThrow(() => validateProject(normalized));
});

test('validation accepts generating, ready and failed drafts and rejects malformed ones', () => {
  const withDraft = (draft: unknown) => { const p = structuredClone(project([])); (p as unknown as Record<string,unknown>).storyboardDraft = draft; return p; };
  assert.doesNotThrow(() => validateProject(withDraft(newStoryboardDraft('故事', 8, 'gen-1'))));
  assert.doesNotThrow(() => validateProject(withDraft(readyDraft())));
  const failed = { ...newStoryboardDraft('故事', null, 'gen-1'), status: 'failed' as const, error: '失败', generationId: null, generationStartedAt: null };
  assert.doesNotThrow(() => validateProject(withDraft(failed)));

  const badStatus = withDraft({ ...readyDraft(), status: 'done' });
  assert.throws(() => validateProject(badStatus), /storyboard/i);
  const longStory = withDraft({ ...readyDraft(), story: '字'.repeat(20001) });
  assert.throws(() => validateProject(longStory), /storyboard/i);
  const badCount = withDraft({ ...readyDraft(), requestedCount: 3 });
  assert.throws(() => validateProject(badCount), /storyboard/i);
  const badDuration = withDraft({ ...readyDraft() });
  badDuration.shots[0].duration = 601;
  assert.throws(() => validateProject(badDuration), /storyboard/i);
  const missingGeneration = withDraft({ ...readyDraft(), status: 'generating' as const });
  assert.throws(() => validateProject(missingGeneration), /storyboard/i);
  const readyWithGeneration = withDraft({ ...newStoryboardDraft('故事', null, 'gen-1'), status: 'ready' as const });
  assert.throws(() => validateProject(readyWithGeneration), /storyboard/i);
  const failedWithShots = withDraft({ ...failed, shots: readyDraft().shots });
  assert.throws(() => validateProject(failedWithShots), /storyboard/i);
});

test('rebase always keeps the remote storyboard draft', () => {
  const local = structuredClone(project([shot('a')]));
  const remote = structuredClone(project([shot('a')]));
  remote.revision = 2;
  (remote as unknown as Record<string,unknown>).storyboardDraft = readyDraft();
  const rebased = rebaseProjectEdits(local, remote);
  assert.deepEqual(rebased.storyboardDraft, readyDraft());
  assert.equal(rebased.revision, 2);
});

test('stale generating drafts recover to failed while keeping the story', () => {
  const stale = structuredClone(project([]));
  const started = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  (stale as unknown as Record<string,unknown>).storyboardDraft = { ...newStoryboardDraft('原始故事', 6, 'gen-1'), generationStartedAt: started };
  const recovered = recoverStoryboardDraft(stale);
  assert.ok(recovered);
  assert.equal(recovered.storyboardDraft?.status, 'failed');
  assert.equal(recovered.storyboardDraft?.error, '故事拆分已中断，请重试。');
  assert.equal(recovered.storyboardDraft?.story, '原始故事');
  assert.equal(recovered.storyboardDraft?.generationId, null);
  const fresh = structuredClone(project([]));
  (fresh as unknown as Record<string,unknown>).storyboardDraft = newStoryboardDraft('原始故事', 6, 'gen-2');
  assert.equal(recoverStoryboardDraft(fresh), null);
});
```

同时更新文件顶部 import 行，把 `newStoryboardDraft, recoverStoryboardDraft, rebaseProjectEdits` 与 `type StoryboardDraft` 加进现有 import（`rebaseProjectEdits` 若未导入）。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/domain.test.ts 2>&1 | tail -20`（或 `node --experimental-strip-types --test tests/domain.test.ts`）
Expected: FAIL —— `newStoryboardDraft`/`recoverStoryboardDraft` 不存在、`storyboardDraft` 断言失败。

- [ ] **Step 3: Implement types and domain changes**

`lib/types.ts` —— 在 `Shot` 类型定义之后新增：

```ts
export type DraftCharacter = { name: string; description: string };
export type DraftShot = { title: string; scene: string; description: string; dialogue: string; speaker: string | null; characters: string[]; duration: number };
export type StoryboardDraft = { status: 'generating' | 'ready' | 'failed'; error: string | null; generationId: string | null; generationStartedAt: string | null; story: string; requestedCount: number | null; characters: DraftCharacter[]; shots: DraftShot[] };
```

并把 `Project` 类型改为（仅追加最后一个字段）：

```ts
export type Project = { id: string; name: string; description: string; aspectRatio: '16:9' | '9:16'; style: string; characters: Character[]; scenes?: Scene[]; shots: Shot[]; storyboardDraft?: StoryboardDraft | null; revision: number; createdAt: string; updatedAt: string };
```

`lib/domain.ts`：

1. import 增加 `StoryboardDraft` 类型。
2. `newShot()` 附近新增：

```ts
export function newStoryboardDraft(story: string, requestedCount: number | null, generationId: string): StoryboardDraft {
  return { status: 'generating', error: null, generationId, generationStartedAt: new Date().toISOString(), story, requestedCount, characters: [], shots: [] };
}

const STALE_STORYBOARD_MS = 10 * 60 * 1000;

export function recoverStoryboardDraft(project: Project, now = Date.now()): Project | null {
  const draft = project.storyboardDraft;
  if (!draft || draft.status !== 'generating' || !draft.generationStartedAt || now - Date.parse(draft.generationStartedAt) <= STALE_STORYBOARD_MS) return null;
  return { ...project, storyboardDraft: { ...draft, status: 'failed', error: '故事拆分已中断，请重试。', generationId: null, generationStartedAt: null } };
}
```

3. `normalizeProject` 的返回对象追加字段（`shots` 之后）：

```ts
storyboardDraft: value.storyboardDraft === undefined ? null : value.storyboardDraft,
```

4. `validateProject` 内、shots 循环之后追加草稿校验（新增模块级函数，在 `validateProject` 前定义）：

```ts
function validateStoryboardDraft(value: unknown): void {
  if (value === null || value === undefined) return;
  if (!isRecord(value) || !['generating', 'ready', 'failed'].includes(String(value.status))) throw new Error('Invalid storyboard draft');
  if (!(value.error === null || isString(value.error) && value.error.length <= 500)) throw new Error('Invalid storyboard draft');
  if (!(value.generationId === null || isString(value.generationId))) throw new Error('Invalid storyboard draft');
  if (!(value.generationStartedAt === null || isString(value.generationStartedAt))) throw new Error('Invalid storyboard draft');
  if (!isString(value.story) || !value.story.trim() || value.story.length > 20000) throw new Error('Invalid storyboard draft');
  if (!(value.requestedCount === null || (Number.isInteger(value.requestedCount) && (value.requestedCount as number) >= 4 && (value.requestedCount as number) <= 60))) throw new Error('Invalid storyboard draft');
  if (!Array.isArray(value.characters) || value.characters.length > 20) throw new Error('Invalid storyboard draft');
  for (const c of value.characters as unknown[]) if (!isRecord(c) || !isString(c.name) || !c.name.trim() || c.name.length > 120 || !isString(c.description) || c.description.length > 3000) throw new Error('Invalid storyboard draft');
  if (!Array.isArray(value.shots) || value.shots.length > 60) throw new Error('Invalid storyboard draft');
  for (const s of value.shots as unknown[]) {
    if (!isRecord(s) || !isString(s.title) || s.title.length > 120 || !isString(s.scene) || s.scene.length > 500 || !isString(s.description) || s.description.length > 4000 || !isString(s.dialogue) || s.dialogue.length > 600 || !(s.speaker === null || (isString(s.speaker) && !!s.speaker.trim())) || !Array.isArray(s.characters) || (s.characters as unknown[]).some(n => !isString(n) || !n.trim())) throw new Error('Invalid storyboard draft');
    if (!Number.isFinite(s.duration) || Number(s.duration) <= 0 || Number(s.duration) > 600) throw new Error('Invalid storyboard draft');
  }
  if (value.status === 'generating' && (!isString(value.generationId) || !isString(value.generationStartedAt))) throw new Error('Invalid storyboard draft generation');
  if (value.status !== 'generating' && (value.generationId !== null || value.generationStartedAt !== null)) throw new Error('Invalid storyboard draft generation');
  if (value.status !== 'ready' && ((value.shots as unknown[]).length || (value.characters as unknown[]).length)) throw new Error('Invalid storyboard draft');
}
```

并在 `validateProject` 的 scenes 校验之后调用 `validateStoryboardDraft((value as Record<string, unknown>).storyboardDraft ?? null);`

5. `rebaseProjectEdits` 返回对象追加：

```ts
storyboardDraft: remote.storyboardDraft ?? null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test tests/domain.test.ts`
Expected: 全部 PASS（含原有测试）。

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add lib/types.ts lib/domain.ts tests/domain.test.ts
git commit -m "feat: add storyboard draft types and domain support"
```

---

### Task 2: 百炼 LLM provider（lib/storyboard.ts）

**Files:**
- Create: `lib/storyboard.ts`
- Test: `tests/storyboard.test.ts`

**Interfaces:**
- Consumes: `DraftCharacter`/`DraftShot`（Task 1）。
- Produces:
  - `const DEFAULT_STORYBOARD_MODEL = 'qwen-max'`
  - `const STORYBOARD_LLM_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'`
  - `buildStoryboardMessages(story: string, requestedCount: number | null): { system: string; user: string }`
  - `parseStoryboardPayload(content: unknown): { characters: DraftCharacter[]; shots: DraftShot[] }`（抛 Error 于非法输出）
  - `requestStoryboard(options: { key: string; model?: string; baseUrl?: string; story: string; requestedCount: number | null; fetcher?: typeof fetch }): Promise<{ characters: DraftCharacter[]; shots: DraftShot[] }>`

- [ ] **Step 1: Write the failing tests**

创建 `tests/storyboard.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STORYBOARD_MODEL, STORYBOARD_LLM_BASE_URL, buildStoryboardMessages, parseStoryboardPayload, requestStoryboard } from '../lib/storyboard.ts';

const validPayload = () => ({
  characters: [{ name: '林夏', description: '深蓝短发、珊瑚发带、米白上衣的少女。' }],
  shots: [
    { title: '重逢', scene: '海边车站', description: '夕阳下的车站全景，林夏站在站台远望。', dialogue: '你来了。', duration: 2, speaker: '林夏', characters: ['林夏'] },
    { title: '沉默', scene: '海边车站', description: '陈屿的特写，微风拂过。', dialogue: '', duration: 30, speaker: null, characters: ['陈屿'] },
  ],
});

const chatResponse = (content: string) => Response.json({ choices: [{ message: { role: 'assistant', content } }] });

test('storyboard request targets compatible-mode with json_object and model override', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await requestStoryboard({
    key: 'dashscope-secret',
    model: 'qwen-plus',
    story: '林夏在车站等到了陈屿。',
    requestedCount: 6,
    fetcher: async (url, init) => {
      calls.push({ url: String(url), init });
      return chatResponse(JSON.stringify(validPayload()));
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${STORYBOARD_LLM_BASE_URL}/chat/completions`);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.model, 'qwen-plus');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].role, 'user');
  assert.match(body.messages[1].content, /6/);
  assert.match(body.messages[1].content, /林夏在车站等到了陈屿。/);
  assert.equal(new Headers(calls[0].init?.headers).get('Authorization'), 'Bearer dashscope-secret');
  assert.equal(result.shots.length, 2);
});

test('storyboard defaults to qwen-max and rejects missing credentials', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  await requestStoryboard({ key: 'k', story: '故事', requestedCount: null, fetcher: async (url, init) => { calls.push({ url: String(url), init }); return chatResponse(JSON.stringify(validPayload())); } });
  assert.equal(JSON.parse(String(calls[0].init?.body)).model, DEFAULT_STORYBOARD_MODEL);
  await assert.rejects(requestStoryboard({ key: '', story: '故事', requestedCount: null }), /API key/i);
  await assert.rejects(requestStoryboard({ key: 'k', story: '  ', requestedCount: null }), /故事/);
  await assert.rejects(requestStoryboard({ key: 'k', story: '故事', requestedCount: 3 }), /镜头数/);
});

test('parser clamps fields, collects missing characters, and corrects duration by dialogue length', () => {
  const payload = {
    characters: [{ name: '林夏', description: '深蓝短发少女' }],
    shots: [
      { title: '  长标题 '.repeat(100).slice(0, 200), scene: '场景', description: '描述', dialogue: '这'.repeat(40), duration: 2, speaker: '林夏', characters: ['林夏'], extra: 'ignored' },
      { title: '新人物', scene: '场景', description: '描述', dialogue: '', duration: 999, speaker: null, characters: ['陈屿'] },
    ],
  };
  const parsed = parseStoryboardPayload(payload);
  assert.equal(parsed.shots[0].title.length, 120);
  assert.equal(parsed.shots[0].duration, 10, '40 字对白至少 10 秒');
  assert.equal(parsed.shots[1].duration, 60, 'AI 建议值 clamp 到 60');
  assert.ok(parsed.characters.some(c => c.name === '陈屿' && c.description === ''), '未识别人物补充空描述');
});

test('parser extracts JSON from fenced or noisy content and rejects empty shot lists', () => {
  const fenced = parseStoryboardPayload('前置说明\n```json\n' + JSON.stringify(validPayload()) + '\n```\n后置说明');
  assert.equal(fenced.shots.length, 2);
  assert.throws(() => parseStoryboardPayload({ characters: [], shots: [] }), /未拆出任何镜头/);
  assert.throws(() => parseStoryboardPayload('not json at all'), /格式异常/);
  assert.throws(() => parseStoryboardPayload({ characters: [], shots: [{ title: 't', scene: 's', description: 'd', dialogue: '', duration: 0, speaker: null, characters: [] }] }), /duration/i);
});

test('provider surfaces HTTP failures without leaking credentials', async () => {
  await assert.rejects(
    requestStoryboard({ key: 'dashscope-secret', story: '故事', requestedCount: null, fetcher: async () => new Response('boom', { status: 500 }) }),
    error => error instanceof Error && /500/.test(error.message) && !error.message.includes('dashscope-secret'),
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test tests/storyboard.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: Implement lib/storyboard.ts**

```ts
import type { DraftCharacter, DraftShot } from './types.ts';

export const DEFAULT_STORYBOARD_MODEL = 'qwen-max';
export const STORYBOARD_LLM_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

export const MAX_STORY_LENGTH = 20_000;
export const MIN_REQUESTED_SHOTS = 4;
export const MAX_REQUESTED_SHOTS = 60;

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
  const duration = clamp(Math.max(clamp(Number.isFinite(suggested) ? suggested : 5, 1, 60), fromDialogue), 1, 600);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test tests/storyboard.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add lib/storyboard.ts tests/storyboard.test.ts
git commit -m "feat: add qwen storyboard llm provider"
```

---

### Task 3: 草稿确认映射（lib/storyboard-import.ts）

**Files:**
- Create: `lib/storyboard-import.ts`
- Test: `tests/storyboard-import.test.ts`

**Interfaces:**
- Consumes: `StoryboardDraft`/`Project`/`Shot`（Task 1）、`newShot`（`lib/domain.ts`）、`newId`（`lib/id.ts`）。
- Produces: `applyStoryboardDraft(project: Project, draft: StoryboardDraft, keptIndexes: number[]): { project: Project; insertedShotIds: string[] }` —— 超 200 镜头/100 角色抛 Error（中文文案），返回的 project 已含追加 shots、新建/复用 characters 且 `storyboardDraft: null`。

- [ ] **Step 1: Write the failing tests**

创建 `tests/storyboard-import.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStoryboardDraft } from '../lib/storyboard-import.ts';
import { newStoryboardDraft } from '../lib/domain.ts';
import type { Character, Project, StoryboardDraft } from '../lib/types.ts';

const character = (id: string, name: string): Character => ({ id, name, description: `desc-${name}`, voice: 'male', references: [] });
const baseProject = (characters: Character[] = [], shotCount = 0): Project => ({
  id: 'p1', name: '作品', description: '', aspectRatio: '16:9', style: '', characters,
  shots: Array.from({ length: shotCount }, (_, i) => ({ id: `s${i}`, title: `镜头${i}`, characterIds: [], scene: '', description: '', dialogue: '', showSubtitle: true, voiceInstruction: '', duration: 5, audioLeadIn: 0, audioTailOut: 0, speakerCharacterId: null, audio: { url: null, duration: null, sourceText: null, sourceVoice: null, sourceInstruction: null, status: 'idle' as const, error: null, generationId: null, generationStartedAt: null }, candidates: [], selectedCandidateId: null, status: 'idle' as const, error: null, generationId: null, generationStartedAt: null })),
  revision: 1, createdAt: '', updatedAt: '',
});

const draft = (): StoryboardDraft => ({
  ...newStoryboardDraft('林夏与陈屿在车站重逢。', 2, 'gen-1'),
  status: 'ready', generationId: null, generationStartedAt: null,
  characters: [{ name: '林夏', description: '深蓝短发少女' }, { name: '路人甲', description: '背景人物' }],
  shots: [
    { title: '', scene: '海边车站', description: '夕阳全景', dialogue: '你来了。', duration: 3, speaker: '林夏', characters: ['林夏'] },
    { title: '特写', scene: '海边车站', description: '陈屿特写', dialogue: '', duration: 4, speaker: '陈屿', characters: [] },
    { title: '删除我', scene: 'x', description: 'x', dialogue: '', duration: 1, speaker: null, characters: ['路人甲'] },
  ],
});

test('imports kept shots, reuses same-name characters, and backfills speaker into characterIds', () => {
  const existing = character('c1', '林夏');
  const result = applyStoryboardDraft(baseProject([existing]), draft(), [0, 1]);
  const { project, insertedShotIds } = result;
  assert.equal(project.shots.length, 2);
  assert.equal(project.storyboardDraft, null);
  assert.equal(project.characters.length, 2, '林夏复用 + 陈屿新建，路人甲不建');
  const linxia = project.characters.find(c => c.name === '林夏')!;
  assert.equal(linxia.id, 'c1', '同名复用已有角色');
  const chenyu = project.characters.find(c => c.name === '陈屿')!;
  assert.equal(chenyu.voice, 'female');
  assert.equal(chenyu.description, '');
  assert.equal(project.shots[0].title, '镜头 1', '空标题回退');
  assert.equal(project.shots[0].speakerCharacterId, linxia.id);
  assert.deepEqual(project.shots[0].characterIds, [linxia.id]);
  assert.equal(project.shots[1].speakerCharacterId, chenyu.id);
  assert.deepEqual(project.shots[1].characterIds, [chenyu.id], 'speaker 补进出场角色');
  assert.deepEqual(insertedShotIds, project.shots.map(s => s.id));
});

test('matches names case-insensitively after trim and rejects limit overflow', () => {
  const existing = character('c1', 'LIN Xia');
  const d = draft();
  d.shots[0].characters = [' linxia '];
  d.shots[0].speaker = ' linxia ';
  const result = applyStoryboardDraft(baseProject([existing]), d, [0]);
  assert.equal(result.project.characters.length, 1);
  assert.equal(result.project.shots[0].speakerCharacterId, 'c1');

  assert.throws(() => applyStoryboardDraft(baseProject([], 199), draft(), [0, 1]), /200/);
  const manyCharacters = Array.from({ length: 100 }, (_, i) => character(`c${i}`, `角色${i}`));
  assert.throws(() => applyStoryboardDraft(baseProject(manyCharacters), draft(), [0]), /100/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test tests/storyboard-import.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: Implement lib/storyboard-import.ts**

```ts
import type { Character, Project, Shot, StoryboardDraft } from './types.ts';
import { newShot } from './domain.ts';
import { newId } from './id.ts';

const nameKey = (name: string) => name.trim().toLowerCase();

export function applyStoryboardDraft(project: Project, draft: StoryboardDraft, keptIndexes: number[]): { project: Project; insertedShotIds: string[] } {
  const kept = keptIndexes.map(i => draft.shots[i]).filter(s => !!s);
  if (project.shots.length + kept.length > 200) throw new Error('镜头总数不能超过 200，请先删减现有镜头或减少导入的草稿镜头。');

  const usedNames = new Map<string, string>();
  for (const shot of kept) {
    for (const name of [...shot.characters, ...(shot.speaker ? [shot.speaker] : [])]) {
      const key = nameKey(name);
      if (key && !usedNames.has(key)) usedNames.set(key, name.trim());
    }
  }

  const characters = [...project.characters];
  const nameToId = new Map<string, string>();
  for (const [key, original] of usedNames) {
    const existing = characters.find(c => nameKey(c.name) === key);
    if (existing) { nameToId.set(key, existing.id); continue; }
    if (characters.length >= 100) throw new Error('角色总数不能超过 100，请先整理角色库再导入。');
    const draftCharacter = draft.characters.find(c => nameKey(c.name) === key);
    const created: Character = { id: newId(), name: original, description: draftCharacter?.description ?? '', voice: 'female', references: [] };
    characters.push(created);
    nameToId.set(key, created.id);
  }

  const shots: Shot[] = kept.map((s, i) => {
    const characterIds = [...new Set(s.characters.map(nameKey).filter(k => nameToId.has(k)).map(k => nameToId.get(k)!))];
    const speakerId = s.speaker ? nameToId.get(nameKey(s.speaker)) ?? null : null;
    if (speakerId && !characterIds.includes(speakerId)) characterIds.push(speakerId);
    return { ...newShot(), title: s.title.trim() || `镜头 ${project.shots.length + i + 1}`, scene: s.scene, description: s.description, dialogue: s.dialogue, duration: s.duration, showSubtitle: true, characterIds, speakerCharacterId: speakerId };
  });

  return { project: { ...project, characters, shots: [...project.shots, ...shots], storyboardDraft: null }, insertedShotIds: shots.map(s => s.id) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test tests/storyboard-import.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Validate against validateProject and commit**

在 `tests/storyboard-import.test.ts` 第一个测试末尾追加一行断言（确认写入结果能通过服务端校验）：

```ts
import { validateProject } from '../lib/domain.ts';
assert.doesNotThrow(() => validateProject({ ...project, revision: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));
```

Run: `node --experimental-strip-types --test tests/storyboard-import.test.ts` → PASS。

```bash
npm run typecheck
git add lib/storyboard-import.ts tests/storyboard-import.test.ts
git commit -m "feat: add storyboard draft import mapping"
```

---

### Task 4: 服务端 API（storyboard 端点 + 创建即拆分 + PUT 保护）

**Files:**
- Modify: `lib/server.ts`
- Modify: `worker/index.ts`（Env 接口加两个可选字段）
- Test: `tests/server.test.ts`（增补）

**Interfaces:**
- Consumes: `requestStoryboard`/`DEFAULT_STORYBOARD_MODEL`（Task 2）、`newStoryboardDraft`/`recoverStoryboardDraft`（Task 1）、现有 `loadRecovered`/`saveCas`/`rowFor`。
- Produces:
  - `POST /api/projects/:id/storyboard` body `{ story: string; count?: number | null }` → 202 `{ project }`（draft generating）
  - `POST /api/projects` body 新增可选 `story`/`count` → 201（draft generating）
  - `ApiEnv` 新增 `STORYBOARD_LLM_MODEL?: string; STORYBOARD_LLM_BASE_URL?: string`
  - `GET /api/config` 响应新增 `storyboard: { configured: boolean; model: string }`

- [ ] **Step 1: Write the failing tests**

在 `tests/server.test.ts` 末尾追加（沿用文件已有的 `request`/`json`/`env` helper）：

```ts
const storyboardEnv = () => ({ ...env, DASHSCOPE_API_KEY: 'dashscope-key' });

function llmSuccessFetcher(): typeof fetch {
  return async () => Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({
    characters: [{ name: '林夏', description: '深蓝短发少女' }],
    shots: [
      { title: '重逢', scene: '海边车站', description: '夕阳全景', dialogue: '你来了。', duration: 2, speaker: '林夏', characters: ['林夏'] },
      { title: '特写', scene: '海边车站', description: '微笑特写', dialogue: '', duration: 3, speaker: null, characters: ['林夏'] },
    ],
  }) } }] });
}

async function createStoryboardProject(story = '林夏在车站重逢陈屿。', count: number | null = 4) {
  const waits: Promise<unknown>[] = [];
  const options = { fetcher: llmSuccessFetcher(), waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
  const response = await handleApiRequest(request('/api/projects', 'POST', { name: '拆镜头作品', style: 'anime', story, count }, 'b@example.com'), storyboardEnv(), options);
  return { response, waits, options };
}

test('creating a project with a story runs the storyboard task in the background', async () => {
  const { response, waits } = await createStoryboardProject();
  assert.equal(response.status, 201);
  const created = (await json(response)).project;
  assert.equal(created.storyboardDraft.status, 'generating');
  assert.equal(created.storyboardDraft.story, '林夏在车站重逢陈屿。');
  assert.equal(created.storyboardDraft.requestedCount, 4);
  await Promise.all(waits);
  const loaded = (await json(await handleApiRequest(request(`/api/projects/${created.id}`, 'GET', undefined, 'b@example.com'), storyboardEnv()))).project;
  assert.equal(loaded.storyboardDraft.status, 'ready');
  assert.equal(loaded.storyboardDraft.shots.length, 2);
  assert.ok(loaded.storyboardDraft.shots[0].duration >= 1);
  assert.equal(loaded.storyboardDraft.characters[0].name, '林夏');
});

test('storyboard endpoint validates input, requires configuration, and guards concurrency', async () => {
  const owner = 'b@example.com';
  const created = (await json(await handleApiRequest(request('/api/projects', 'POST', { name: '拆镜头作品2', style: 'anime' }, owner), storyboardEnv()))).project;

  const badStory = await handleApiRequest(request(`/api/projects/${created.id}/storyboard`, 'POST', { story: '   ' }, owner), storyboardEnv());
  assert.equal(badStory.status, 400);
  const badCount = await handleApiRequest(request(`/api/projects/${created.id}/storyboard`, 'POST', { story: '故事', count: 61 }, owner), storyboardEnv());
  assert.equal(badCount.status, 400);

  const noKey = await handleApiRequest(request(`/api/projects/${created.id}/storyboard`, 'POST', { story: '故事' }, owner), env);
  assert.equal(noKey.status, 503);

  const waits: Promise<unknown>[] = [];
  const options = { fetcher: llmSuccessFetcher(), waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
  const started = await handleApiRequest(request(`/api/projects/${created.id}/storyboard`, 'POST', { story: '第二次提交的故事。' }, owner), storyboardEnv(), options);
  assert.equal(started.status, 202);
  const generating = (await json(started)).project;
  assert.equal(generating.storyboardDraft.status, 'generating');
  const duplicate = await handleApiRequest(request(`/api/projects/${created.id}/storyboard`, 'POST', { story: '重复' }, owner), storyboardEnv(), options);
  assert.equal(duplicate.status, 409);
  await Promise.all(waits);
  const ready = (await json(await handleApiRequest(request(`/api/projects/${created.id}`, 'GET', undefined, owner), storyboardEnv()))).project;
  assert.equal(ready.storyboardDraft.story, '第二次提交的故事。', 'ready 后可覆盖重试');
  const replaced = await handleApiRequest(request(`/api/projects/${created.id}/storyboard`, 'POST', { story: '重新拆分。' }, owner), storyboardEnv(), options);
  assert.equal(replaced.status, 202);
});

test('storyboard failures mark the draft failed and keep the story for retry', async () => {
  const owner = 'b@example.com';
  const created = (await json(await handleApiRequest(request('/api/projects', 'POST', { name: '失败作品', style: 'anime' }, owner), storyboardEnv()))).project;
  const waits: Promise<unknown>[] = [];
  const options = { fetcher: async () => new Response('upstream boom', { status: 503 }), waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
  await handleApiRequest(request(`/api/projects/${created.id}/storyboard`, 'POST', { story: '将失败的故事' }, owner), storyboardEnv(), options);
  await Promise.allSettled(waits);
  const loaded = (await json(await handleApiRequest(request(`/api/projects/${created.id}`, 'GET', undefined, owner), storyboardEnv()))).project;
  assert.equal(loaded.storyboardDraft.status, 'failed');
  assert.match(loaded.storyboardDraft.error, /503/);
  assert.equal(loaded.storyboardDraft.story, '将失败的故事');
});

test('saving keeps a generating draft but accepts clearing a ready one', async () => {
  const owner = 'b@example.com';
  const { response, waits } = await createStoryboardProject('保护测试故事。');
  const created = (await json(response)).project;
  const before = (await json(await handleApiRequest(request(`/api/projects/${created.id}`, 'GET', undefined, 'b@example.com'), storyboardEnv()))).project;

  const localDuringGenerating = structuredClone(before);
  localDuringGenerating.name = '编辑中改名';
  localDuringGenerating.storyboardDraft = null;
  const savedGenerating = await handleApiRequest(request(`/api/projects/${created.id}`, 'PUT', { project: localDuringGenerating }, 'b@example.com'), storyboardEnv());
  assert.equal(savedGenerating.status, 200);
  const kept = (await json(savedGenerating)).project;
  assert.equal(kept.name, '编辑中改名');
  assert.equal(kept.storyboardDraft.status, 'generating', '远端 generating 草稿不被 PUT 清除');
  await Promise.all(waits);

  const ready = (await json(await handleApiRequest(request(`/api/projects/${created.id}`, 'GET', undefined, 'b@example.com'), storyboardEnv()))).project;
  const confirmed = structuredClone(ready);
  confirmed.storyboardDraft = null;
  const savedClear = await handleApiRequest(request(`/api/projects/${created.id}`, 'PUT', { project: confirmed }, 'b@example.com'), storyboardEnv());
  assert.equal(savedClear.status, 200);
  assert.equal((await json(savedClear)).project.storyboardDraft, null);
});

test('config exposes storyboard settings and sample rejects storyboard generation', async () => {
  const config = (await json(await handleApiRequest(request('/api/config'), storyboardEnv()))).storyboard;
  assert.deepEqual(config, { configured: true, model: 'qwen-max' });
  const unconfigured = (await json(await handleApiRequest(request('/api/config'), env))).storyboard;
  assert.equal(unconfigured.configured, false);

  const response = await handleApiRequest(request(`${samplePath}/storyboard`, 'POST', { story: '测试' }), env, { fetcher: async () => { throw new Error('must not call'); } });
  assert.equal(response.status, 403);
});
```

同时把 `['POST',`${samplePath}/storyboard`,{story:'测试'}]` 加入现有「sample rejects saving…」测试的端点循环列表（`as const` 数组内），使样例只读保护覆盖新端点。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test tests/server.test.ts`
Expected: FAIL —— storyboard 端点 404 / config 无 storyboard 字段。

- [ ] **Step 3: Implement server changes**

`lib/server.ts`：

1. import 增加：`import { DEFAULT_STORYBOARD_MODEL, requestStoryboard } from './storyboard.ts';`，类型 import 增加 `StoryboardDraft`。
2. `ApiEnv` 增加字段：

```ts
STORYBOARD_LLM_MODEL?: string;
STORYBOARD_LLM_BASE_URL?: string;
```

3. 路由正则区新增：

```ts
const storyboardPath = /^\/api\/projects\/([a-f0-9-]{36})\/storyboard$/;
```

4. `recoverStale` 函数内、scenes 行之后追加草稿恢复（复用 Task 1 的纯函数）：

```ts
const draftRecovered = recoverStoryboardDraft(project);
const base = draftRecovered ?? project;
```

并把函数体内后续对 `project` 的引用改为基于 `base` 组装（shots/scenes 的 recover 逻辑不变，最终 `return changed || draftRecovered ? {...base, shots, scenes} : null;` —— 保持与现有返回语义一致：无任何变化时返回 null）。

5. 新增结果写回与任务执行函数（放在 `audioGenerationResult` 之后）：

```ts
async function storyboardResult(env: ApiEnv, owner: string, id: string, generationId: string, output?: { characters: DraftCharacter[]; shots: DraftShot[] }, error?: string): Promise<Project> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = readProject(await rowFor(env, id, owner));
    const draft = current.storyboardDraft;
    if (!draft || draft.generationId !== generationId || draft.status !== 'generating') fail(409, 'Storyboard generation was superseded');
    const next: StoryboardDraft = output
      ? { ...draft, status: 'ready', characters: output.characters, shots: output.shots, error: null, generationId: null, generationStartedAt: null }
      : { ...draft, status: 'failed', error: error || 'Storyboard generation failed', generationId: null, generationStartedAt: null };
    const saved = await saveCas(env, { ...current, storyboardDraft: next }, owner, current.revision);
    if (saved) return saved;
  }
  fail(409, 'Project changed repeatedly; reload and retry');
}

async function runStoryboardGeneration(env: ApiEnv, owner: string, id: string, generationId: string, story: string, requestedCount: number | null, fetcher?: typeof fetch): Promise<Project> {
  try {
    const output = await requestStoryboard({
      key: env.DASHSCOPE_API_KEY!.trim(),
      model: env.STORYBOARD_LLM_MODEL,
      baseUrl: env.STORYBOARD_LLM_BASE_URL,
      story,
      requestedCount,
      fetcher,
    });
    return await storyboardResult(env, owner, id, generationId, output);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Storyboard generation failed';
    await storyboardResult(env, owner, id, generationId, undefined, message).catch(() => {});
    throw error instanceof Error ? error : new Error(message);
  }
}

async function handleStoryboard(request: Request, env: ApiEnv, owner: string, id: string, fetcher?: typeof fetch, waitUntil?: (promise: Promise<unknown>) => void): Promise<Response> {
  const body = await bodyJson(request);
  const story = typeof body.story === 'string' ? body.story.trim() : '';
  const count = body.count ?? null;
  if (!story || story.length > 20000) fail(400, '请粘贴不超过 20000 个字符的故事文本。');
  if (count !== null && (typeof count !== 'number' || !Number.isInteger(count) || count < 4 || count > 60)) fail(400, '期望镜头数必须是 4–60 的整数。');
  if (!env.DASHSCOPE_API_KEY?.trim()) fail(503, '请配置百炼 API Key');
  let generationId = '';
  let startedSaved: Project | null = null;
  for (let attempt = 0; attempt < 12 && !startedSaved; attempt++) {
    const current = await loadRecovered(env, id, owner);
    if (current.storyboardDraft?.status === 'generating') fail(409, '正在拆分，请稍候。');
    generationId = crypto.randomUUID();
    const started = { ...current, storyboardDraft: newStoryboardDraft(story, count, generationId) };
    startedSaved = await saveCas(env, started, owner, current.revision);
  }
  if (!startedSaved) fail(409, 'Project changed repeatedly; retry');
  const generation = runStoryboardGeneration(env, owner, id, generationId, story, count, fetcher);
  waitUntil?.(generation.then(() => undefined, () => undefined));
  if (waitUntil) return json({ project: startedSaved }, 202);
  try {
    return json({ project: await generation });
  } catch (error) {
    fail(502, error instanceof Error ? error.message : 'Storyboard generation failed');
  }
}
```

（`DraftCharacter`/`DraftShot` 加进文件顶部的 type import。）

6. `handleApiRequest` 路由：

- 样例 403 条件追加 `|| path === `${samplePath}/storyboard``。
- config 响应改为：

```ts
if (path==='/api/config' && request.method==='GET') return json({configured:!!((env.IMAGE_API_KEY || env.OPENAI_API_KEY) && env.IMAGE_MODEL?.trim()),model:env.IMAGE_MODEL?.trim() || '',speech:resolveSpeechProvider(env).public,storyboard:{configured:!!env.DASHSCOPE_API_KEY?.trim(),model:env.STORYBOARD_LLM_MODEL?.trim() || DEFAULT_STORYBOARD_MODEL}});
```

- `POST /api/projects` 分支：body 校验之后、INSERT 之前追加：

```ts
const story = typeof body.story === 'string' ? body.story.trim() : '';
if (story && (story.length > 20000)) fail(400, '故事文本不能超过 20000 个字符。');
if (story && body.count !== undefined && (typeof body.count !== 'number' || !Number.isInteger(body.count) || body.count < 4 || body.count > 60)) fail(400, '期望镜头数必须是 4–60 的整数。');
if (story && !env.DASHSCOPE_API_KEY?.trim()) fail(503, '请配置百炼 API Key');
const baseProject = createProject(body.name, body.demo === true, typeof body.style === 'string' ? body.style : undefined);
const project = story ? { ...baseProject, storyboardDraft: newStoryboardDraft(story, typeof body.count === 'number' ? body.count : null, crypto.randomUUID()) } : baseProject;
```

INSERT 语句中 `project.revision`/`JSON.stringify(project)` 沿用（document 已含 draft）。return 前追加：

```ts
if (story) options.waitUntil?.(runStoryboardGeneration(env, owner, project.id, project.storyboardDraft!.generationId!, story, project.storyboardDraft!.requestedCount, options.fetcher).then(() => undefined, () => undefined));
```

注意该分支需要拿到 `options`（`handleApiRequest` 已有形参 `options`）。若 `waitUntil` 缺省（部分单测直连），仍返回 201，任务不启动——测试统一传 `waitUntil`。

7. storyboard 路由分发（`audioGenerateMatch` 之后）：

```ts
const storyboardMatch = path.match(storyboardPath);
if (storyboardMatch && request.method === 'POST') return await handleStoryboard(request, env, owner, storyboardMatch[1], options.fetcher, options.waitUntil);
```

8. PUT 分支的 `protectGeneration` 之后追加草稿保护（`safe` 组装处）：

```ts
const safeDraft = current.storyboardDraft?.status === 'generating' ? current.storyboardDraft : proposed.storyboardDraft ?? null;
```

并在 `const safe:Project={...}` 中加入 `storyboardDraft:safeDraft`。

`worker/index.ts` —— `Env` 接口追加：

```ts
STORYBOARD_LLM_MODEL?: string;
STORYBOARD_LLM_BASE_URL?: string;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test tests/server.test.ts`
Expected: 全部 PASS（含原有测试与新增 5 个）。

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add lib/server.ts worker/index.ts tests/server.test.ts
git commit -m "feat: add storyboard generation api endpoints"
```

---

### Task 5: 前端数据层（client + useStudio）

**Files:**
- Modify: `lib/client.ts`
- Modify: `components/useStudio.ts`

**Interfaces:**
- Consumes: Task 4 的 API 端点。
- Produces:
  - `generateStoryboard(projectId: string, input: { story: string; count: number | null }): Promise<{ project: Project }>`（`lib/client.ts`）
  - `WorkspaceConfig` 增加 `storyboard: { configured: boolean; model: string }`
  - `useStudio` 返回值增加 `generateStoryboard(story: string, count: number | null): Promise<void>`；`create` 签名变为 `(name: string, style: string, story?: string, count?: number | null) => Promise<boolean>`
  - 轮询条件覆盖 `project.storyboardDraft?.status === 'generating'`

本任务无独立单测（纯胶水层，行为由 Task 4 的 server 测试与 Task 6 的手动验收覆盖），以 typecheck + lint 验证。

- [ ] **Step 1: Update lib/client.ts**

```ts
export type WorkspaceConfig = { configured:boolean; model:string; speech:{configured:boolean;id:'qwen';provider:string;model:string;voices:{female:string;male:string}}; storyboard:{configured:boolean;model:string} };
export const EMPTY_WORKSPACE_CONFIG:WorkspaceConfig = { configured:false, model:'', speech:{configured:false,id:'qwen',provider:'阿里云百炼',model:'qwen3-tts-instruct-flash',voices:{female:'女声',male:'男声'}}, storyboard:{configured:false,model:''} };
```

文件末尾（`generateShotAudio` 之后）新增：

```ts
export const generateStoryboard = (projectId:string,input:{story:string;count:number|null}) => api<{project:Project}>(`/api/projects/${projectId}/storyboard`,{method:'POST',body:JSON.stringify(input)});
```

- [ ] **Step 2: Update components/useStudio.ts**

1. import 的 client 函数列表加入 `generateStoryboard`。
2. `generating` 计算行改为：

```ts
const generating = [...(project?.shots ?? []), ...(project?.scenes ?? [])].some(s => s.status === 'generating') || (project?.shots ?? []).some(s=>s.audio.status==='generating') || project?.storyboardDraft?.status === 'generating';
```

3. `createAndOpen` 的 body 参数类型放宽为 `body?: { name: string; style?: string; story?: string; count?: number | null }`（POST body 序列化不变）。
4. `create` 改为：

```ts
const create = (name: string, style: string, story = '', count: number | null = null) => createAndOpen('/api/projects', story ? { name, style, story, count: count ?? undefined } : { name, style });
```

5. 在 `generateAudio` 函数之后新增（对齐 `generateAudio` 的错误恢复模式）：

```ts
async function storyboard(story: string, count: number | null) {
  if (!authenticated || !current.current || isReadOnlyProject(current.current)) return;
  setError('');
  const id = current.current.id;
  const version = navigation.version;
  try {
    await flush();
    if (current.current?.id !== id || navigation.version !== version) return;
    const result = await generateStoryboard(id, { story, count });
    await receiveGenerationAcknowledgement(result.project, version);
  } catch (e) {
    const message = (e as Error).message;
    try {
      if (!dirty.current && current.current?.id === id && navigation.version === version) {
        const result = await getProject(id);
        if (!dirty.current && current.current?.id === id && navigation.version === version) replace(result.project);
      }
    } catch { /* Keep last loaded data visible. */ }
    if (navigation.version === version) setError(message);
  }
}
```

6. 返回对象中加入 `generateStoryboard: storyboard`。

- [ ] **Step 3: Typecheck, lint, run full tests**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: 全部通过。

- [ ] **Step 4: Commit**

```bash
git add lib/client.ts components/useStudio.ts
git commit -m "feat: wire storyboard generation into client and studio state"
```

---

### Task 6: 前端界面（Storyboard 组件 + Studio 集成）

**Files:**
- Create: `components/Storyboard.tsx`
- Modify: `components/Studio.tsx`

**Interfaces:**
- Consumes: `studio.generateStoryboard`/`studio.create`/`studio.config.storyboard`（Task 5）、`applyStoryboardDraft`（Task 3）、`studio.flush`/`studio.update`。
- Produces: 用户可见功能（无下游代码依赖）。

项目现状不测试 React 组件（现有测试全部针对 lib 层），本任务以 `npm run typecheck` + `npm run lint` + `npm run build` + 手动验收验证。

- [ ] **Step 1: Create components/Storyboard.tsx**

```tsx
'use client';
import { useState } from 'react';
import { Check, LoaderCircle, Sparkles, Trash2, UsersRound, WandSparkles } from 'lucide-react';
import type { Project, StoryboardDraft } from '../lib/types';

const MAX_STORY_LENGTH = 20000;
const nameKey = (name: string) => name.trim().toLowerCase();

export function StoryboardComposer({ busy, configured, initialStory, onClose, onSubmit }: { busy: boolean; configured: boolean; initialStory?: string; onClose: () => void; onSubmit: (story: string, count: number | null) => Promise<void> }) {
  const [story, setStory] = useState(initialStory ?? '');
  const [count, setCount] = useState('');
  const [working, setWorking] = useState(false);
  const trimmed = story.trim();
  const parsedCount = count.trim() ? Number(count) : null;
  const countValid = parsedCount === null || (Number.isInteger(parsedCount) && parsedCount >= 4 && parsedCount <= 60);
  const invalid = !trimmed || trimmed.length > MAX_STORY_LENGTH || !countValid;
  return <Modal title="AI 拆镜头" onClose={onClose}>
    <form className="modal-form" onSubmit={async e => {
      e.preventDefault();
      if (invalid || working) return;
      setWorking(true);
      try { await onSubmit(trimmed, parsedCount); onClose(); } finally { setWorking(false); }
    }}>
      <p className="muted">粘贴一段故事，AI 会拆解成分镜草稿；确认之前不会改动作品。</p>
      <label>故事文本<textarea rows={10} value={story} maxLength={MAX_STORY_LENGTH} onChange={e => setStory(e.target.value)} placeholder="把你的故事粘贴到这里…" /></label>
      <p className="field-hint">{trimmed.length}/{MAX_STORY_LENGTH} 字符</p>
      <label>期望镜头数（可选）<input inputMode="numeric" value={count} onChange={e => setCount(e.target.value.replace(/[^0-9]/g, ''))} placeholder="留空由 AI 根据故事长度决定" /></label>
      {!configured && <p className="notice warning">尚未配置百炼 API Key，请先在生成服务设置中了解配置方式。</p>}
      {!countValid && <p className="notice warning">期望镜头数必须是 4–60 的整数。</p>}
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>取消</button>
        <button className="button primary" disabled={invalid || working || !configured || busy}>{working ? <LoaderCircle size={16} className="spin" /> : <WandSparkles size={16} />}开始拆分</button>
      </div>
    </form>
  </Modal>;
}

export function StoryboardDraftModal({ project, draft, busy, onClose, onDiscard, onConfirm }: { project: Project; draft: StoryboardDraft; busy: boolean; onClose: (selectId?: string) => void; onDiscard: () => void; onConfirm: (keptIndexes: number[]) => Promise<string | null> }) {
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const keptIndexes = draft.shots.map((_, i) => i).filter(i => !removed.has(i));
  const usedNames = new Map<string, string>();
  for (const shot of keptIndexes.map(i => draft.shots[i])) for (const name of [...shot.characters, ...(shot.speaker ? [shot.speaker] : [])]) { const key = nameKey(name); if (key && !usedNames.has(key)) usedNames.set(key, name.trim()); }
  const confirm = async () => {
    setWorking(true); setError('');
    try { const selectId = await onConfirm(keptIndexes); onClose(selectId ?? undefined); }
    catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  };
  return <Modal title="AI 分镜草稿" wide onClose={() => onClose()}>
    <div className="modal-form">
      {error && <p className="notice error">{error}</p>}
      <div className="storyboard-summary">
        <strong>识别出 {usedNames.size} 个人物</strong>
        <div className="character-chips">
          {[...usedNames.entries()].map(([key, name]) => {
            const existing = project.characters.find(c => nameKey(c.name) === key);
            const description = draft.characters.find(c => nameKey(c.name) === key)?.description;
            return <span key={key} className="character-chip selected" title={description || '外观待补充'}><UsersRound size={14} />{name}{existing ? '' : ' · 新建'}{existing ? ' · 复用' : ''}</span>;
          })}
        </div>
      </div>
      <div className="storyboard-shot-list">
        {draft.shots.map((shot, i) => removed.has(i) ? null : <article key={i} className="storyboard-shot-card">
          <header><span>{String(i + 1).padStart(2, '0')}</span><strong>{shot.title}</strong><span className="tag">{shot.duration}s</span><button className="icon-button danger-hover" aria-label={`删除草稿镜头${i + 1}`} disabled={busy} onClick={() => setRemoved(prev => new Set(prev).add(i))}><Trash2 size={14} /></button></header>
          <dl>
            <div><dt>场景</dt><dd>{shot.scene || '—'}</dd></div>
            <div><dt>画面</dt><dd>{shot.description}</dd></div>
            <div><dt>对白</dt><dd>{shot.dialogue || '—'}</dd></div>
            <div><dt>人物</dt><dd>{[...new Set([...shot.characters, ...(shot.speaker ? [shot.speaker] : [])])].join('、') || '—'}</dd></div>
          </dl>
        </article>)}
      </div>
      <div className="modal-actions spread">
        <button className="text-button danger-text" disabled={busy || working} onClick={onDiscard}><Trash2 size={15} />放弃草稿</button>
        <div className="row">
          <button className="button" disabled={busy || working} onClick={() => onClose()}>稍后再说</button>
          <button className="button primary" disabled={busy || working || !keptIndexes.length} onClick={() => void confirm()}>{working ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}添加 {keptIndexes.length} 个分镜</button>
        </div>
      </div>
      <p className="muted small">写入后可在镜头设定中继续微调；同名角色已自动复用。</p>
    </div>
  </Modal>;
}
```

说明：`onConfirm` 由 Studio 实现（含确认前 `flush` 与 `applyStoryboardDraft` 映射，见 Step 2 第 7 点）；`Modal` 组件的 onClose 保持 `() => void` 不变，`StoryboardDraftModal` 自身的 `onClose: (selectId?: string) => void` 签名在组件内部消费。

- [ ] **Step 2: Integrate into components/Studio.tsx**

1. import 增加：

```ts
import { StoryboardComposer, StoryboardDraftModal } from './Storyboard';
```

2. `modal` state 的联合类型追加 `'storyboard-compose' | 'storyboard-draft'`；新增 state：

```ts
const [composerStory,setComposerStory]=useState('');
const [dismissedDraftKey,setDismissedDraftKey]=useState('');
```

3. 草稿自动弹出 effect（放在现有 popstate effect 之后）：

```ts
const draft=project?.storyboardDraft ?? null;
const draftKey=draft ? `${draft.story.length}-${draft.shots.length}-${draft.characters.length}-${draft.status}` : '';
useEffect(() => {
  if (!draft || draft.status!=='ready' || modal==='storyboard-draft' || dismissedDraftKey===draftKey) return;
  setModal('storyboard-draft');
}, [draft, draftKey, modal, dismissedDraftKey]);
```

4. 入口按钮：`workspace-toolbar` 的按钮组里、`添加分镜` 按钮旁新增：

```tsx
<button className="button compact" disabled={editingDisabled} onClick={()=>{setComposerStory('');setModal('storyboard-compose');}}><WandSparkles size={15} />AI 拆镜头</button>
```

空作品 `empty-workbench` 的按钮下方追加同样入口（复制按钮，`story` 初始为空）。

5. 草稿状态横幅：放在 `sample-banner` 之后（`project && !studio.loading &&` 条件下）：

```tsx
{project && draft && !studio.loading && (draft.status==='generating'
  ? <div className="sample-banner"><LoaderCircle size={18} className="spin" /><div><strong>正在拆分故事…</strong><p>通常需要 30–60 秒，期间可以继续编辑其他内容。</p></div></div>
  : draft.status==='failed'
    ? <div className="error-banner" role="alert"><AlertCircle size={18} /><span>{draft.error || '拆分失败，请重试。'}</span><button onClick={()=>{setComposerStory(draft.story);setModal('storyboard-compose');}}>重试</button><button className="icon-button" aria-label="关闭提示" onClick={()=>{ update(p=>({...p,storyboardDraft:null})); }}><X size={15} /></button></div>
  : <div className="sample-banner"><Sparkles size={18} /><div><strong>AI 分镜草稿待确认</strong><p>共拆出 {draft.shots.length} 个镜头，确认后写入分镜列表。</p></div><button className="button primary compact" onClick={()=>setModal('storyboard-draft')}>查看草稿</button><button className="button compact" disabled={editingDisabled} onClick={()=>{ void studio.flush().catch(()=>{}); update(p=>({...p,storyboardDraft:null})); setDismissedDraftKey(draftKey); }}>放弃</button></div>)}
```

6. 新建作品 Modal 的表单：`画风描述` label 之后追加（表单提交时读取这两个 state）：

```tsx
<label>用一段故事开始（可选）<textarea rows={4} value={newStory} maxLength={20000} onChange={e=>setNewStory(e.target.value)} placeholder="粘贴故事，创建后自动拆成分镜草稿" /></label>
<label>期望镜头数（可选）<input inputMode="numeric" value={newStoryCount} onChange={e=>setNewStoryCount(e.target.value.replace(/[^0-9]/g,''))} placeholder="4–60，留空由 AI 决定" /></label>
```

对应新增 state `const [newStory,setNewStory]=useState(''); const [newStoryCount,setNewStoryCount]=useState('');`，`openCreate` 时一并重置；表单 `onSubmit` 改为：

```tsx
onSubmit={async e => {
  e.preventDefault();
  const story=newStory.trim();
  const count=story&&newStoryCount.trim()?Number(newStoryCount):null;
  if (newName.trim() && newStyle.trim() && (!story||story.length<=20000) && (count===null||(Number.isInteger(count)&&count>=4&&count<=60)) && await studio.create(newName.trim(),newStyle.trim(),story,count)) { setModal(null); setActiveId(''); setPage(page==='characters'||page==='scenes'?page:'shots'); }
}}
```

7. 两个 Modal 的渲染（其他 modal 旁）：

```tsx
{modal==='storyboard-compose' && <StoryboardComposer busy={disabled} configured={studio.config.storyboard.configured} initialStory={composerStory} onClose={()=>setModal(null)} onSubmit={(story,count)=>studio.generateStoryboard(story,count)} />}
{modal==='storyboard-draft' && project && draft && <StoryboardDraftModal project={project} draft={draft} busy={editingDisabled}
  onClose={(selectId?:string)=>{ setModal(null); if(draftKey) setDismissedDraftKey(draftKey); if(selectId) setActiveId(selectId); }}
  onDiscard={()=>{ void studio.flush().catch(()=>{}); update(p=>({...p,storyboardDraft:null})); setModal(null); if(draftKey) setDismissedDraftKey(draftKey); }}
  onConfirm={async keptIndexes=>{
    await studio.flush().catch(()=>{});
    const result=applyStoryboardDraft(project,draft,keptIndexes);
    update(()=>result.project);
    return result.insertedShotIds[0] ?? null;
  }} />}
```

（`applyStoryboardDraft` 加入文件顶部 import。）

8. `settings` modal 的 `service-status-grid` 内追加一行：

```tsx
<div className={`notice ${studio.config.storyboard.configured?'success':'warning'}`}><span className="tiny-dot" />{studio.config.storyboard.configured?`AI 拆镜头：百炼 · ${studio.config.storyboard.model}`:'AI 拆镜头：尚未配置百炼 API Key'}</div>
```

- [ ] **Step 3: Typecheck, lint, build**

```bash
npm run typecheck && npm run lint && npm run build
```
Expected: 全部通过（Storyboard.tsx 的 JSX 完整实现时按本任务说明的 `onConfirm` 签名对齐，未用到的 import 如 `Sparkles`/`Check` 按实际使用裁剪）。

- [ ] **Step 4: Manual acceptance**

启动 `npm run dev`，使用已配置 `DASHSCOPE_API_KEY` 的 `.dev.vars`，逐项验证：

1. 新建作品 Modal 粘贴一段故事 + 期望镜头数 6 → 创建后进入作品，出现「正在拆分故事…」横幅 → 完成后自动弹出草稿预览。
2. 预览中删除 1 个镜头 → 点「添加 N 个分镜」→ 分镜列表追加、首个新镜头被选中、草稿横幅消失。
3. 人物区显示「复用/新建」标注；写入后角色设定页出现新建角色卡（默认女声）。
4. 已有作品中点「AI 拆镜头」→ 提交 → 生成中继续编辑镜头描述（自动保存不冲突）→ ready 后确认写入。
5. 拆分失败场景（临时改错 key）→ 横幅显示错误 + 重试按钮预填原故事。
6. 预览阶段刷新页面 → 草稿横幅仍在，点「查看草稿」可继续确认。
7. 未配置 Key 的环境 → 入口提交按钮禁用、设置弹窗显示未配置。

- [ ] **Step 5: Commit**

```bash
git add components/Storyboard.tsx components/Studio.tsx
git commit -m "feat: add storyboard composer and draft preview ui"
```

---

### Task 7: 配置与文档

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/README.md`

**Interfaces:** 无代码接口；文档与配置样例。

- [ ] **Step 1: Update .env.example**

在 `DASHSCOPE_API_KEY` 相关行之后追加：

```dotenv
# AI 拆镜头使用的百炼文本模型与兼容模式地址（可选，默认 qwen-max / 北京 compatible-mode）
STORYBOARD_LLM_MODEL=qwen-max
STORYBOARD_LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

- [ ] **Step 2: Update README.md**

`## 功能介绍` 列表在分镜编排一条之后插入：

```markdown
- 粘贴一段故事文本，AI 自动拆解为分镜草稿；预览确认后写入，同名角色自动复用，新人物自动建立角色卡。
```

`### 生成服务配置` 的 dotenv 示例追加两行（同上 `.env.example` 内容）。

- [ ] **Step 3: Update docs/README.md**

在「## 配音接口配置」章节之后新增章节：

````markdown
## AI 拆镜头配置

复用百炼 `DASHSCOPE_API_KEY`，通过 OpenAI 兼容模式调用 qwen 文本模型把故事拆成分镜草稿。可选环境变量：

```dotenv
STORYBOARD_LLM_MODEL=qwen-max
STORYBOARD_LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

- 新建作品时可粘贴故事（≤ 20000 字符）与可选期望镜头数（4–60）；已有作品在分镜台点「AI 拆镜头」追加。
- 任务在后台执行，前端轮询；拆分中断超过十分钟自动转为可重试失败，原始故事保留。
- 草稿先预览、可删除个别镜头，点「添加 N 个分镜」才写入作品；同名角色自动复用，新人物按 AI 推断外观建卡（默认女声、无参考图，生成画面前需补充）。
- 每镜头对白 ≤ 600 字符；时长按对白长度校正下限（约 4 字/秒），写入后可用「按配音调整时长」精确适配。
- 草稿只填场景自由文字，不自动创建场景卡；不拆分多角色轮流发言（沿用每镜头一位说话角色的约束）。
````

`## 验证` 一节的测试覆盖描述追加「AI 拆镜头 provider、草稿映射、storyboard 端点与创建即拆分」。

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md docs/README.md
git commit -m "docs: document storyboard generation configuration"
```

---

### Task 8: 全量验证与收尾

**Files:** 无新文件；验证全仓库。

- [ ] **Step 1: Full verification suite**

```bash
npm test
npm run typecheck
npm run lint
npm run build
```
Expected: 四项全部通过、零错误。

- [ ] **Step 2: Spot-check git history**

```bash
git log --oneline -8
```
Expected: 每个任务一个提交，无遗漏未提交文件（`git status` 干净）。

- [ ] **Step 3: Final commit if needed**

若收尾发现小问题并修复，提交：`git commit -m "fix: address storyboard generation review findings"`；否则无需额外提交。
