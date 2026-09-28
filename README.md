# 镜头 JINGTOU STUDIO

面向个人创作者的动漫短剧制作工作台，覆盖角色设定、场景生成、分镜编排、AI 生图、配音和成片预览。

## 功能介绍

- 使用邮箱注册和登录，每个账号独立保存作品、角色、场景及素材。
- 创建角色并维护外观描述、男女音色和多张参考图，支持上传或 AI 生成角色参考图。
- 创建可复用场景，选择预设风格或填写自定义风格，生成并选定场景参考图。
- 编辑、排序和删除分镜，设置出场角色、说话角色、场景、画面描述、对白和时长。
- 使用兼容 OpenAI Images API 的服务生成候选图，支持历史保留、放大比较、重新生成和选图。
- 使用阿里云百炼 `qwen3-tts-instruct-flash` 生成角色配音，支持为每个镜头描述语气、语速和情绪；失败时保留上一版音频。
- 多个镜头可同时生成画面或配音，生成期间可以继续编辑其他镜头。
- 按分镜顺序和时长预览选定画面与配音，支持播放、暂停、拖动和镜头跳转。
- 自动保存制作进度；内置样例只读，可复制为个人作品继续编辑。

## 启动与部署

需要 Node.js 22.13 或更高版本，推荐 Node.js 24。

### 本地开发

```bash
git clone https://github.com/vicoqi/jingtou.git
cd jingtou
npm ci
cp .env.example .dev.vars
npm run dev
```

打开终端输出的 Local 地址，默认是 `http://localhost:3000`。账号、作品和素材保存在本地 `.wrangler/` 目录。

局域网访问使用：

```bash
npm run dev:lan
```

同一局域网内的设备打开终端输出的 Network 地址。

### 生成服务配置

在 `.dev.vars` 中填写服务端密钥：

```dotenv
IMAGE_API_KEY=你的生图服务密钥
IMAGE_API_BASE_URL=https://new-nocf.97api.com/v1
IMAGE_MODEL=gpt-image-2

DASHSCOPE_API_KEY=你的阿里云百炼密钥
QWEN_TTS_MODEL=qwen3-tts-instruct-flash
QWEN_TTS_FEMALE_VOICE=Momo
QWEN_TTS_MALE_VOICE=Moon
```

保存配置后重新启动服务。不要提交 `.dev.vars`、`.env` 或 `.wrangler/`。

### 本地生产模式

```bash
npm ci
npm run build
npm run start
```

### 云端部署

项目输出为 Cloudflare Worker 兼容应用，部署环境需要：

- Node.js 22.13 或更高版本。
- D1 数据库绑定 `DB`。
- R2 存储桶绑定 `ASSETS_BUCKET`。
- 配置上述生图与配音环境变量。
- 应用 `drizzle/` 目录中的数据库迁移。

仓库中的 `.openai/hosting.json` 已声明部署项目及 D1/R2 逻辑绑定，可用于从 GitHub 仓库部署到 OpenAI Sites。构建命令为 `npm run build`。

完整的接口、数据、安全和测试说明保存在 [docs/README.md](docs/README.md)。
