# AI 拆镜头（故事 → 分镜）设计

日期：2026-09-29
状态：待审阅

## 背景与目标

创作者通常已有一段写好的故事，再手工逐镜头填写标题、画面描述、对白、时长，是当前工作流中最重的环节。本功能让用户粘贴一段故事文本，由文本 LLM 自动拆解为分镜草稿，经预览确认后写入作品。

成功标准：

- 粘贴一段几百到几千字的故事，约 30–60 秒内得到一组有序分镜草稿（标题、场景、画面描述、对白、时长、出场人物、说话人物）。
- 草稿先预览、可删除个别镜头，确认后才写入分镜列表；AI 内容不直接进入正式数据。
- 已有同名角色自动复用，新人物自动创建角色卡（名字 + AI 推断外观 + 默认女声）。
- 新建作品与已有作品追加两个入口都可用。

## 已确认的产品决定

| 决定项 | 结论 |
|---|---|
| 入口 | 新建作品时（可选粘贴故事）+ 已有作品分镜台「AI 拆镜头」按钮 |
| LLM 服务 | 复用 `DASHSCOPE_API_KEY`，走百炼 OpenAI 兼容模式调用 qwen 文本模型 |
| 角色映射 | 智能映射：同名复用已有角色，新人物自动建卡 |
| 确认流程 | 先预览草稿（可删镜头），确认后一次性写入 |
| 镜头数量 | 可选指定期望镜头数（4–60），留空由 AI 依故事长度决定 |

## 架构方案（已选：后台任务 + 草稿存项目文档）

与现有生图/配音任务同构，是该项目生成任务模式（`status/generationId` → 202 → 前端轮询 → 10 分钟过期恢复）的第三次复用：

1. 前端提交故事 → 服务端 CAS 写入 `storyboardDraft: { status: 'generating', … }` → 返回 202 + 最新项目文档。
2. Worker `waitUntil` 后台调用 LLM，输出经严格校验与规范化后 CAS 写回 `status: 'ready'` + 草稿内容；失败写 `status: 'failed'` + 错误信息。
3. 前端轮询项目文档（复用现有 3 秒轮询），`ready` 后弹出预览；确认时在客户端把草稿映射为正式 `shots`/`characters` 并清空草稿，走现有自动保存（PUT + revision）。

否决的替代方案：同步等待 LLM 返回（长请求断线即全丢、刷新丢草稿，与现有后台任务架构不一致）；任务状态存文档而结果存独立资源（Worker 无状态，结果仍须落库，多绕一圈无收益）。

## 数据模型

### `lib/types.ts` 新增类型

```ts
export type DraftCharacter = { name: string; description: string };
export type DraftShot = {
  title: string;
  scene: string;           // 场景自由文字（不自动建场景卡）
  description: string;     // 画面描述
  dialogue: string;        // 对白（原文优先，无声镜头为空串）
  speaker: string | null;  // 说话人物名，无对白为 null
  characters: string[];    // 出场人物名
  duration: number;        // AI 建议，服务端已校正
};
export type StoryboardDraft = {
  status: 'generating' | 'ready' | 'failed';
  error: string | null;
  generationId: string | null;
  generationStartedAt: string | null;
  story: string;           // 原始故事文本（展示与重试用）
  requestedCount: number | null;
  characters: DraftCharacter[];
  shots: DraftShot[];
};
```

`Project` 新增 `storyboardDraft: StoryboardDraft | null`。草稿中人物以名字字符串引用；名字到角色 ID 的映射在客户端确认时完成，职责划分：服务端负责 AI 输出的规范化与校验，客户端负责映射与写入。

### `lib/domain.ts` 扩展（对齐现有模式）

- `normalizeProject`：`storyboardDraft` 缺失补 `null`，旧数据无需迁移。
- `validateProject`：校验草稿结构——status 枚举；`story` ≤ 20000 字符；`requestedCount` 为 null 或 4–60 整数；`characters` ≤ 20 个且名字非空 ≤ 120 字符、描述 ≤ 3000；`shots` ≤ 60 个且逐字段对齐 Shot 约束（title ≤ 120、scene ≤ 500、description ≤ 4000、dialogue ≤ 600、duration 为 1–600 的有限数、speaker 为 null 或非空名字、characters 为非空名字数组）；`generating` 状态必须带 `generationId`/`generationStartedAt`，其余状态必须为 null；status 非 `ready` 时 `shots`/`characters` 为空数组。
- `rebaseProjectEdits`：`storyboardDraft` 始终取远端（本地不编辑草稿内容，同 shot.audio 的处理）。
- `recoverStale`：draft generating 超 10 分钟 → `failed`，error「故事拆分已中断，请重试。」

## LLM Provider（新文件 `lib/storyboard.ts`）

### 请求

- 端点：`${STORYBOARD_LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'}/chat/completions`，`Authorization: Bearer ${DASHSCOPE_API_KEY}`，超时 120 秒。
- 模型：`STORYBOARD_LLM_MODEL`，默认 `qwen-max`。
- 参数：`response_format: { type: 'json_object' }`，非流式。若配置的思考型模型与 json_object 组合报错，用户可改配置；不做流式思考降级（YAGNI）。
- 新增环境变量均加入 `.env.example` 与文档说明。

### 提示词（中文，系统提示 + 用户消息携带故事与期望镜头数）

要求 LLM：按叙事节奏拆成有序镜头；对白尽量取故事原文，无对白镜头 dialogue 留空；每镜头给出 title（短语）、scene（地点与环境短语）、description（景别、人物动作、表情、光线、构图，约 40–200 字）、duration（秒）、speaker、characters；从故事细节推断每个出场人物的外观（发型发色、服装、年龄感等，30–150 字）输出 characters 列表；只使用故事中出现的信息，不虚构关键设定；期望镜头数允许 ±20% 偏差；严格输出单个 JSON 对象。

### 输出校验与规范化（服务端，`validateProject` 同风格）

- 解析 `choices[0].message.content` 为 JSON；解析失败或结构不符 → 任务 failed，error「AI 返回格式异常，请重试。」
- 逐字段 trim 与 clamp：title ≤ 120、scene ≤ 500、description ≤ 4000、dialogue ≤ 600、duration clamp 至 [1, 600]（AI 建议值先 clamp 至 [1, 60] 再参与时长校正）。
- **时长校正**：`duration = max(建议值, dialogue 非空 ? ceil(对白字符数 / 4) : 0)`，保证对白大概率不被截断；生成配音后用户仍可用现有「按配音调整时长」精确适配。
- 人物规范化顺序：合并 `shots` 中出现但不在 `characters` 列表中的人物名（追加为 `{ name, description: '' }`，外观由用户后续补充）→ 按首次出现去重 → 超过 20 截断保留前 20。
- `shots` 超过 60 个时截断保留前 60 个。
- LLM 原始输出中的任何多余字段丢弃（白名单提取），不进入项目文档。

## API（`lib/server.ts`）

### `POST /api/projects/:id/storyboard`

- body：`{ story: string, count?: number | null }`；story trim 非空且 ≤ 20000 字符，count 为 null 或 4–60 整数，否则 400。
- 样例项目路径 403；`DASHSCOPE_API_KEY` 未配置 503「请配置百炼 API Key」；已有 `generating` 草稿 409「正在拆分，请稍候。」。
- CAS 循环（复用 `loadRecovered` + `saveCas`）写入 generating 状态与 `story`/`requestedCount`，返回 202 + `{ project }`；`waitUntil` 后台执行生成，结果经 12 次重试 CAS 循环写回（同 `generationResult` 模式；期间草稿被并发操作取代则 409 静默终止）。

### `POST /api/projects` 扩展（创建即拆分）

body 新增可选 `story`/`count`。服务端创建项目文档时直接将 `storyboardDraft` 置为 generating 态一并 INSERT（新项目无并发，无需 CAS 循环），`waitUntil` 启动生成，返回 201 + project。一次请求完成「创建 + 启动」，避免前端两步竞态。样例 copy 端点不受影响。

### 草稿的删除与覆盖

不需要专门端点：前端确认写入或放弃时将 `storyboardDraft` 置 `null` 走现有 PUT；重新发起任务自然覆盖旧草稿（`ready`/`failed` 状态下允许再次 POST）。

### PUT 保护（`protectStoryboardDraft`）

远端 draft 为 `generating` 时，本地 PUT 提交的 draft 字段被远端值覆盖（同 `protectGeneration` 对 shots/scenes 的处理）；远端非 generating 时以本地为准（允许置 null 确认/放弃）。

### 配置暴露

`/api/config` 新增 `storyboard: { configured: boolean, model: string }`（configured = 已配置 `DASHSCOPE_API_KEY`）；`lib/client.ts` 的 `WorkspaceConfig` 与 `EMPTY_WORKSPACE_CONFIG` 同步扩展。

## 前端

### 状态与数据流（`components/useStudio.ts`）

- 轮询条件加入 `project.storyboardDraft?.status === 'generating'`。
- 新增 `generateStoryboard(story, count)`：flush → POST `/storyboard` → `receiveGenerationAcknowledgement` 同款合并处理；失败时恢复服务端最新版本并报错（同 `generateAudio` 模式）。
- `create(name, style)` 扩展为可携带 `story`/`count`（`createAndOpen` 透传 body）。

### 组件（新文件 `components/Storyboard.tsx`，两个导出）

**`StoryboardComposer`**（输入弹窗）：
- 故事 textarea（≤ 20000 字符、带字数提示）+ 可选期望镜头数输入（4–60，留空自动）。
- 「开始拆分」提交 `generateStoryboard`；provider 未配置时按钮禁用并引导打开生成服务设置弹窗。

**`StoryboardDraftModal`**（预览确认弹窗）：
- 头部：故事文本折叠摘要、镜头数、识别出的人物列表（标注「复用已有角色」或「将新建角色」；同名匹配规则为 trim 后忽略大小写精确匹配）。
- 主体：镜头卡片列表（序号、标题、场景、画面描述、对白、时长、出场人物、说话角色），每条可删除。
- 底部：「添加 N 个分镜」主按钮、「放弃草稿」（置 null）、关闭（保留草稿稍后处理）。
- 确认时调用映射函数（见下）一次性 `update()` 写入并清空草稿，走现有自动保存；随后按返回的 `insertedShotIds` 自动选中首个新镜头。

### 映射逻辑（新文件 `lib/storyboard-import.ts`，纯函数可单测）

`applyStoryboardDraft(project, draft, keptIndexes): { project: Project; insertedShotIds: string[] }`：

- 仅对保留镜头计算用到的人物集合；同名已有角色复用其 id，其余人物按 `DraftCharacter` 新建（`newId()`、voice 默认 `'female'`、description 为空串时保留空）。
- 新镜头映射为正式 `Shot`：`showSubtitle: true`、`voiceInstruction: ''`、`audioLeadIn/audioTailOut: 0`、`speakerCharacterId` 按名字映射（speaker 名映射不到时置 null）、`characterIds` 为出场人物中可映射到的部分（映射不到的名字忽略）；`newShot()` 其余默认值。
- title 为空时回退 `镜头 ${现有镜头数 + 序号}`。
- 追加到 `shots` 末尾；前置校验追加后 `shots.length ≤ 200`、`characters.length ≤ 100`，超出返回错误由 UI 提示（先删旧镜头或减少导入数量）。

### 入口与状态 UI（`components/Studio.tsx`）

- 新建作品 Modal：新增可折叠「用一段故事开始（可选）」区域（textarea + 期望镜头数），提交走扩展后的 `create`。
- 分镜台工具栏新增「AI 拆镜头」按钮；空作品（无分镜）的空状态区同样新增入口。
- 项目内存在草稿时显示横幅：generating →「正在拆分故事…」；failed → 错误信息 + 「重试」（打开 Composer 并预填 `story`）；ready →「AI 分镜草稿待确认」+「查看」「放弃」。
- `ready` 状态首次出现时自动打开 `StoryboardDraftModal`（监听 draft 状态变化的 effect，用户关闭后不再自动弹出）。
- 生成服务设置弹窗（`settings` modal）增加一行「AI 拆镜头：qwen · {model}」状态。

## 错误处理

| 场景 | 行为 |
|---|---|
| LLM HTTP 错误/超时 | 任务 failed，error 为截断后的友好信息；保留 `story` 可一键重试 |
| JSON 解析/校验失败 | failed「AI 返回格式异常，请重试。」 |
| 生成中断（Worker 重启等） | 10 分钟 stale 恢复为 failed（复用 `recoverStale`） |
| 前端请求失败/断线 | 恢复服务端最新版本展示（同 `generateAudio` 失败路径）；任务仍在后台继续，轮询可恢复 |
| 重复提交 | 同项目 generating 中 409；ready/failed 允许覆盖重试 |
| 未配置 Key | 入口禁用 + 503 提示 + 设置弹窗引导 |
| 样例只读 | 403，同现有 generate 端点 |
| 确认写入超上限 | UI 提示先删旧镜头或减少导入数量 |

安全考虑：LLM 输出仅作为数据经白名单校验进入项目文档，不进入任何执行路径；草稿文字最终进入生图提示词的暴露面与用户手填 `shot.description` 相同，无新增风险；故事文本长度上限控制 token 成本。

## 测试

沿用 `node --test` + 受控 fetcher 模式，不新增测试框架：

- `tests/storyboard.test.ts`：provider 请求构造（端点、鉴权、response_format、模型默认值与环境变量覆盖）；受控返回的解析与规范化（clamp、时长校正、人物收集去重、截断至 60）；坏 JSON/缺字段/多余字段；超时。
- `tests/storyboard-import.test.ts`：同名复用与新建、仅保留镜头用到的人物、speaker 缺失容错、title 回退、上限校验、追加顺序。
- `tests/domain.test.ts` 增补：normalize 补 null；validate 合法/非法草稿各字段；rebase 取远端；recoverStale 草稿过期。
- `tests/server.test.ts` 增补：POST storyboard 202 与 ready/failed 写回；创建项目带 story 一次成型；409/403/503/400；PUT 期间 generating 草稿保护；确认写入（PUT 置 null）后草稿清除。
- 手动验收：真实 Key 下粘贴一段故事，检查拆分质量、预览、确认写入、角色映射与后续生图/配音流程不受影响。

## 不做的事（明确出界）

- 不自动创建场景卡（草稿只填 `scene` 自由文字，用户需要时手动建场景并关联）。
- 不做字幕分句、多说话人对白切分（沿用现有「每镜头一位说话角色一段对白」约束）。
- 不做流式输出/进度展示、不做草稿的逐字段行内编辑（删除整条即可，微调在写入后于镜头设定中进行）。
- 不做跨作品的智能映射（只在当前作品的角色库内匹配）。
- 不新增全局速率限制（与现有生图/配音一致的「同项目同类任务不重复提交」约束）。
