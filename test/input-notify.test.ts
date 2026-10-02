// input-notify.test.ts — 「正在输入」状态单元回归：续发节奏（假时钟）/ stop 消退 / 失败静默 / 门控
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

/** 假时钟下冲刷微任务：mock fetch 全程微任务即可完成，让 fire() 的链走完 */
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
    inputNotify: { enabled: true, seconds: 10, ...over.inputNotify },
    texts: {},
  }
}

const c2cCtx = (): MessageContext => ({ type: "c2c", userId: "U1", msgId: "MID1", content: "你好" })
const notifyBodies = (): Array<Record<string, unknown>> =>
  apiCalls.filter((c) => c.body?.msg_type === 6).map((c) => c.body)

describe("startInputNotify（假时钟）", () => {
  beforeEach(() => {
    apiCalls = []
    installFetch()
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
    globalThis.fetch = realFetch
  })

  test("立即首发 → 每 0.8×seconds 续发 → stop 后不再续发", async () => {
    const handle = startInputNotify(c2cCtx(), makeConfig())
    await flush()
    expect(notifyBodies()).toHaveLength(1)

    jest.advanceTimersByTime(7999)
    await flush()
    expect(notifyBodies()).toHaveLength(1) // 未满间隔不续发
    jest.advanceTimersByTime(1)
    await flush()
    expect(notifyBodies()).toHaveLength(2) // 8000ms = 10s × 0.8

    jest.advanceTimersByTime(8000)
    await flush()
    expect(notifyBodies()).toHaveLength(3)

    await handle.stop()
    expect(notifyBodies()).toHaveLength(4) // + 终止提示
    jest.advanceTimersByTime(60000)
    await flush()
    expect(notifyBodies()).toHaveLength(4) // 定时器已清，不再续发
  })

  test("所有调用带 msg_id 被动锚定、input_type=1；stop() 发 input_second=1", async () => {
    const handle = startInputNotify(c2cCtx(), makeConfig())
    await flush()
    await handle.stop()
    const bodies = notifyBodies()
    expect(bodies).toHaveLength(2)
    for (const b of bodies) {
      expect(b.msg_id).toBe("MID1") // 带 msg_id 被动锚定：QQ 渲染为纯状态而非 "null" 气泡
      expect(b.input_notify).toMatchObject({ input_type: 1 })
    }
    expect(bodies[0].input_notify).toEqual({ input_type: 1, input_second: 10 })
    expect(bodies[1].input_notify).toEqual({ input_type: 1, input_second: 1 })
  })

  test("stop() 幂等：重复调用不重复发终止提示", async () => {
    const handle = startInputNotify(c2cCtx(), makeConfig())
    await flush()
    await handle.stop()
    await handle.stop()
    expect(notifyBodies()).toHaveLength(2)
  })

  test("发送失败：仅 console.error 一次，stop() 不抛出", async () => {
    installFetch(true)
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      const handle = startInputNotify(c2cCtx(), makeConfig())
      await flush()
      jest.advanceTimersByTime(8000)
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
    jest.advanceTimersByTime(60000)
    await flush()
    expect(apiCalls.filter((c) => c.body?.msg_type === 6)).toHaveLength(0)
  })
})
