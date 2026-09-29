// @input:  ./config, ./opencode/*, ./qq/*, ./bridge, @opencode-ai/sdk (createOpencodeServer)
// @output: (side-effect) 启动 Bot 进程
// @pos:    根层 - 入口: 启动编排 + 优雅关闭
import { loadConfig, ensureConfig } from "./config.js"
import { createClient, healthCheck, discoverServer } from "./opencode/client.js"
import { EventRouter } from "./opencode/events.js"
import { SessionManager } from "./opencode/sessions.js"
import { startGateway } from "./qq/gateway.js"
import { startBackgroundTokenRefresh, stopBackgroundTokenRefresh } from "./qq/api.js"
import { createBridge } from "./bridge.js"

async function main(): Promise<void> {
  await ensureConfig()
  const config = loadConfig()

  // OpenCode V2：连接本机运行中的服务（URL + 密码自动发现，可用 OPENCODE_BASE_URL/PASSWORD 覆盖）
  const server = await discoverServer()
  console.log(`[index] 连接 OpenCode 服务: ${server.baseUrl}`)

  const client = createClient(server, { directory: config.opencode.workspaceDir })
  await healthCheck(client)

  startBackgroundTokenRefresh(config.qq.appId, config.qq.clientSecret)

  const router = new EventRouter(client, config.opencode.workspaceDir)
  await router.start()

  const sessions = new SessionManager(client, config.opencode.workspaceDir)
  await sessions.resolveDefaultModel()
  const bridge = createBridge(config, client, router, sessions)

  const gateway = await startGateway({
    appId: config.qq.appId,
    clientSecret: config.qq.clientSecret,
    onMessage: bridge.handleMessage,
    onReady: () => {
      console.log("[index] QQ Gateway 已就绪")
    },
  })

  console.log("[index] OpenCode QQ Bot 已启动")

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[index] 收到 ${signal}，开始退出...`)
    gateway.stop()
    router.stop()
    stopBackgroundTokenRefresh()
    setTimeout(() => process.exit(0), 0)
  }

  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))
}

main().catch((error) => {
  console.error("[index] 启动失败:", error)
  stopBackgroundTokenRefresh()
  process.exit(1)
})
