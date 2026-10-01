# 完整动作拆镜与独立首尾帧实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** AI 按完整动作拆镜；每个镜头以自身选图为首帧，可自行生成、上传或选择尾帧。

**Architecture:** 复用镜头候选图集合和现有异步生图接口，增加独立的尾帧描述和选图字段。新视频保存独立首尾帧来源指纹；旧单帧和相邻镜头首尾帧视频仍按原始来源检查，保留素材与运行中的任务。

**Tech Stack:** React / TypeScript / vinext / Cloudflare D1 + R2 / OpenAI Images 兼容接口 / Wan 3.0。

## Global Constraints

- 本地开发；不提交、不推送、不部署、不调用付费模型。
- 用户自行手动测试；完成类型检查、lint、构建和独立代码审查。
- 本次只实现建议 1、2；不增加镜头关系类型、自动合并已有镜头或裁剪编辑入口。
- 首帧沿用 `selectedCandidateId`；候选图和视频追加保存，不自动替换选择。
- 第一个镜头可生成视频；新视频不依赖前一镜头，不因排序变化而过期。

### Task 1: AI 拆镜规则

**Files:** `lib/storyboard.ts`, `lib/generation.ts`, `components/Storyboard.tsx`, `components/Studio.tsx`。

**Interfaces:** `buildStoryboardMessages(story, requestedCount)` 保持 JSON 字段不变；`buildShotPrompt(project, shot)` 绘制完整动作的起始画面。

- [x] 将规则改为同场景、同机位的连续动作尽量保持为一个镜头；景别/机位/地点/时间或叙事目的变化可切镜。禁止机械按句子或为了镜头数量拆镜。
- [x] 描述依次包含起始画面、动作过程、结束状态、必要运镜。时长参考完整动作和对白，视频目标 2–30 秒，长段在自然节点拆分；沿用一镜头一说话人数据约束。
- [x] 期望数量只作为参考，完整动作和故事信息优先；页面说明这一点。
- [x] 静图生图提示明确只画起始状态，避免把连续动作画成多格拼图。

### Task 2: 独立首尾帧数据与生成

**Files:** `lib/types.ts`, `lib/domain.ts`, `lib/video-frames.ts`, `lib/generation.ts`, `lib/video.ts`, `lib/server.ts`, `components/useStudio.ts`。

**Interfaces:**

```ts
// Shot 新增可选字段，旧作品缺省为无尾帧。
endFrameDescription?: string;
selectedEndCandidateId?: string | null;
// Candidate 记录生成/上传的用途，仍可互换选为首帧或尾帧。
frame?: 'start' | 'end';
// VideoSource 区分新视频和两种历史视频。
sourceMode?: 'independent';
```

- [x] 初始化、规范化并验证新增字段；尾帧 ID 必须属于当前镜头候选集合。素材权限沿用现有账号资产检查。
- [x] `getVideoFrameContext` 返回当前首帧、可选尾帧，保留历史前驱信息供老任务恢复和检查。
- [x] 新来源指纹包含首尾 ID/URL、描述、对白、时长、说话角色/语气、开口停顿、风格、画幅；不包含排序或前驱 ID。历史来源算法单独保留。
- [x] POST 生图增加 `frame: 'end'`，必须已选首帧且填写尾帧描述；参考图按原角色/场景顺序附加首帧，生成图追加到当前镜头池并标记 `frame: 'end'`。
- [x] POST 视频读取当前镜头首帧和可选尾帧；无尾帧只传 `first_frame`。提示词只有实际选尾帧时才要求结束画面约束。
- [x] 新视频生成期间锁定本镜头描述及首尾选图（含 URL）；历史运行任务继续保护旧前驱。重排新视频不锁其他镜头。
- [x] 客户端尾帧生图复用保存、异步提交和轮询流程；失败保留图与选图并提供重试。

### Task 3: 编辑界面与预览

**Files:** 新增 `components/ShotEndFrameModal.tsx`；修改 `components/ShotVideoControls.tsx`, `components/Studio.tsx`, `components/Preview.tsx`, `app/globals.css`。

**Interfaces:** 尾帧弹窗接收当前 `shot`、编辑禁用状态、尾帧锁状态、错误提示、`onChange(Partial<Shot>)`、`onGenerate(count)`、`onUpload(files)`、`onClose()`；弹窗内部管理候选图放大状态。

- [x] 视频设置展示本镜头首帧和可选尾帧，添加/更换/移除尾帧。首镜头的生成按钮正常使用。
- [x] 尾帧弹窗提供描述、1–4 张生成、上传、全部候选选图和图片放大；生成后用户自行选择，移除选图不删素材。
- [x] 视频候选可在任一镜头选用。预览允许首镜头视频，历史视频 poster 使用其记录的首帧来源。
- [x] 保留现有裁剪字段和播放范围计算，使播放器使用同一范围；不新增裁剪 UI。

### Task 4: 文档与审查

**Files:** `docs/README.md`, `docs/wan3-video-guide.md`；维护现有视频测试中的旧预期（不执行自动测试）。

- [x] 文档说明独立首帧、可选尾帧生成与上传、AI 拆镜原则和历史视频兼容方式。
- [x] `npm run typecheck`：退出 0。
- [x] `npm run lint`：退出 0。
- [x] `npm run build`：退出 0。
- [x] `git diff --check`：退出 0。
- [x] 独立审查 UI 操作、旧数据恢复、来源判定、锁定、并发回包及素材隔离，修复重要问题并验证。

手动验收：新首镜头只选首帧即可生成；加尾帧后请求两张图；尾帧生成与上传保留选择，移除可回到单首帧；换图提示视频过期；新镜头视频排序不变更来源；旧视频及已提交任务保留；刷新恢复尾帧描述与选择。

## 审查修复记录

- 首帧、尾帧和场景生图均纳入待回执保护，避免其他任务回包提前解除生图状态。
- 客户端与服务端均阻止删除运行中的任务目标；服务端保留生图用途和视频任务记录。
- 视频生成期间选用已有视频可正常保存，不覆盖当前任务。
- 尾帧弹窗显示提交前校验错误；新视频预览使用实际首帧来源作为封面。
- 独立代码复查未发现剩余 Important/Critical 问题；浏览器手动验收与真实模型调用由用户进行。

验证结果：`npm run typecheck`、`npm run lint`、`npm run build`、`git diff --check` 均退出 0。未执行自动测试、浏览器操作或真实模型调用；未提交、推送或部署。
