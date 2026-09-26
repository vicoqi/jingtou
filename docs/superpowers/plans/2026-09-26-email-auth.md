# 邮箱账号与数据隔离实现计划

**目标：** 支持邮箱、密码注册登录，无需邮箱验证；作品、角色、场景、上传和生成图片均归当前账号。

**架构：** 沿用 Worker + D1 + R2。D1 保存账号、加盐密码哈希和有期限的会话；浏览器使用 HttpOnly Cookie。服务端从会话取得用户 ID，替换原共享身份。登录页面作为工作台的入口，退出前保存正在编辑的作品。

**约束：** 仅本地运行，不推送或部署；不发送验证邮件；不自动认领旧共享数据；不调用付费生图接口进行测试。

## 1. 认证与隔离

涉及 `lib/auth.ts`、`lib/http.ts`、`lib/server.ts`、`lib/types.ts`、`db/schema.ts`、`drizzle/`、`vite.config.ts`、`worker/index.ts`。

- [x] 先添加 `tests/auth.test.ts` 和实际 SQLite 测试适配器，运行并确认注册和匿名拒绝测试失败。
- [x] 实现 `POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`；返回公开用户 `{id,email}`。
- [x] 邮箱去空格并转小写、唯一约束；密码 8–128 字符，scrypt 加随机盐；错误登录提示统一；数据库限制同邮箱连续尝试。
- [x] 随机会话令牌仅放在 Cookie，数据库只保存摘要；30 天到期，退出即吊销；HTTPS 使用 Secure，局域网 HTTP 保持可用。
- [x] 对写入请求检查来源；所有作品和素材接口要求有效会话，用户 ID 只由服务端决定。图片禁止缓存，防止同浏览器切换账号复用私有内容。
- [x] 移除 localhost、局域网标志和客户端身份头的登录绕过；改造原有服务端测试，使用真实注册会话。
- [x] 生成并检查 Drizzle 迁移，运行 `npm test`、`npm run typecheck`。

## 2. 登录界面与会话生命周期

涉及 `components/AuthGate.tsx`、`components/Studio.tsx`、`lib/client.ts`、`app/page.tsx`、`app/globals.css`。

- [x] 添加邮箱密码登录、注册模式和注册确认密码；错误反馈、提交状态、输入标签和浏览器自动填充。
- [x] 首次加载恢复会话，登录成功挂载工作台；用户邮箱显示在侧边栏。
- [x] 退出前等待 `studio.flush()`，成功后注销会话并清除当前界面；失败保留作品和错误提示。
- [x] 收到 401 时返回登录页；跨标签页同步账号变更，并在重新聚焦时校验会话；用用户 ID 重建工作台状态。
- [x] 使用 `X-Jingtou-User` 校验请求的预期账号，防止另一个标签页切换会话时旧工作台继续操作。

## 3. 旧数据与验收

涉及 `scripts/migrate-local-owner.mjs`、`tests/local-migration.test.ts`、`tests/http-smoke.mjs`、`README.md`。

- [x] 提供本地管理员迁移命令：指定已注册邮箱，默认只预览；`--apply` 前备份 SQLite，并在单个事务中同时迁移作品和素材，保留所有 ID 与内容。
- [x] 验证不存在的账号不能接收数据、默认不修改、迁移仅影响 `local-development`、重复执行无副作用。
- [x] HTTP 验收使用两个独立 Cookie 会话，验证注册、退出、重登、作品/图片/角色/场景隔离、原样例只读和原制作流程。
- [x] 文档说明登录、存储位置、迁移方式和暂不验证邮箱。
- [x] 最终运行 `npm test`、`npm run typecheck`、`npm run lint`、`npm run build`、`npm run test:integration`、`git diff --check`。
- [x] 留下可用的局域网开发服务，保存本地提交。

密码参数参考：[OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)；运行时支持参考：[Cloudflare node:crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)。

## 验收记录

76 项自动化测试通过；类型检查、Lint、生产构建、HTTP 双账号隔离及制作流程验收通过。独立审查未发现未解决的重要问题。旧共享数据保留，接收邮箱尚未指定，未执行实际迁移。跨标签页和焦点恢复经过代码审查及客户端请求隔离测试，未执行浏览器点击验收。
