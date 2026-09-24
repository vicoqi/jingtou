# 镜头 · 动漫短剧工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the full Chinese-language PRD: reusable characters and reference images, ordered shots, reference-guided image candidates, nondestructive regeneration, persistent projects, and timed subtitle preview.

**Architecture:** React/Vinext workbench with a Worker API. D1 stores versioned project documents and R2 stores image bytes. Generation uses a configurable image-editing API on the server; absence of credentials is shown explicitly. Concurrent saves use revision checks and generation merges only its target shot.

**Tech Stack:** TypeScript, React, Vinext/Vite, Cloudflare D1/R2, Drizzle migrations, Node test runner.

## Global Constraints

- 生成镜头时，应使用该镜头关联角色的参考图。
- 重做一个镜头，不影响其他镜头的画面和选择结果。
- 修改角色设定后，已有镜头保留，后续生成使用更新后的设定。
- 保存作品的角色、分镜、候选图和选择结果，再次打开可继续制作。
- 未选定画面、生成中和生成失败的镜头，应有明确状态提示。
- 存在未完成镜头时，预览应提示缺失位置。
- 预览仅按分镜时长播放静态画面与字幕，不包含配音、视频导出或人物动画。

## Shared contract

`lib/types.ts` exports:
```ts
type ReferenceImage = { id: string; url: string; name: string };
type Character = { id: string; name: string; description: string; references: ReferenceImage[] };
type Candidate = { id: string; url: string; createdAt: string; prompt: string; batchId: string; source: 'generated' | 'uploaded' | 'sample' };
type Shot = { id: string; title: string; characterIds: string[]; scene: string; description: string; dialogue: string; duration: number; candidates: Candidate[]; selectedCandidateId: string | null; status: 'idle' | 'generating' | 'failed'; error: string | null; generationId: string | null; generationStartedAt: string | null };
type Project = { id: string; name: string; description: string; aspectRatio: '16:9' | '9:16'; style: string; characters: Character[]; shots: Shot[]; revision: number; createdAt: string; updatedAt: string };
type ProjectSummary = { id: string; name: string; description: string; updatedAt: string; shotCount: number; selectedCount: number; duration: number; cover: string | null };
```

JSON API: `GET /api/projects` → `{projects: ProjectSummary[]}`; `POST /api/projects` body `{name, demo?: boolean}` → `{project}`; `GET /api/projects/:id` → `{project}`; `PUT /api/projects/:id` body `{project}` → `{project}` (409 on stale revision); `DELETE /api/projects/:id`; `POST /api/upload` multipart `file` → `{image: ReferenceImage}`; `POST /api/projects/:id/generate` body `{shotId, count}` → `{project}`; `GET /api/config` → `{configured: boolean, model: string}`. Errors `{error: string}`. Generation route responds after completion; polling GET recovers state after closing/reopening.

### Task 1: Persistent production domain and generation backend

**Files:** `lib/types.ts`, `lib/domain.ts`, `lib/server.ts`, `lib/generation.ts`, `lib/sample.ts`, `db/schema.ts`, `worker/index.ts`, `.openai/hosting.json`, `.env.example`, `tests/domain.test.ts`, `tests/generation.test.ts`, Drizzle migrations.

**Interfaces:** Shared contract above; `getTimeline(shots)` returns `{shot, start, end}[]`; `shotAtTime(shots,time)` returns `Shot | null`; `newShot()` returns an empty five-second shot.

- [x] Write and run failing tests for preserving selection/history during generation, isolation of other shots, timeline ordering/boundaries, updated character-reference prompts, failed/retried generation, invalid duration and malformed references.
- [x] Implement types, pure functions, durable D1/R2 API and validated provider adapter. Require reference images for each associated character. Accept PNG/JPEG/WebP uploads capped at 10 MiB. Verify uploaded bytes, store originals, disallow arbitrary reference URLs in generation. Secrets remain server-side. Use local identity only on localhost and forwarded platform identity when hosted.
- [x] Test revision conflicts and safe merging of generation results. Persist generating state before calling upstream; persist failures without discarding candidates. Recover stale jobs as retryable failures.
- [x] Configure DB/ASSETS_BUCKET bindings and generate/inspect migration. Create a twelve-shot, sixty-second sample clearly marked as sample, using three explicitly labeled originals at `/samples/summer.png`, `/samples/linxia.png`, and `/samples/chenyu.png` across the twelve shots; absence of sample assets must not compromise real projects.
- [x] Run meaningful Node tests and report exact commands/results. No real paid provider request without user credentials.

### Task 2: Complete creation workbench and preview

**Files:** `app/page.tsx`, `app/globals.css`, `app/layout.tsx`, `components/Studio.tsx`, `components/Characters.tsx`, `components/Preview.tsx`, `components/Modal.tsx`, `lib/client.ts`, `tests/preview.test.ts`, `README.md`.

**Interfaces:** Consume the shared API and types. UI always uses returned revisions; writes serialized; show save failures and allow retry/reload.

- [x] Write timeline/preview acceptance tests first, confirming twelve five-second shots span sixty seconds, missing shots retain their position and subtitles use current ordered data.
- [x] Build a dark graphite workspace with warm lime accent, compact project sidebar, filmstrip shot list, large central selected image, shot editor and candidate strip. Responsive navigation must preserve all actions on narrow screens.
- [x] Implement project creation/opening, character CRUD/reference upload/remove, shot CRUD/reordering/fields, candidate upload/zoom/compare/select, generation and retry with clear status, confirmation only for destructive deletions.
- [x] Implement accessible modal focus handling, labels, keyboard selection and playback shortcuts, ordered timed playback, pause/scrub and missing-shot cards. Preview derives directly from current project state.
- [x] Remove starter skeleton and starter metadata; document provider config, data storage and limitations. Build site-specific image assets and social preview with truthful sample labels.
- [x] Run tests, TypeScript and production build; review requirement coverage and fix important findings.

### Task 3: Local delivery (user update: 2026-09-24)

- [x] User explicitly requested local-only delivery and no remote source push. Stop publishing.
- [x] Local app responds successfully at http://localhost:3000/; provider configuration accurately reports unconfigured.
- [x] 27 tests, TypeScript, ESLint, production build, and live HTTP smoke passed. Independent review approved the MVP; accessible dialog labels and sidebar summary updates were subsequently fixed.
- [x] Source saved locally on feat/jingtou-mvp. No Git remote is configured and no source was pushed. An empty private Sites project record had been created before the user's local-only instruction; no version was published.
- [x] Deliver local URL and README instructions. Live provider generation and manual character-consistency acceptance require the user's model and API key.
