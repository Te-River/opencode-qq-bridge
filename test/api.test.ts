// api.test.ts — sendStreamMessage 请求体/鉴权/路径 + QQApiError + classifyStreamError + apiRequest 回归
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  apiRequest,
  classifyStreamError,
  QQApiError,
  sendStreamMessage,
  type StreamShard,
} from "../src/qq/api.js"

// apiRequest 日志量大，测试期静默
const origLog = console.log
const origErr = console.error
beforeEach(() => {
  console.log = () => {}
  console.error = () => {}
})
afterEach(() => {
  console.log = origLog
  console.error = origErr
})

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

let calls: Recorded[] = []
let nextId = 0
const realFetch = globalThis.fetch

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  calls = []
  nextId = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const raw = typeof init?.body === "string" ? init.body : ""
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    })
    nextId += 1
    return jsonResponse({ id: `resp-${nextId}`, timestamp: 1 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const TOKEN = "tok-123"
const OPENID = "OPEN1"

function firstShard(): StreamShard {
  return {
    content: "你好",
    index: 0,
    inputMode: "replace",
    inputState: 1,
    contentType: "text",
    msgId: "MID1",
    msgSeq: 42,
  }
}

describe("sendStreamMessage 首片请求体", () => {
  test("路径为 /v2/users/{openid}/stream_messages 且方法 POST", async () => {
    await sendStreamMessage(TOKEN, OPENID, firstShard())
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`https://api.sgroup.qq.com/v2/users/${OPENID}/stream_messages`)
    expect(calls[0].method).toBe("POST")
  })
  test("鉴权头为 QQBot 方案（不是 Bearer）", async () => {
    await sendStreamMessage(TOKEN, OPENID, firstShard())
    expect(calls[0].headers.Authorization).toBe(`QQBot ${TOKEN}`)
    expect(calls[0].headers["Content-Type"]).toBe("application/json")
  })
  test("请求体逐项：content_raw/index/input_mode/input_state/content_type/msg_id/msg_seq", async () => {
    await sendStreamMessage(TOKEN, OPENID, firstShard())
    expect(calls[0].body).toEqual({
      content_raw: "你好",
      index: 0,
      input_mode: "replace",
      input_state: 1,
      content_type: "text",
      msg_seq: 42,
      msg_id: "MID1",
    })
  })
  test("返回响应体（id 供后续分片 stream_msg_id 使用）", async () => {
    const res = await sendStreamMessage(TOKEN, OPENID, firstShard())
    expect(res.id).toBe("resp-1")
  })
})

describe("sendStreamMessage 后续分片", () => {
  test("第二片携带 stream_msg_id=首片响应 id 且 index:1，无 msg_id", async () => {
    const first = await sendStreamMessage(TOKEN, OPENID, firstShard())
    await sendStreamMessage(TOKEN, OPENID, {
      content: "世界",
      index: 1,
      inputMode: "append",
      inputState: 1,
      streamMsgId: first.id,
      msgSeq: 42,
    })
    expect(calls).toHaveLength(2)
    expect(calls[1].body).toEqual({
      content_raw: "世界",
      index: 1,
      input_mode: "append",
      input_state: 1,
      content_type: "text",
      msg_seq: 42,
      stream_msg_id: "resp-1",
    })
  })
  test("终片 input_state:10", async () => {
    await sendStreamMessage(TOKEN, OPENID, {
      content: "",
      index: 2,
      inputMode: "append",
      inputState: 10,
      streamMsgId: "resp-1",
      msgSeq: 42,
    })
    expect(calls[0].body.input_state).toBe(10)
  })
  test("同一流所有分片 msg_seq 恒定（调用方复用同一 msgSeq 时逐字透传）", async () => {
    const first = await sendStreamMessage(TOKEN, OPENID, firstShard())
    await sendStreamMessage(TOKEN, OPENID, { content: "a", index: 1, inputMode: "append", inputState: 1, streamMsgId: first.id, msgSeq: 42 })
    await sendStreamMessage(TOKEN, OPENID, { content: "", index: 2, inputMode: "append", inputState: 10, streamMsgId: first.id, msgSeq: 42 })
    const seqs = calls.map((c) => c.body.msg_seq)
    expect(seqs).toEqual([42, 42, 42])
  })
  test("未传 msgSeq 时缺省为 1", async () => {
    await sendStreamMessage(TOKEN, OPENID, { content: "x", index: 0, inputMode: "replace", inputState: 1 })
    expect(calls[0].body.msg_seq).toBe(1)
  })
})

describe("QQApiError 与 classifyStreamError", () => {
  async function sendWith(status: number, payload: unknown): Promise<void> {
    globalThis.fetch = (async () => jsonResponse(payload, status)) as typeof fetch
    await sendStreamMessage(TOKEN, OPENID, firstShard())
  }

  test("40007 → QQApiError.code=40007，分类 prefix-conflict", async () => {
    let caught: unknown
    await sendWith(400, { code: 40007, message: "prefix conflict" }).catch((e) => { caught = e })
    expect(caught).toBeInstanceOf(QQApiError)
    const err = caught as QQApiError
    expect(err.code).toBe(40007)
    expect(err.status).toBe(400)
    expect(err.path).toBe(`/v2/users/${OPENID}/stream_messages`)
    expect(err.message).toBe(`API Error [/v2/users/${OPENID}/stream_messages]: prefix conflict`)
    expect(classifyStreamError(err)).toBe("prefix-conflict")
  })
  test("50002 → rate-limited", async () => {
    let caught: unknown
    await sendWith(429, { code: 50002, message: "rate limited" }).catch((e) => { caught = e })
    expect((caught as QQApiError).code).toBe(50002)
    expect(classifyStreamError(caught)).toBe("rate-limited")
  })
  test("50001 → server-error", async () => {
    let caught: unknown
    await sendWith(500, { code: 50001, message: "server error" }).catch((e) => { caught = e })
    expect((caught as QQApiError).code).toBe(50001)
    expect(classifyStreamError(caught)).toBe("server-error")
  })
  test("其他业务码 → http", async () => {
    let caught: unknown
    await sendWith(400, { code: 99999, message: "other" }).catch((e) => { caught = e })
    expect(classifyStreamError(caught)).toBe("http")
  })
  test("无 code 字段的 QQApiError → http", async () => {
    let caught: unknown
    await sendWith(404, { message: "not found" }).catch((e) => { caught = e })
    expect((caught as QQApiError).code).toBeUndefined()
    expect(classifyStreamError(caught)).toBe("http")
  })
  test("Network error 前缀 → network", () => {
    expect(classifyStreamError(new Error("Network error [x]: boom"))).toBe("network")
    expect(classifyStreamError(new Error("Request timeout [x]: exceeded 30000ms"))).toBe("network")
  })
  test("普通错误 → unknown；非错误值 → unknown", () => {
    expect(classifyStreamError(new Error("whatever"))).toBe("unknown")
    expect(classifyStreamError(null)).toBe("unknown")
    expect(classifyStreamError("string")).toBe("unknown")
  })
})

describe("apiRequest 默认行为回归", () => {
  test("默认鉴权头仍为 QQBot，成功路径返回解析后的 JSON", async () => {
    const res = await apiRequest<{ id: string }>(TOKEN, "POST", "/v2/users/OPEN1/messages", { content: "hi" })
    expect(res.id).toBe("resp-1")
    expect(calls[0].headers.Authorization).toBe(`QQBot ${TOKEN}`)
    expect(calls[0].body).toEqual({ content: "hi" })
  })
  test("非 2xx 抛 QQApiError，message 保持 API Error [path] 格式", async () => {
    globalThis.fetch = (async () => jsonResponse({ message: "bad" }, 400)) as typeof fetch
    let caught: unknown
    await apiRequest(TOKEN, "POST", "/v2/users/OPEN1/messages", {}).catch((e) => { caught = e })
    expect(caught).toBeInstanceOf(QQApiError)
    expect((caught as QQApiError).message).toBe("API Error [/v2/users/OPEN1/messages]: bad")
  })
  test("fetch 抛错 → Network error [path] 前缀（classifyStreamError 判 network）", async () => {
    globalThis.fetch = (async () => { throw new TypeError("connection reset") }) as typeof fetch
    let caught: unknown
    await apiRequest(TOKEN, "GET", "/gateway").catch((e) => { caught = e })
    expect((caught as Error).message).toBe("Network error [/gateway]: connection reset")
    expect(classifyStreamError(caught)).toBe("network")
  })
})
