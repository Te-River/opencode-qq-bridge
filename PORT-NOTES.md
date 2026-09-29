# OpenQQ Bridge — OpenCode V2 移植说明

本目录是 `@soulglad/opencode-qq-plugin@0.1.0` 的本地 fork，**已从 V1 SDK 移植到 OpenCode V2 API**，
以便与 OpenCode v2.0.16 协同工作。

## 为什么需要移植

上游依赖 `@opencode-ai/sdk`(V1)，而 V2 变更了 server API：

| | V1（上游） | V2（本 fork） |
|---|---|---|
| API 路径 | `/session`、`/config/providers` | `/api/session`、`/api/model`、`/api/agent` … |
| 鉴权 | 无 | HTTP Basic（`~/.config/opencode/service.json` 的 password） |
| 模型/Agent | `session.prompt` 内联 | `POST /api/session/{id}/model`、`/agent` 单独设置 |
| 消息结构 | `{ info, parts }` | `{ type:"assistant", content:[{type:"text",text}] }` |
| 事件 | `message.part.updated` / `session.idle` | `session.text.delta` / `session.execution.succeeded` 等 |

## 改动一览

- `src/opencode/client.ts`：**重写**为 V2 HTTP 客户端（fetch + Basic 鉴权 + 服务自动发现），
  对外仍暴露近似的 `{ data }` 信封与 `path/query/body` 调用形态。
- `src/opencode/events.ts`：适配 V2 SSE 事件（顶层 `type` + `data`），权限事件改为 `permission.asked`。
- `src/opencode/sessions.ts`：免费读图模型选择改用 `GET /api/model`；`Model.Ref` 使用 `id` 字段。
- `src/bridge.ts`：回复等待改为基于 `session.text.*` + `session.execution.succeeded/failed`；
  权限 auto-ack 改用 `POST /api/session/{id}/permission/{requestID}/reply { decision }`；
  AGENTS.md 检测改用 `/api/fs/list` 的 `path` 字段。
- `src/commands.ts`：模型/Agent 列表、token 统计、会话话题解析改用 V2 结构；`/rename` 会持久化。
- `src/index.ts`：不再自启 V1 server，改为连接本机运行中的 OpenCode 服务。

## 服务发现

启动时按顺序解析要连接的 OpenCode 服务：

1. `OPENCODE_BASE_URL`（可选）与 `OPENCODE_PASSWORD`（可选）环境变量；
2. 否则执行 `opencode service status` 取 URL，从 `~/.config/opencode/service.json` 取 password。

> 注意：OpenCode 后台服务端口是动态的，若执行过 `opencode service restart` 导致端口变化，
> 需重启本桥以重新发现地址。

## 配置

`~/.openqq/.env`：

```
QQ_APP_ID=...
QQ_APP_SECRET=...
QQ_SANDBOX=false
# OPENCODE_BASE_URL=http://127.0.0.1:4096
# OPENCODE_PASSWORD=...
ALLOWED_USERS=
MAX_REPLY_LENGTH=3000
```

## 运行

```bash
openqq                 # 全局命令（~/.bun/bin/openqq 包装脚本）
# 或
cd ~/.openqq && bun run src/index.ts
```

## 依赖

Bun >= 1.0；`ws`（QQ Gateway）。已移除 `@opencode-ai/sdk` 依赖。

## 中间进度与超时（可配置）

默认会在处理过程中向 QQ 输出关键中间信息（走**主动消息**，不占用被动回复次数）：

- `🔧 调用工具：<name>`：模型调用工具时（如 shell / read / edit）
- `📄 <name> 返回：<摘要>`：工具执行完成时的返回摘要（截断）
- `❌ 工具失败：<原因>`：工具执行失败时
- `💬 <说明>`：模型在工具之间的「中间说明文字」（非最终答复）
- `⏳ 仍在处理中（已用 X 分 Y 秒）…`：长时间无输出时的心跳

> 关键节点策略：每个文字段落若后面还有新的文字段落，说明它不是最终答复，就作为 `💬` 中间说明发出；
> 最后一段文字作为最终结果。这样既不刷屏思考过程，又能看到关键节点。

超时改为**基于"无活动"**：只要有事件（文本/工具/步骤）就会持续续期，
默认连续 **10 分钟无任何输出**才判超时；另有 60 分钟绝对上限兜底。

可通过 `~/.openqq/.env` 调整：

| 变量 | 默认 | 说明 |
|------|------|------|
| `PROGRESS` | `on` | 是否输出中间进度 |
| `PROGRESS_MAX` | `0` | 最多几条进度，`0` = 不限 |
| `PROGRESS_MIN_INTERVAL_MS` | `1200` | 进度消息最小间隔，防刷屏/限频 |
| `PROGRESS_HEARTBEAT_MS` | `60000` | 无输出时的心跳间隔 |
| `PROGRESS_TEXT_MAX` | `600` | 中间说明文字单条截断长度 |
| `PROGRESS_TOOL_RESULT` | `on` | 是否输出工具返回摘要 |
| `PROGRESS_TOOL_RESULT_MAX` | `300` | 工具返回摘要截断长度 |
| `RESPONSE_IDLE_TIMEOUT_MS` | `600000` | 无活动多久判超时 |
| `RESPONSE_MAX_MS` | `3600000` | 单次处理绝对上限 |

> 最终结果仍使用被动回复（与被提问消息关联）；进度用主动消息，二者独立。

## 图片 / 文件附件

支持 QQ 发来的图片和文件：桥会下载附件 → 转成 data URI / 落盘 → 交给 OpenCode。

- **图片**：内联为 data URI，由支持视觉的模型识别。
- **文本类文件**（.txt/.md/.csv/.json/.py/.js/.ts/…）：内联为 data URI，OpenCode 直接把内容作为上下文。
- **二进制文件**（.sqlite/.pdf/.docx/.zip/…）：**保存到磁盘**，并在提示里附带路径，由 AI **用工具**处理。
  - 例：`~/.openqq/attachments/<ts>-<rand>-<name>`
  - `.sqlite`：机器有 `python3`（含 `sqlite3` 模块，`sqlite3` CLI 未安装），AI 可用
    `python3 -c "import sqlite3; ..."` 读取表结构/数据。
- **MIME 推断**：QQ 对文件给的 `content_type` 常是 `"file"`（非法 MIME），桥按扩展名推断正确 MIME。
  `.sqlite/.sqlite3/.db` → `application/vnd.sqlite3`。
- **体积上限**：`ATTACHMENT_MAX_BYTES`（默认 25MB），超过则跳过并提示。
- 每个附件都会在用户消息末尾追加一行 `[附件] <名称>（<mime>）已保存到：<路径>`，便于 AI 按需读取。

> 说明：OpenCode V2 的附件 `uri` 只接受 `data:` 或 `file://`，不接受裸路径；二进制文件走"落盘 + 提示路径"路线。

## 机器人主动发文件给用户

支持把本机文件发回给 QQ 用户（zip / 任意文件 / 图片 / 视频 / 语音）。

**触发约定**：AI 在回复中单独一行写标记
```
[[sendfile:/绝对路径]]
```
桥会：把标记从文本中剔除、上传富媒体（`POST /v2/users|groups/{id}/files`）、
再以 `msg_type=7` 发送给用户（作为被动回复关联原消息）。

- 支持一次多个（多行多个标记）。
- 也接受 `file:///path` 形式。
- 类型按扩展名自动判定：图片=1 / 视频=2 / 语音=3 / 其它=4（文件）。
- 体积上限 `SEND_FILE_MAX_BYTES`（默认 100MB）；失败会在最终文本里附加 `⚠ 文件发送失败：…`。
- 桥会在用户消息末尾注入一句 `[系统提示] … [[sendfile:/绝对路径]]`，让模型知道该约定（`SEND_FILE_HINT=off` 可关闭）。

> 示例：用户"把当前目录打包成 zip 发我" → AI 执行 `zip -r /tmp/xx.zip .` →
> 回复中写 `[[sendfile:/tmp/xx.zip]]` → 桥把 zip 发给该用户。

## 后台任务（长命令自动转后台）

OpenCode 会把耗时较长的 shell 命令**移到后台**（工具返回 `Command moved to the background (shell ID: sh_…)`），
本轮随即结束；当后台命令完成时，OpenCode 会自动让 AI **继续输出**（新的一轮执行）。

**修复**：一轮结束后，桥会为该会话启动一个**后台监视器**：

- 识别到后台 shell 时，持续发送心跳 `⏳ 后台任务仍在进行（已用 X 分 Y 秒）…`（每 60 秒）；
- 自动继续执行时发送 `🔧 调用工具` / `💬` 等关键节点；
- 该轮结束时，把结果作为**主动消息**转发给用户；
- 用户下次发消息时自动停止旧监视器；监视器最长存活 `MONITOR_MAX_MS`（默认 2 小时）。

| 变量 | 默认 | 说明 |
|------|------|------|
| `MONITOR` | `on` | 是否启用后台监视器 |
| `MONITOR_MAX_MS` | `7200000` | 监视器最长存活时长 |

## 模型 / Agent 跨会话沿用

模型与 Agent 的绑定**跟随用户**，不随新建会话重置：

- 用户 `/model` 或 `/agent` 切换后，再 `/new` 建新会话，仍沿用上一次的模型/Agent。
- **只有用户主动切换才会改变**；不主动切换则始终不变（含机器人重启后从 `state.json` 恢复）。
- 从未绑定过的新用户，才使用兜底模型（免费读图模型，`resolveFreeVisionModel`）。

## Markdown 渲染

所有**文本消息**（最终回复、进度、命令回复、心跳、后台转发）都走 QQ **原生 markdown**（`msg_type: 2` + `markdown.content`），
agent 生成的标题/粗体/列表/代码块/引用等格式会原样呈现。

- 不再把 markdown 降级为纯文本（原 `formatForQQ` 仅在回退时使用）。
- 发送 markdown 失败时（如权限/格式问题）**自动回退为纯文本**重发，不会丢消息。
- 文件/图片（富媒体，`msg_type: 7`）不受影响。
- 开关：`MARKDOWN=off` 可关闭。

| 变量 | 默认 | 说明 |
|------|------|------|
| `MARKDOWN` | `on` | 文本消息是否使用原生 markdown |

## 已知问题修复（会话误绑）

**现象**：`/sessions` 会列出项目内**所有**会话（包括人类在 TUI 里正在用的会话）。
若选中了人类会话，机器人会把消息注入其中，并因为轮询兜底返回该会话「上一轮的助手回复」，
看起来像答非所问；首次回复后还会自动推送一次 help 菜单。

**修复**：
1. 机器人创建会话时写入 `metadata.openqq.owner = <QQ用户ID>` 作为归属标记。
2. `/sessions` 只列出 `owner` 等于当前用户的本机器人会话，杜绝误绑人类会话。
3. 轮询兜底只接受 `time.created >= 本次提问时刻` 的助手消息，不再把旧回复当结果。
4. 移除首次回复后自动推送的 help 菜单（需要帮助用 `/help`）。
5. 若曾误绑，删除 `~/.openqq/state.json` 并重启服务即可重新生成归属会话。