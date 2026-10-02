// input-notify.test.ts — 「正在输入」状态单元回归：整回合恰好一次 / stop 零请求 / 失败静默 / 门控
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { startInputNotify } from "../src/qq/input-notify.js"
import type { Config } from "../src/config.js"
import type { MessageContext } from "../src/qq/types.js"

const realFetch = globalThis.fetch
let apiCalls: Array<{ url: string; body: Record<string, unknown> }> = []

function installFetch(failNotify = false): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    if (u.includes("getAppAccessToken")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), { status: 200 })
    }
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    apiCalls.push({ url: u, body })
    if (failNotify) return new Response(JSON.stringify({ message: "boom" }), { status: 500 })
    return new Response(JSON.stringify({ id: "mid" }), { status: 200 })
  }) as typeof fetch
}

/** 假时钟下冲刷微任务：mock fetch 全程微任务即可完成，让首发链走完 */
async function flush(ticks = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve()
}

function makeConfig(over: { inputNotify?: Partial<Config["inputNotify"]> } = {}): Config {
  return {
    qq: { appId: "app1", clientSecret: "sec", sandbox: false },
    opencode: { baseUrl: "", externalUrl: false },
    allowedUsers: [],
    maxReplyLength: 3000,
    streaming: { enabled: false, intervalMs: 500, chunkSize: 500, maxScenes: 3 },
    progress: {
      enabled: false,
      max: 0,
      minIntervalMs: 0,
      heartbeatMs: 60 * 1000,
      textMax: 600,
      toolCall: false,
      toolResult: false,
      toolResultMax: 300,
    },
    inputNotify: { enabled: true, seconds: 60, ...over.inputNotify },
    texts: {},
  }
}

const c2cCtx = (): MessageContext => ({ type: "c2c", userId: "U1", msgId: "MID1", content: "你好" })
const notifyBodies = (): Array<Record<string, unknown>> =>
  apiCalls.filter((c) => c.body?.msg_type === 6).map((c) => c.body)

describe("startInputNotify（每回合一次）", () => {
  beforeEach(() => {
    apiCalls = []
    installFetch()
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
    globalThis.fetch = realFetch
  })

  test("整回合恰好一次 input_notify：不续发、stop() 零请求（真机 40034128 修复）", async () => {
    const handle = startInputNotify(c2cCtx(), makeConfig())
    await flush()
    expect(notifyBodies()).toHaveLength(1)

    // 超过 input_second 也不续发：状态自然消失为既定取舍（占位点动画仍在提供视觉反馈）
    jest.advanceTimersByTime(120_000)
    await flush()
    expect(notifyBodies()).toHaveLength(1)

    await handle.stop()
    expect(notifyBodies()).toHaveLength(1) // stop 不发任何请求（含 input_second=1 消退）

    jest.advanceTimersByTime(120_000)
    await flush()
    expect(notifyBodies()).toHaveLength(1)
  })

  test("唯一一次调用带 msg_id 被动锚定、input_type=1、input_second=默认 60", async () => {
    const handle = startInputNotify(c2cCtx(), makeConfig())
    await flush()
    await handle.stop()
    const bodies = notifyBodies()
    expect(bodies).toHaveLength(1)
    expect(bodies[0].msg_id).toBe("MID1") // 带 msg_id 被动锚定：QQ 渲染为纯状态而非 "null" 气泡
    expect(bodies[0].input_notify).toEqual({ input_type: 1, input_second: 60 })
  })

  test("INPUT_NOTIFY_SECONDS 透传自定义时长（钳制由 config 层负责）", async () => {
    const handle = startInputNotify(c2cCtx(), makeConfig({ inputNotify: { seconds: 30 } }))
    await flush()
    await handle.stop()
    expect(notifyBodies()[0].input_notify).toEqual({ input_type: 1, input_second: 30 })
  })

  test("stop() 幂等：重复调用零额外请求", async () => {
    const handle = startInputNotify(c2cCtx(), makeConfig())
    await flush()
    await handle.stop()
    await handle.stop()
    expect(notifyBodies()).toHaveLength(1)
  })

  test("发送失败：仅 console.error 一次，stop() 不抛出", async () => {
    installFetch(true)
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      const handle = startInputNotify(c2cCtx(), makeConfig())
      await flush()
      await handle.stop() // 失败被吞掉
      const errors = errSpy.mock.calls.filter((c) => String(c[0]).includes("[input-notify]"))
      expect(errors).toHaveLength(1) // 防刷屏：只记录一次
    } finally {
      errSpy.mockRestore()
    }
  })

  test("群聊 / INPUT_NOTIFY=off：零调用、零定时器", async () => {
    const groupCtx: MessageContext = { type: "group", userId: "U1", groupId: "G1", msgId: "MID1", content: "你好" }
    await startInputNotify(groupCtx, makeConfig()).stop()
    await startInputNotify(c2cCtx(), makeConfig({ inputNotify: { enabled: false } })).stop()
    jest.advanceTimersByTime(120_000)
    await flush()
    expect(apiCalls.filter((c) => c.body?.msg_type === 6)).toHaveLength(0)
  })
})
