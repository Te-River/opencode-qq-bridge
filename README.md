# opencode-qq-plugin（OpenCode QQ Bot）

通过 QQ 机器人与 OpenCode AI 编程助手对话。

> **本项目基于 [gbwssve/opencode-qq-bot](https://github.com/gbwssve/opencode-qq-bot)（MIT）fork 改造**，
> 在原项目"能用"的基础上做了大量"好用"级增强，详见下文「增强功能」。
> 上游许可证为 MIT（README 声明，见 `LICENSE`）。

---

## 增强功能（vs 上游）

原项目实现了 QQ ↔ OpenCode 的基础对话链路；本 fork 在真实 NAS 环境中长期运行后，
围绕「手机 QQ 场景的可靠性」做了以下增强：

### 1. 图片消息支持
- **QQ 发图 → OpenCode 识图**：桥侧自动下载图片转 data URI 后传给 opencode
- 上游踩坑点已解决：opencode `file` part 只接受 data URI，不接受远程 URL

### 2. 消息队列（不再丢消息）
- 上游：同一用户处理中收到新消息直接拒绝「上一条还在处理」
- 本版：**per-user 队列**，新消息入队，回复「排第 N 位」，处理完自动继续

### 3. 权限 auto-ack（解决 ask 悬空死锁）
- 上游：opencode 触发权限询问（ask）时，QQ 无法交互应答 → 会话卡死 5 分钟超时
- 本版：桥监听 `permission.updated` 事件，按规则**自动回复**：
  - `bash` 命令 → allow
  - 工作区内 read/edit → allow
  - 外部目录 → reject
- 手机 QQ 场景下权限询问不再悬空

### 4. 状态感知 + 续消息（解决超时误判）
- 上游：固定 5 分钟超时，AI 处理中用户完全不知道进展
- 本版：
  - 收到 AI 输出 → 自动续期活动时间
  - 超时前每 30s **轮询服务端拉取结果**（事件丢失兜底）
  - 间隔 60s 向 QQ 发送「AI 正在处理，请稍候…」
  - **即使 SSE 事件丢失，也能兜底拉回已完成的结果**

### 5. `/kill` 命令
- 终止当前 AI 处理 + 清空排队消息，避免卡死对话

### 6. 模型切换 / token 统计
- `/model` 模型列表 + 切换
- `/cache` 查看 token/上下文占用，超阈值提示 `/compact` 或 `/new`

---

## 功能特性（继承上游）

- **QQ 群聊 + 私聊** - @机器人 或直接私信，两种方式都支持
- **内嵌 OpenCode** - 自动启动 opencode serve，无需手动管理进程
- **会话管理** - 每用户独立会话，支持新建、切换、重命名
- **命令系统** - 覆盖常用操作（见下方命令列表）

---

## 命令列表

| 命令 | 功能 |
|------|------|
| `/new` | 创建新会话 |
| `/stop` | 停止当前 AI 运行 |
| `/kill` | 终止 AI 处理 + 清空排队消息（增强） |
| `/status` | 查看服务器和当前会话状态 |
| `/sessions` | 列出历史会话，回复序号切换 |
| `/help` | 查看帮助 |
| `/model` | 列出可用模型，回复序号切换 |
| `/model <provider/model>` | 直接切换到指定模型 |
| `/agent` | 列出可用 Agent |
| `/agent <name>` | 切换 Agent |
| `/rename <name>` | 重命名当前会话 |
| `/cache` | 查看 token/上下文统计（增强） |
| `/compact` | 压缩会话（调用 opencode summarize） |
| 其他 `/命令` | **透传**给 opencode 原生执行（如 `/init`、`/review` 等） |

**透传命令**：未识别的 `/xxx` 会透传给 opencode 的 `session.command` 原生执行，返回结果摘要。opencode 支持的 slash 命令都能在 QQ 里用。

---

## 快速开始

### 前置条件

- [Bun](https://bun.sh) >= 1.0
- [OpenCode](https://opencode.ai) 已安装
- QQ 机器人的 AppID 和 AppSecret

### 启动

```bash
bun install
bun run src/index.ts
```

首次运行会自动引导你填写 QQ 机器人凭证（保存在 `~/.openqq/.env`）。

### 连接外部 OpenCode

```bash
# 方式 1: 环境变量
OPENCODE_BASE_URL=http://localhost:4096 openqq

# 方式 2: 写入 ~/.openqq/.env
echo "OPENCODE_BASE_URL=http://localhost:4096" >> ~/.openqq/.env
```

### 图片消息（QQ 发图 → opencode 识图）

桥侧自动下载 QQ 图片 → 转 data URI → 作为 `file` part 传给 opencode。

> **桥（Node 服务端）连 opencode 不受 Secure Context 限制**：`crypto.subtle` 在 Node 运行时始终可用。桥的 `OPENCODE_BASE_URL` 指向 **`http://localhost:4096` 即可正常处理图片**（实测通过）。
>
> **Secure Context 限制只影响 Web UI（浏览器）**：opencode 处理图片附件在浏览器端用 `crypto.subtle.digest("SHA-256", …)` 算哈希，浏览器要求 HTTPS 或 localhost。若 Web UI 被**其他设备**通过局域网 IP 明文 HTTP（`http://192.168.x.x:4096`）访问，非 secure context → `crypto.subtle` 为 `undefined` → 报 `Cannot read properties of undefined (reading 'digest')`，图片失败。
>
> **结论**：桥连本机 `localhost` 就够，无需 HTTPS。HTTPS 反代（如下）主要是让 **Web UI 能被跨设备访问**时图片也能用。
>
> 另：opencode 的 `file` part **只接受 data URI（base64 内联），不接受远程 URL**（QQ 直链或公网 URL 都返回 `BadRequest`），桥的 `downloadToDataUri()` 解决此事。

### 生产建议：opencode 挂 HTTPS（nginx）

主要解决两个场景（与桥的图片链路无关）：
1. **Web UI 跨设备访问**（浏览器 Secure Context，图片可用）
2. **SSE 长连接被反代缓冲/超时**（`proxy_buffering off`）

```bash
# .openqq/.env
OPENCODE_BASE_URL=https://127.0.0.1:8888
```

nginx 配套：
- 关 SSE 缓冲：`proxy_buffering off`、`proxy_cache off`
- 长连接超时：`proxy_read_timeout` / `proxy_send_timeout` ≥ 数分钟
- 证书 hostname 不匹配时（IP 直连），桥容器设 `NODE_TLS_REJECT_UNAUTHORIZED=0`

---

## 配置说明

所有配置通过环境变量或 `~/.openqq/.env` 文件管理：

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `QQ_APP_ID` | 是 | - | QQ 机器人 AppID |
| `QQ_APP_SECRET` | 是 | - | QQ 机器人 AppSecret |
| `QQ_SANDBOX` | 否 | `false` | 是否使用沙箱环境 |
| `OPENCODE_BASE_URL` | 否 | (自动启动) | 外部 opencode serve 地址 |
| `OPENCODE_WORKSPACE` | 否 | - | OpenCode 工作区目录（按 directory 过滤事件） |
| `OPENCODE_DEFAULT_MODEL` | 否 | (自动选) | 默认模型；**留空时自动选免费+支持读图的模型** |
| `ALLOWED_USERS` | 否 | (不限制) | 允许使用的 QQ 用户 ID，逗号分隔 |
| `MAX_REPLY_LENGTH` | 否 | `3000` | 单条回复最大字符数 |

### 会话/模型绑定持久化（`~/.openqq/state.json`）

**静态配置在 `.env`，动态绑定在 `state.json`**（运行时读写，两者分离）：

- `state.json` 记录每个 QQ 用户的 **session 绑定 + 模型绑定 + agent 绑定**
- **重启桥不丢失**：启动时自动恢复会话和模型
- 模型绑定在 `/model` 切换后写入，重启后继续用上次选的模型

### 默认模型自动选择

- `OPENCODE_DEFAULT_MODEL` 留空时，启动自动扫描 opencode providers：
  - 选 **免费（cost=0）+ 支持图片附件（capabilities.attachment + input.image）** 的模型
  - 优先 `opencode/*` 提供商（避免订阅套餐模型）
  - 当前命中：`opencode/mimo-v2.5-free`（免费 + 支持读图）
- 之后可随时 `/model` 切换并持久化

---

## 工作原理

```
QQ 用户发消息
     |
     v
QQ Gateway (WebSocket)
     |
     v
Bridge 桥接层
     +---> /命令 ---> 命令处理 ---> 回复
     +---> 普通消息 ---> 队列排队 ---> OpenCode SDK prompt()
                                     |
                                     v
                             SSE 事件流 + 30s 轮询兜底
                                     |
                                     v
                          session.idle / 轮询拉取 ---> 回复 QQ
```

- 消息**队列化**：同用户消息排队处理，不丢弃
- **权限 auto-ack**：permission.updated 事件自动回复，杜绝 ask 悬空
- 全局一个 SSE 连接，EventRouter 按 sessionId 分发
- **事件 + 轮询双通道**：SSE 丢失时轮询兜底拉回结果

---

## 致谢

- [OpenCode](https://opencode.ai) - AI 编程助手
- [gbwssve/opencode-qq-bot](https://github.com/gbwssve/opencode-qq-bot) - 上游项目（MIT）
- [sliverp/qqbot](https://github.com/sliverp/qqbot) - QQ Bot API 封装参考
- [grinev/opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot) - 架构参考

## License

MIT
