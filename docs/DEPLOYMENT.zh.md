# 部署与运维

本文说明如何把 Nightingale 部署为单机生产服务：Docker 镜像，SQLite 存放在数据卷上。安全设计见 [SECURITY.md](./SECURITY.md)，Agent 配置见 [AGENT_DESIGN.md](./AGENT_DESIGN.md) §5。

## 1. 用 Docker Compose 部署（推荐）

在服务器上、仓库根目录新建 `.env`。**不要提交到 git**，镜像构建时也会排除它：

```bash
NIGHTINGALE_SESSION_SECRET=<openssl rand -hex 32 的输出>
NIGHTINGALE_PUBLIC_URL=https://nightingale.example.org
ANTHROPIC_API_KEY=...                     # 或 NIGHTINGALE_AGENT_CLIENT=gemini 加 GEMINI_API_KEY=...
NIGHTINGALE_CRON_SECRET=<openssl rand -hex 24 的输出>   # 可选：外部定时任务触发风险队列
```

构建并启动：

```bash
docker compose up -d --build
```

创建第一个管理员：

```bash
docker compose exec app npm run admin:create -- --email you@example.org --password 'Your-Long-Passphrase-2026' --name "Your Name"
```

检查运行状态：

```bash
curl -s http://localhost:3000/api/health
```

### 容器启动时会做什么

1. **更新表结构：** `prisma db push` 把数据库更新到当前 schema。数据库位于数据卷中的 `/data/nightingale.db`，重建镜像不会丢失。
2. **（可选）写入演示数据：** 仅当 `NIGHTINGALE_SEED_DEMO=true` 时执行，正式环境不要开启。
3. **启动服务：** 启动时先检查配置。生产环境缺少会话密钥（少于 32 个字符）或开启了 `NIGHTINGALE_DEMO_MODE` 时会**拒绝启动**，并在日志中写明原因；其他问题（未设公开地址、没有 LLM 凭据等）只给出警告。
4. **健康检查：** Docker 每 30 秒访问一次 `/api/health`。该接口只返回数据库状态和风险队列计数，不含任何病人信息。

### HTTPS

容器只提供 HTTP（端口 3000）。请在前面放一层 TLS 反向代理（Caddy、Nginx、云负载均衡），并且：

- 设置 `X-Forwarded-For` 和 `X-Forwarded-Host`。按 IP 的限流和同源校验依赖这两个头。
- 对外只使用 HTTPS。生产环境的会话 Cookie 带 `Secure` 标志，经纯 HTTP 访问时浏览器不会发送它。

## 2. 不用 Docker

```bash
npm ci
```

```bash
npx prisma db push && npm run build
```

```bash
NODE_ENV=production NIGHTINGALE_SESSION_SECRET=... DATABASE_URL=file:/var/lib/nightingale/nightingale.db npm start
```

建议用 systemd 或 pm2 托管进程，并设置自动重启。

## 3. 备份与恢复

在线备份，应用无需停机（SQLite `VACUUM INTO`，得到一致且经过压缩的副本）：

```bash
docker compose exec app npm run db:backup -- --dir /data/backups --keep 14
```

建议每天由宿主机的 cron 执行一次，并把 `/data/backups` 同步到异地。恢复步骤：先停止应用，把备份文件复制为 `/data/nightingale.db`，然后重新启动。

## 4. 风险评估队列

- **默认方式：** 每次请求结束后，在同一进程里处理队列（`after()`）。
- **无服务器环境或多实例部署：** 设置 `NIGHTINGALE_RISK_AUTORUN=off`，再由外部定时任务每分钟调用一次：

```bash
curl -s -X POST -H "x-cron-secret: $NIGHTINGALE_CRON_SECRET" https://nightingale.example.org/api/agent/risk/drain
```

- **评估失败：** 自动重试 3 次，期间保留上一次的评估结果。`/api/health` 中的 `riskQueue.failedLastDay` 可用于告警。

## 5. 上线前检查清单

| 项 | 要求 |
| --- | --- |
| 会话密钥 | `NIGHTINGALE_SESSION_SECRET` 至少 32 个字符，只放在 `.env` 或密钥管理系统中 |
| 演示模式 | 不设置 `NIGHTINGALE_DEMO_MODE`，也不设置 `NIGHTINGALE_SEED_DEMO` |
| 公开地址 | 设置 `NIGHTINGALE_PUBLIC_URL`，激活和重置链接会使用这个地址 |
| TLS | 反向代理终止 TLS，并转发 `X-Forwarded-*` 头 |
| LLM | 配置 Anthropic 或 Gemini 凭据。Gemini 免费层不得处理真实病人数据 |
| 备份 | 每日 `db:backup`，异地存放，并实际演练过一次恢复 |
| 监控 | 监控 `/api/health` 的 HTTP 状态和 `failedLastDay` |
| 账户 | 通过 `admin:create` 创建管理员，员工通过邀请链接激活，忘记密码由管理员签发重置链接 |

## 6. 已知限制

- **单实例：** SQLite 与进程内限流器只适用于单实例。多实例部署需要换成 PostgreSQL，并把限流计数放到共享存储（例如 Redis）。
- **账户能力：** 还没有邮件发送（激活和重置链接由管理员转交）、单点登录和多因素认证。
- **CSP：** 内容安全策略仍允许内联脚本，因为 Next.js 的引导数据是内联的。改为基于 nonce 的 CSP 是下一步。
