// sender.test.ts — StreamSession 状态机：首片/场景切换/节流/错误恢复/收尾/sendfile 标记剥离
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { StreamSession, type StreamSessionOptions } from "../src/qq/sender.js"
import { renderCopy } from "../src/copy.js"
import type { MessageContext } from "../src/qq/types.js"

const realFetch = globalThis.fetch

// ---- 测试基建 -------------------------------------------------------------

function c2cCtx(): MessageContext {
  return { type: "c2c", userId: "U1", msgId: "MID1", content: "hi" }
}

interface ShardBody {
  content_raw: string
  index: number
  input_mode: string
  input_state: number
  content_type: string
  msg_seq: number
  msg_id?: string
  stream_msg_id?: string
}

interface Recorded {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  ok: boolean
}

/** fetch 记录器：可选按请求体注入失败响应（返回 Response 即失败） */
function makeRecorder(fail?: (body: Record<string, unknown>) => Response | undefined) {
  const calls: Recorded[] = []
  let n = 0
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    n += 1
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    const failed = fail?.(body)
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body, ok: !failed })
    if (failed) return failed
    return new Response(JSON.stringify({ id: `id-${n}`, timestamp: 1 }), { status: 200 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

function shards(calls: Recorded[]): ShardBody[] {
  return calls.filter((c) => c.body.content_raw !== undefined).map((c) => c.body as unknown as ShardBody)
}

/** 仅统计成功下发的分片内容（失败尝试不计入） */
function sentText(calls: Recorded[]): string {
  return calls
    .filter((c) => c.ok && c.body.content_raw !== undefined)
    .map((c) => c.body.content_raw as string)
    .join("")
}

/** 自动推进假时钟：每次 now() 调用前进 step ⇒ throttle 计算出的等待恒 ≤ 0，零真实 sleep */
function autoClock(step: number): () => number {
  let t = 1_000_000
  return () => (t += step)
}

function baseOpts(
  fetchImpl: typeof fetch,
  now: () => number,
  over: Partial<StreamSessionOptions> = {},
): StreamSessionOptions {
  return {
    token: async () => "tok",
    ctx: c2cCtx(),
    render: (scene, vars) => renderCopy(scene, vars),
    intervalMs: 1500,
    chunkSize: 500,
    maxScenes: 3,
    fetchImpl,
    now,
    ...over,
  }
}

/** 同一条流内所有分片 msg_seq 必须恒定（官方文档语义） */
function expectMsgSeqConstantPerStream(list: ShardBody[]): void {
  let current: number | null = null
  for (const s of list) {
    if (s.msg_id !== undefined) current = s.msg_seq // 新流首片
    expect(s.msg_seq).toBe(current)
  }
}

const A40 = "A".repeat(40)
const B40 = "B".repeat(40)
const C40 = "C".repeat(40)

// 会话登记：afterEach 兜底 abort，避免 dots timer 泄漏到其他用例
const live: StreamSession[] = []
function track<T extends StreamSession>(s: T): T {
  live.push(s)
  return s
}

afterEach(async () => {
  for (const s of live) {
    try {
      await s.abort()
    } catch {
      // ignore
    }
  }
  live.length = 0
  globalThis.fetch = realFetch
})

// ---- 首片与场景切换 -------------------------------------------------------

describe("StreamSession.start", () => {
  test("发 WAITING 首片：index0/state1/replace/msg_id 被动锚定", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    expect(s.state).toBe("streaming")
    const list = shards(calls)
    expect(list).toHaveLength(1)
    expect(list[0].content_raw).toBe("请等待中")
    expect(list[0].index).toBe(0)
    expect(list[0].input_mode).toBe("replace")
    expect(list[0].input_state).toBe(1)
    expect(list[0].content_type).toBe("text")
    expect(list[0].msg_id).toBe("MID1")
    expect(list[0].stream_msg_id).toBeUndefined()
    expect(typeof list[0].msg_seq).toBe("number")
    expect(calls[0].url).toBe("https://api.sgroup.qq.com/v2/users/U1/stream_messages")
    expect(calls[0].headers.Authorization).toBe("QQBot tok")
  })
})

describe("StreamSession.switchScene", () => {
  test("旧流收到 state10 终片，新流 index 重置 0 且首片为场景文案", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.switchScene("TOOL_CALL", { tool: "bash" })
    const list = shards(calls)
    expect(list).toHaveLength(3)
    // 旧流终片
    expect(list[1]).toMatchObject({
      content_raw: "",
      index: 1,
      input_mode: "append",
      input_state: 10,
      stream_msg_id: "id-1",
    })
    // 新流首片
    expect(list[2]).toMatchObject({
      content_raw: "🔧 调用工具：bash",
      index: 0,
      input_mode: "replace",
      input_state: 1,
      msg_id: "MID1",
    })
    expectMsgSeqConstantPerStream(list)
    expect(s.state).toBe("streaming")
  })

  test("占位流预算用尽（含 WAITING ≥ maxScenes）时改走主动消息", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const proactive: Recorded[] = []
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      proactive.push({ url: String(url), headers: {}, body })
      return new Response(JSON.stringify({ id: "p1", timestamp: 1 }), { status: 200 })
    }) as typeof fetch
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500), { maxScenes: 1 })))
    await s.start() // WAITING，占位流 1/1
    await s.switchScene("TOOL_CALL", { tool: "bash" })
    // 无新增 stream 分片
    expect(shards(calls)).toHaveLength(1)
    // 走 /v2/users/{openid}/messages 主动消息（非 stream_messages）
    expect(proactive).toHaveLength(1)
    expect(proactive[0].url).toBe("https://api.sgroup.qq.com/v2/users/U1/messages")
    expect(proactive[0].body.msg_id).toBeUndefined()
    expect((proactive[0].body.markdown as { content: string }).content).toBe("🔧 调用工具：bash")
    expect(s.state).toBe("streaming")
  })

  test("正文流进行中 switchScene(TEXT) 重置正文流：终片 + deliveredBody 清零 + 下段 index0", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A40)
    await s.switchScene("TEXT", { snippet: "x" })
    expect(s.deliveredBody).toBe("")
    let list = shards(calls)
    expect(list[3]).toMatchObject({ input_mode: "append", input_state: 10, stream_msg_id: "id-3" })
    // 下一段正文另起新流
    await s.pushBody(B40)
    list = shards(calls)
    expect(list[4]).toMatchObject({
      content_raw: B40,
      index: 0,
      input_mode: "replace",
      input_state: 1,
      msg_id: "MID1",
    })
    expect(s.deliveredBody).toBe(B40)
  })

  test("正文流进行中其他场景走主动消息且不打断正文流", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const proactive: Recorded[] = []
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      proactive.push({ url: String(url), headers: {}, body })
      return new Response(JSON.stringify({ id: "p1", timestamp: 1 }), { status: 200 })
    }) as typeof fetch
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A40)
    await s.switchScene("TOOL_CALL", { tool: "t" })
    expect(proactive).toHaveLength(1)
    expect(proactive[0].url).toBe("https://api.sgroup.qq.com/v2/users/U1/messages")
    // 正文流未关闭：仍只有 WAITING open/close + body open 三片
    expect(shards(calls)).toHaveLength(3)
    // 后续正文继续 append 到原正文流
    await s.pushBody(B40)
    const list = shards(calls)
    expect(list[3]).toMatchObject({ content_raw: B40, input_mode: "append", index: 1, stream_msg_id: "id-3" })
  })
})

// ---- 节流与缓冲 -----------------------------------------------------------

describe("StreamSession.pushBody 节流", () => {
  test("冻结时钟（未越过 intervalMs 窗口）时真实等待 intervalMs", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const frozen = () => 5_000_000
    const s = track(new StreamSession(baseOpts(fetchImpl, frozen, { intervalMs: 400 })))
    await s.start() // 首片不等待（lastSendAt=-Infinity）
    const t0 = Date.now()
    await s.pushBody(A40) // close + open 两次发送，各等待 400ms
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(700) // 2×400ms − 容差
    expect(shards(calls).length).toBeGreaterThanOrEqual(3)
  })

  test("假时钟推进越过 intervalMs 窗口后零真实等待", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(400), { intervalMs: 400 })))
    await s.start()
    const t0 = Date.now()
    await s.pushBody(A40)
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(300) // 若仍等待应为 ~800ms
    expect(shards(calls)).toHaveLength(3)
  })

  test("minFlushChars：缓冲不足 24 字符不开正文流，补足后开流", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody("a".repeat(23))
    expect(shards(calls)).toHaveLength(1) // 仅 WAITING 首片
    await s.pushBody("b") // 累计 24
    const list = shards(calls)
    expect(list).toHaveLength(3) // WAITING close + 正文 open
    expect(list[2].content_raw).toBe("a".repeat(23) + "b")
    expect(list[2].input_mode).toBe("replace")
  })
})

// ---- 错误恢复 -------------------------------------------------------------

describe("StreamSession 错误恢复", () => {
  test("40007 前缀冲突 → 另起新流（首片 replace 全文，后续走新流）", async () => {
    let failedOnce = false
    const { calls, fetchImpl } = makeRecorder((body) => {
      if (
        !failedOnce &&
        body.input_mode === "append" &&
        body.input_state === 1 &&
        body.index >= 1 &&
        body.stream_msg_id
      ) {
        failedOnce = true
        return new Response(JSON.stringify({ code: 40007, message: "prefix conflict" }), { status: 400 })
      }
      return undefined
    })
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A40)
    await s.pushBody(B40) // append 撞 40007 → 另起新流
    let list = shards(calls)
    // 新流首片 = 已下发 + 缓冲 全文（replace/index0/msg_id）
    expect(list[4]).toMatchObject({
      content_raw: A40 + B40,
      index: 0,
      input_mode: "replace",
      input_state: 1,
      msg_id: "MID1",
    })
    expect(s.state).toBe("streaming")
    // 后续 append 走新流
    await s.pushBody(C40)
    list = shards(calls)
    expect(list[5]).toMatchObject({ content_raw: C40, input_mode: "append", index: 1, stream_msg_id: "id-5" })
    expectMsgSeqConstantPerStream(list)
  })

  test("[PRODUCT_BUG] 40007 恢复后 deliveredBody 应等于已下发全文（当前被重复累计）", async () => {
    let failedOnce = false
    const { calls, fetchImpl } = makeRecorder((body) => {
      if (
        !failedOnce &&
        body.input_mode === "append" &&
        body.input_state === 1 &&
        body.index >= 1 &&
        body.stream_msg_id
      ) {
        failedOnce = true
        return new Response(JSON.stringify({ code: 40007, message: "prefix conflict" }), { status: 400 })
      }
      return undefined
    })
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A40)
    await s.pushBody(B40) // 40007 → 新流首片已含 A40+B40
    // 契约：deliveredBody = 已成功下发正文 = A40+B40。
    // 当前实现：sendAppendWithRetry 的 40007 分支已把 chunk 并入 bodyDelivered，
    // flushBody 循环体又执行 bodyDelivered += chunk → A40+B40+B40（sender.ts:539-541 与 :658 重复累计）。
    expect(s.deliveredBody).toBe(A40 + B40)
  })

  test("50002 频控 → 退避后重试成功", async () => {
    let appendAttempts = 0
    const { calls, fetchImpl } = makeRecorder((body) => {
      if (body.input_mode === "append" && body.input_state === 1 && body.index >= 1 && body.stream_msg_id) {
        appendAttempts += 1
        if (appendAttempts === 1) {
          return new Response(JSON.stringify({ code: 50002, message: "rate limited" }), { status: 429 })
        }
      }
      return undefined
    })
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(100), { intervalMs: 100 })))
    await s.start()
    await s.pushBody(A40)
    await s.pushBody(B40)
    expect(appendAttempts).toBe(2) // 第一次 50002 → 退避 2×intervalMs → 第二次成功
    const list = shards(calls)
    expect(list[list.length - 1]).toMatchObject({ content_raw: B40, input_mode: "append" })
    expect(s.state).toBe("streaming")
    expect(s.deliveredBody).toBe(A40 + B40)
  })

  test("[PRODUCT_BUG] 50002 持续频控应保留缓冲、解除后补发（当前实现静默丢内容）", async () => {
    let rateLimited = true
    const { calls, fetchImpl } = makeRecorder((body) => {
      if (rateLimited && body.input_mode === "append" && body.input_state === 1) {
        return new Response(JSON.stringify({ code: 50002, message: "rate limited" }), { status: 429 })
      }
      return undefined
    })
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(100), { intervalMs: 100 })))
    await s.start()
    await s.pushBody(A40)
    await s.pushBody(B40) // 两次 50002 → sendAppendWithRetry 静默 return
    rateLimited = false // 频控解除
    await s.finish(A40 + B40)
    // 契约（回退矩阵）：频控期间缓冲保留，解除后正文延迟继续 → B40 应最终补发。
    // 当前实现：B40 从未下发却被计入 bodyDelivered（sender.ts sendAppendWithRetry 的
    // “仍频控：缓冲保留”注释与 flushBody 的 bodyDelivered += chunk 行为矛盾）。
    expect(sentText(calls)).toContain(B40)
  })

  test("start 首片失败 → state=failed，后续方法零请求", async () => {
    const { calls, fetchImpl } = makeRecorder(
      () => new Response(JSON.stringify({ code: 50001, message: "server error" }), { status: 500 }),
    )
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    expect(s.state).toBe("failed")
    await s.switchScene("TOOL_CALL", { tool: "x" })
    await s.pushBody(A40)
    await s.finish(A40)
    expect(calls).toHaveLength(1) // 仅失败的首片
  })

  test("群聊 ctx 构造抛错（双保险）", () => {
    const { fetchImpl } = makeRecorder()
    expect(
      () =>
        new StreamSession(
          baseOpts(fetchImpl, autoClock(1500), {
            ctx: { type: "group", userId: "U1", groupId: "G1", msgId: "M", content: "x" },
          }),
        ),
    ).toThrow("群聊不支持流式消息")
  })
})

// ---- 收尾 -----------------------------------------------------------------

describe("StreamSession.finish / abort", () => {
  test("deliveredBody 与 finalText 一致 → true，终片 state10", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A40)
    const ok = await s.finish(A40)
    expect(ok).toBe(true)
    expect(s.state).toBe("finished")
    const list = shards(calls)
    expect(list[list.length - 1].input_state).toBe(10)
    expectMsgSeqConstantPerStream(list)
  })

  test("deliveredBody 与 finalText 不一致 → false", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A40)
    const ok = await s.finish(A40 + "尾巴")
    expect(ok).toBe(false)
  })

  test("abort 后零请求", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.abort()
    await s.start()
    await s.pushBody(A40)
    expect(calls).toHaveLength(0)
    expect(s.state).toBe("aborted")
  })
})

// ---- sendfile 标记剥离（第二轮 HANDOFF 五切面） ---------------------------

describe("StreamSession sendfile 标记剥离", () => {
  test("完整标记直接剥离：分片与 deliveredBody 均无标记文本", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody("前".repeat(20) + "[[sendfile:/tmp/report.pdf]]" + "后".repeat(20))
    const ok = await s.finish("前".repeat(20) + "后".repeat(20))
    expect(ok).toBe(true)
    expect(sentText(calls)).not.toContain("sendfile")
    expect(sentText(calls)).not.toContain("/tmp/report.pdf")
    expect(sentText(calls)).not.toContain("[[")
    expect(s.deliveredBody).toBe("前".repeat(20) + "后".repeat(20))
  })

  test("标记跨 delta 拆分：中途 flush 后残片扣留，补全后剥离", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody("A".repeat(30) + "[[sendfile:/tmp/a") // 30 字符触发真实中途 flush
    const afterFirst = shards(calls)
    expect(afterFirst[afterFirst.length - 1].content_raw).toBe("A".repeat(30)) // 正文首片不含残片
    expect(sentText(calls)).not.toContain("sendfile")
    expect(sentText(calls)).not.toContain("/tmp/a")
    await s.pushBody(".txt]]" + "B".repeat(30))
    const ok = await s.finish("A".repeat(30) + "B".repeat(30))
    expect(ok).toBe(true)
    expect(sentText(calls)).not.toContain("sendfile")
    expect(sentText(calls)).not.toContain("/tmp/a")
    expect(s.deliveredBody).toBe("A".repeat(30) + "B".repeat(30))
  })

  test("终刷丢弃未闭合的残片（不进终片）", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody("C".repeat(30) + "[[sendfile:/tmp/never")
    const ok = await s.finish("C".repeat(30))
    expect(ok).toBe(true)
    expect(sentText(calls)).not.toContain("[[")
    expect(sentText(calls)).not.toContain("never")
    expect(s.deliveredBody).toBe("C".repeat(30))
  })

  test("剥离后不足 24 字符不开正文流，短文本 finish 恒 false（既有设计）", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody("短文本")
    const ok = await s.finish("短文本")
    expect(ok).toBe(false)
    const list = shards(calls)
    expect(list).toHaveLength(2) // WAITING open + 占位流终片
    expect(list.every((x) => x.content_raw !== "短文本")).toBe(true)
  })

  test("finish 传原始含标记文本 → false（防 bridge 调用点回归）", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody("D".repeat(40))
    const ok = await s.finish("D".repeat(40) + "[[sendfile:/tmp/x.pdf]]")
    expect(ok).toBe(false) // deliveredBody（已剥离）≠ 原始文本 → 必须回退全量回复
  })
})
