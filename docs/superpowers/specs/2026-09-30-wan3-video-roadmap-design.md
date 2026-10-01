# wan3.0-video 视频生成接入路线图

日期：2026-09-30
状态：规划（未实施）——本文是路线图沉淀，启动 Phase 1 时以其为输入再细化实施计划

## 背景与目标

流水线现状：故事文本 → AI 拆镜（已上线）→ 逐镜头生图（选定候选帧）→ TTS 配音 → 预览播放（静图 + TTS 音轨；无 Ken Burns 动效，也不打算做）。

缺最后一环：**镜头视频化**（选定帧 + camera prompt → 视频片段）。此前脑爆确认的六缺口：首帧图✓、动态 prompt❌、motion❌、时长档位⚠️、尾帧❌、负面提示❌。

wan3.0-video 是百炼（DashScope）系视频模型，与现有 `DASHSCOPE_API_KEY` 同源，凭证零新增。核对官方 API 后实际条件比脑爆时更乐观（时长 2–30 任意整数、支持尾帧、`ratio:adaptive` 自动跟随首帧比例）。

## 一、wan3.0-video 接入方式（官方 API 事实）

### 任务模式：异步任务制（与现有 provider 的单次同步 HTTP 不同）

```
POST {base}/api/v1/services/aigc/video-generation/video-synthesis
     Header: X-DashScope-Async: enable, Authorization: Bearer $DASHSCOPE_API_KEY
  → { output: { task_id, task_status: "PENDING" } }

GET {base}/api/v1/tasks/{task_id}        # 轮询直到终态
  → SUCCEEDED: { output: { video_url }, usage: { duration, fps, SR, ratio } }
```

- 状态枚举：`PENDING / RUNNING / SUCCEEDED / FAILED / CANCELED / UNKNOWN`
- **耗时 1–5 分钟级**（官方示例 720P/5s 跑了 12 分钟）
- **video_url 24 小时失效**，必须及时下载转存（R2）
- task_id 查询有效期 24 小时
- 端点域名：**默认与 TTS 同域名**（speech.ts 的 `maas.qianwenaiapi.com`），即 `https://maas.qianwenaiapi.com/api/v1/services/aigc/video-generation/video-synthesis` 与 `/api/v1/tasks/{task_id}`；`WAN_VIDEO_BASE_URL` env 可覆盖（官方新文档另推 workspace 域名 `{WorkspaceId}.{region}.maas.aliyuncs.com`，留作备用）

### 请求参数（v1 首帧模式相关）

| 参数 | 取值 | 对项目的意义 |
|---|---|---|
| `model` | `wan3.0-video`（标准）/ `wan3.0-video-prime`（高速版） | 默认标准版，env 可切 |
| `input.prompt` | ≤20000 字，中英双语 | 承载动作 + 运镜 + 对白的 camera prompt |
| `input.media` | `[{type:'first_frame', url}]`，url 支持公网 URL / base64 data URI / OSS 临时 URL | 用选定候选帧；R2 私有资产外网不可达 → **base64 内嵌**（≤20MB，生图已在传字节，同款思路） |
| `parameters.resolution` | 480P / 720P / 1080P（默认 1080P） | 调试用 480P 控成本 |
| `parameters.ratio` | `adaptive`（默认）/ 16:9 / 9:16 / … | **adaptive 自动跟随首帧比例**，与 project.aspectRatio 天然对齐 |
| `parameters.duration` | 2–30 任意整数，或 `-1` 智能时长（默认 5） | `clamp(shot.duration, 2, 30)`；MAX_SHOT_DURATION=600 需截断；`-1` 留作 Phase 2 实验 |
| `parameters.audio` | 默认 true（**原生对白/BGM/音效**） | **保持 `true`**——声音由视频模型原生生成：不传入 TTS 音频、不依赖 TTS 管线；对白文本与语气写进 prompt，由模型合成语音（含口型） |
| `parameters.prompt_extend` | 默认 true（LLM 改写 prompt） | 建议 **false**——保护构造好的结构化 camera prompt 原意 |
| `parameters.seed` / `watermark` | 可复现 / 默认无水印 | seed 进快照字段可支持"重-roll 同 seed" |

### 硬约束与坑

- **首帧/尾帧模式与 reference_\* 互斥**：first_frame 不能同时带参考图/音频。对项目无损（首帧已含角色+场景+画风），但堵死了"首帧+角色参考图"的组合
- **无 negative_prompt 参数**：负面约束只能写进 prompt 自然语言（buildShotPrompt 的负面约束行可复用思路）
- 首帧模式**不支持 driving_audio**（wan2.7 支持）；音频驱动需走 reference_image + reference_audio 全模态模式（Phase 3 实验方向）
- 尾帧：`last_frame` 可选（Phase 2 用相邻镜头选定帧做转场精确控制）
- 原生多镜头叙事：文生视频模式支持 30s 多镜头——与"逐镜头生成再拼接"是两条不同路线，v1 不采用

### 成本

官方 API 页未标价（第三方渠道约 $0.05/秒）。以百炼控制台实际计费为准。量级感：5s/720P 镜头约几毛~1 元人民币，30 镜头全片成本可观 → Phase 2 的成本预估 UI 有必要。

## 二、与项目现状的映射

「生成任务四件套」模式已在生图/配音/拆镜上复用三次，**视频是第四次**，全部有现成模板：

| 要新增 | 照抄模板 | 说明 |
|---|---|---|
| `lib/video.ts` provider | `lib/storyboard.ts`（DashScope 同源）+ `speech.ts`（OSS 下载域名白名单、content-length 预检、`redirect:'manual'` SSRF 防御、`fetcher?` 注入） | 差异：内部要加"提交 + 循环轮询 task + 下载转存"三段逻辑 |
| `Shot.video?: ShotVideo` | `ShotAudio`（status/generationId/generationStartedAt + url/duration/sourceXxx 快照） | `isShotAudioStale` 同款 stale 检测 |
| 路由 `/api/projects/:id/generate-video` | `handleGenerateAudio`（waitUntil+202 分支、样例 403、Key 缺失 503、同任务进行中 409、R2 put + assets INSERT） | server.ts 路由正则加一行 |
| 五处登记 | ShotAudio 现成写法逐处对照 | PUT `protectGeneration` 式保护、`rebaseProjectEdits`、`recoverStale`、`validateProject`、`normalizeProject` |
| 配置三处 | storyboard 的 `STORYBOARD_LLM_MODEL/BASE_URL` 模式 | `/api/config` + `client.ts` WorkspaceConfig + 设置弹窗；env：`WAN_VIDEO_MODEL`（默认 wan3.0-video）、`WAN_VIDEO_BASE_URL`（可选覆盖） |
| 前端触发 | `useStudio.generate`/`generateAudio` 同构 | flush → 乐观置 generating → POST → `receiveGenerationAcknowledgement` → 轮询 |
| 测试 | `tests/storyboard.test.ts` / `tests/speech.test.ts` | node --test + 受控 fetcher |

### 两个真正的架构差异（相对现有三次复用）

1. **轮询模式**：视频是分钟级异步任务（官方示例跑 12 分钟，远超 Workers `waitUntil` 挂钟可承受范围）。方案（混合，**懒查询为主**）：
   - `waitUntil` 内以 3–5s 间隔轮询 DashScope task，**约 5 分钟即弃**（不指望它跑完全程）；
   - **前端 GET 懒查询是主恢复机制**：GET project 时发现 video generating 且 task_id 存在、距上次查询 ≥10s（节流）→ 服务端代查一次 DashScope task 状态并写回（worker 重启/waitUntil 死亡均覆盖）；查询失败静默，不阻塞 GET；
   - **视频专用 stale 阈值 20–30 分钟**（现有 10 分钟对视频太短），照 `recoverStoryboardDraft` 模式单独常量；**stale 恢复 failed 前先代查一次 DashScope task**（task_id 24h 可查）——查到 SUCCEEDED 落结果，查不到/确已死才标 failed，避免错杀正在跑或已成功的任务导致用户重复付费。
2. **首帧图可达性**：R2 资产私有（`/api/assets/:uuid` 鉴权读），DashScope 拿不到 → 从 R2 读字节后 **base64 data URI** 内嵌进 `first_frame.url`（官方支持 `data:{MIME};base64,...`，≤20MB）。

## 三、已确认的产品决定

| # | 决定 | 理由 |
|---|---|---|
| 1 | v1 用**首帧模式**（选定候选帧） | 贴合"选定帧"架构；一致性最好（首帧含角色/场景/画风） |
| 2 | `audio:true`（保持默认） | **声音由视频模型原生生成**（对白/BGM/音效）：不传 TTS 音频、不依赖 TTS 管线；dialogue 写进 prompt 供模型合成对白语音 |
| 3 | `ratio:'adaptive'` | 自动跟随首帧比例 = project.aspectRatio |
| 4 | `duration = clamp(shot.duration, 2, 30)` | wan3.0 任意整数档，比预期宽松 |
| 5 | `prompt_extend:false` | 保护结构化 camera prompt 不被 LLM 改写 |
| 6 | 首帧走 **base64 data URI** | R2 私有资产外网不可达 |
| 7 | 轮询走**混合模式**（waitUntil + GET 懒查询 + 视频 stale 20–30min） | 分钟级任务的容灾 |
| 8 | `buildVideoPrompt` 输入 = description（动作语义 + 运镜自然语言）+ **dialogue（对白文本，注明说话人与语气）** + 少量上下文；**首帧已含一切静态信息**，prompt 只写"接下来发生什么" | 与 buildShotPrompt 分工相反：生图 prompt **排除** dialogue（防字幕入画），视频 prompt **包含** dialogue（原生音频需要它生成对白语音）；**v1 不加 motion 字段**，运镜直接用自然语言写进 prompt |

## 四、分阶段路线图

### Phase 1 — MVP：单镜头视频生成

- **数据模型**：`Shot` 加 `video?: ShotVideo`，快照字段照 ShotAudio 模式：`url/duration/status/error/generationId/generationStartedAt` + **变更检测快照** `sourceFirstFrameId`（选定候选帧 id）/`sourceDescription`/`sourceDialogue`/`sourceDuration`/`sourceResolution`——换了选定帧或改了 description/dialogue/duration 即判定视频过期（`isShotVideoStale`，UI 提示重新生成）；`taskId`（DashScope 任务 id，懒查询与 stale 代查用）。（**v1 不加 motion 字段**——运镜用自然语言进 prompt；枚举按钮组留待 Phase 2 视表达力需要再评估）
- **Provider**：`lib/video.ts`（提交任务 / 轮询 task / 下载 video_url 转 R2 + assets 落库，`usage.duration` 回填实际时长）
- **Prompt**：`buildVideoPrompt(project, shot)`（description 动作 + 运镜语言 + **dialogue 对白（说话人/语气，供原生音频生成）** + 负面约束自然语言行）
- **路由**：`/api/projects/:id/generate-video` + 五处登记 + `/api/config` 暴露 configured
- **前端**：镜头详情"生成视频"按钮（须先有选定帧，无则引导先生图）；generating/failed 态；视频过期（isShotVideoStale）提示重新生成；**v1 分辨率固定 720P**（1080P 成本高且无确认 UI 易误触，Phase 2 加选择器）；前端轮询在仅视频 generating 时用 ~10s 间隔（3s 间隔会放大懒查询外呼）；完成后直接播放视频（**原生音轨**）；无视频的镜头维持现状静图+TTS 预览（Preview.tsx 播放端按有无 video.url 分支）
- **不做**：尾帧、批量、action 字段、motion 枚举、导出

### Phase 2 — 成片管线

- **action 字段**（时间性动作描述，与 description 同源分流）；storyboard 拆镜系统提示词同步产出 action 与运镜描述（AI 读全文上下文指定运镜，优于事后规则推导）；**motion 枚举是否引入在此评估**（若自然语言运镜表达力不足，再加按钮组）
- **尾帧**：相邻下一镜头的选定帧作 `last_frame`（转场精确控制；依赖"下一镜头已选定帧"，UI 上做可选开关）
- **批量生成**：一键全量 + 排队（并发上限）+ **成本预估 UI**（时长×单价）
- `duration:-1` 智能时长实验；`usage`（fps/SR/ratio）回填展示
- sceneId 感知转场策略（同场景 cut、跨场景 crossfade）在预览端落地

### Phase 3 — 全模态与导出

- **预览合成**：视频路线下**音画天然同步**（原生音轨内嵌视频），无需 TTS 对齐；TTS 管线保留给静图镜头的现有预览路线（audioLeadIn/audioTailOut 的节奏控制仍适用于该路线），两线并存、按镜头有无 video.url 自动切换
- **导出**：镜头视频 concat + 音轨混音成片
- **reference 全模态实验**：`reference_image`（角色/场景参考图）+ `reference_audio`（音色参考——仅当原生对白音色不可控、需要精确指定声音时再评估）；视频编辑（换风格/改元素）与视频续写（延长镜头）——wan3.0 原生支持，作为"还没有满意首帧"路线的补充
- motion 枚举若不够表达，评估扩充（推轨/环绕/跟随等）

## 五、验证方式（Phase 1 启动时）

1. **Provider 单测**（node --test + fetcher 注入，照 speech/storyboard 范例）：请求体构造（首帧 base64、audio 保持 true、prompt_extend:false、duration clamp）、轮询状态解析（PENDING→RUNNING→SUCCEEDED/FAILED/CANCELED/UNKNOWN）、video_url 域名白名单、坏响应/超时
2. **手动 e2e**：配置 Key → 镜头生图选定帧 → 生成视频（480P/5s 控成本）→ 轮询完成 → R2 落库 → 预览直接播放视频 → stale 恢复（人为中断验证懒查询兜底）；**重点验证原生音频**：对白是否按 prompt 的 dialogue 生成（内容/说话人/语气）、BGM 与音效质量、有无字幕入画（若有则 prompt 加"no subtitles"约束）
3. **回归**：`node --test` 全量 + 现有 PUT/rebase 流不破坏（video 字段五处登记后跑既有测试）

## 六、信息来源

- [Wan3.0 Video Generation API Reference（阿里云官方）](https://help.aliyun.com/en/model-studio/wan3-video-generation-api-reference) — 端点/参数/任务状态/互斥规则/FAQ
- [Wan3.0 Video Generation Guide（阿里云官方）](https://www.alibabacloud.com/help/en/model-studio/wan3-video-generation-guide) — 任务类型触发方式/prompt 指南入口
- 项目代码：`lib/server.ts`（handleGenerateAudio/storyboard 编排）、`lib/storyboard.ts`、`lib/speech.ts`、`lib/generation.ts`、`lib/types.ts`、`components/useStudio.ts`、`components/Storyboard.tsx`
