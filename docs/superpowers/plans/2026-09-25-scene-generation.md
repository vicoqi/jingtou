# 场景生成 Implementation Plan

> **For agentic workers:** Execute inline in the current feature branch; retain the existing local workspace and development server. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在作品编辑中管理、生成和选择场景图，并供多个分镜复用。

**Architecture:** 场景和候选图记录随现有 D1 作品 JSON 保存，图片继续存入 R2。旧文档缺少 scenes 时按空列表读取；镜头新增可选 sceneId，保留原有场景文字。共享现有生成请求、后台任务、版本合并与失败恢复逻辑。

**Tech Stack:** React 19、TypeScript、Vinext、D1/R2、Node test runner。

## Global Constraints

- 只在本地开发，不推送或部署。
- 生成 1–4 张候选图，保留历史和当前选择；复用作品画风。
- 只读样例不可修改、上传或生成；图片校验归属。
- 变更场景设定或选图只影响后续生图；删除场景移除引用，已有镜头素材保留。
- 自动化验证使用受控提供商响应，不触发真实付费生图。

### Task 1: 场景模型和生成输入

Files: `lib/types.ts`, `lib/domain.ts`, `lib/generation.ts`, `lib/sample.ts`, `tests/scenes.test.ts`。

Interfaces: `Scene` 包含 id/name/description/candidates/selectedCandidateId/status/error/generationId/generationStartedAt；`newScene(): Scene`、`removeScene(project, id): Project`；`mergeGeneration` 新增可选集合参数 `'shots' | 'scenes'`；`buildScenePrompt(project, scene): string`、`shotReferenceUrls(project, shot): string[]`。

- [x] 先验证旧文档兼容、场景数据校验、删除解除关联、场景重做不丢素材、角色图在前且场景图紧随其后的提示词顺序。
- [x] 执行 `node --experimental-strip-types --test tests/scenes.test.ts`，确认新增行为尚未实现。
- [x] 实现场景数据与上述函数；关联场景未选图时明确报错，避免静默不使用场景。
- [x] 重跑场景测试并检查已有生成测试。

### Task 2: 保存和生图 API

Files: `lib/server.ts`, `tests/server.test.ts`。

Interfaces: `POST /api/projects/:id/generate-scene` accepts `{sceneId, count}` and returns `{project}`。场景生成调用文生图，引用场景的分镜按角色图、场景图顺序调用图生图。

- [x] 编写 API 失败测试覆盖保存重开、生成失败/重试、生成中并发修改、后台任务注册、失效任务恢复、素材归属、只读样例与候选数量上限。
- [x] 运行 `npm test` 确認预期失败。
- [x] 接入共享生成处理、场景资产归属检查、服务端生成状态保护与旧文档读取兼容。
- [x] 执行 `npm test`，所有场景和原有分镜行为通过。

### Task 3: 场景编辑页与分镜引用

Files: `components/Scenes.tsx`, `components/Studio.tsx`, `components/useStudio.ts`, `app/globals.css`, `README.md`。

Interfaces: `Scenes` receives project/update/busy/onGenerate/onUploadingChange；`useStudio.generateScene(sceneId, count)` flushes before generating and recovers server state after failure。

- [x] 加入共用的作品页签（分镜台、角色设定、场景生成），场景创建/编辑/删除、上传、生成数量、选图/放大和错误重试。
- [x] 镜头编辑加入关联场景下拉与选图预览，保留原有场景补充说明。
- [x] 轮询和 busy 状态涵盖场景生成；只读样例提供浏览与复制入口。
- [x] 更新 README，执行 `npm test`、`npm run typecheck`、`npm run lint`、`npm run build` 和 `git diff --check`。
- [x] 受控 HTTP 验证保存与重开场景，并确认旧作品仍可读取。完成后本地提交并报告未做真实付费生图验收。

## Validation results

- 60 automated tests passed, including 13 new scene domain/API cases.
- HTTP smoke against the local service passed: scene image selection persisted, shared references reopened, removal preserved shot images.
- TypeScript, ESLint, production build and whitespace checks passed.
- Provider behavior was tested with controlled image responses; no real paid generation or browser interaction test was performed.
