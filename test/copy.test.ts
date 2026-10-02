// copy.test.ts — 分场景文案模板：默认值黄金断言 + 插值 + 覆盖 + 未知占位符 + 缺失 var
import { describe, expect, test } from "bun:test"
import { DEFAULT_COPY, renderCopy, type Scene } from "../src/copy.js"

// 黄金值 = main@556a8d0 bridge.ts 现行硬编码逐字（:542/:584/:636/:642/:656）；
// WAITING/PERMISSION/BODY 为新增默认（无现状对照，按实现契约锁定）。
describe("DEFAULT_COPY 黄金值", () => {
  test("TOOL_CALL 与 bridge 现行硬编码逐字一致", () => {
    expect(DEFAULT_COPY.TOOL_CALL).toBe("🔧 调用工具：{tool}")
  })
  test("TOOL_RESULT 与 bridge 现行硬编码逐字一致", () => {
    expect(DEFAULT_COPY.TOOL_RESULT).toBe("📄 {tool} 返回：{result}")
  })
  test("TOOL_FAILED 与 bridge 现行硬编码逐字一致", () => {
    expect(DEFAULT_COPY.TOOL_FAILED).toBe("❌ 工具失败：{error}")
  })
  test("TEXT 与 bridge 现行硬编码逐字一致", () => {
    expect(DEFAULT_COPY.TEXT).toBe("💬 {snippet}")
  })
  test("HEARTBEAT 与 bridge 现行硬编码逐字一致", () => {
    expect(DEFAULT_COPY.HEARTBEAT).toBe("⏳ 仍在处理中（已用 {min} 分 {sec} 秒）…")
  })
  test("WAITING 默认为 请稍候{dots}", () => {
    expect(DEFAULT_COPY.WAITING).toBe("请稍候{dots}")
  })
  test("PERMISSION 默认为 🔒 需要授权：{title}", () => {
    expect(DEFAULT_COPY.PERMISSION).toBe("🔒 需要授权：{title}")
  })
  test("BODY 默认为 {body}", () => {
    expect(DEFAULT_COPY.BODY).toBe("{body}")
  })
})

describe("renderCopy 插值", () => {
  test("TOOL_CALL 插值工具名", () => {
    expect(renderCopy("TOOL_CALL", { tool: "bash" })).toBe("🔧 调用工具：bash")
  })
  test("TOOL_RESULT 插值工具名与结果摘要", () => {
    expect(renderCopy("TOOL_RESULT", { tool: "bash", result: "done ok" })).toBe("📄 bash 返回：done ok")
  })
  test("TOOL_FAILED 插值错误消息", () => {
    expect(renderCopy("TOOL_FAILED", { error: "boom" })).toBe("❌ 工具失败：boom")
  })
  test("TEXT 插值中间文本", () => {
    expect(renderCopy("TEXT", { snippet: "第一段" })).toBe("💬 第一段")
  })
  test("HEARTBEAT 插值数字分钟与秒", () => {
    expect(renderCopy("HEARTBEAT", { min: 2, sec: 5 })).toBe("⏳ 仍在处理中（已用 2 分 5 秒）…")
    expect(renderCopy("HEARTBEAT", { min: 0, sec: 0 })).toBe("⏳ 仍在处理中（已用 0 分 0 秒）…")
  })
  test("WAITING 插值动画帧", () => {
    expect(renderCopy("WAITING", { dots: "" })).toBe("请稍候")
    expect(renderCopy("WAITING", { dots: "..." })).toBe("请稍候...")
  })
  test("PERMISSION 插值标题", () => {
    expect(renderCopy("PERMISSION", { title: "写文件" })).toBe("🔒 需要授权：写文件")
  })
  test("BODY 插值正文原样", () => {
    expect(renderCopy("BODY", { body: "abc\n123" })).toBe("abc\n123")
  })
})

describe("renderCopy texts 覆盖", () => {
  test("texts 覆盖对应场景", () => {
    expect(renderCopy("TOOL_CALL", { tool: "x" }, { TOOL_CALL: "T:{tool}" })).toBe("T:x")
  })
  test("覆盖一个场景不影响其他场景默认值", () => {
    const texts: Partial<Record<Scene, string>> = { TOOL_CALL: "T:{tool}" }
    expect(renderCopy("TOOL_RESULT", { tool: "a", result: "b" }, texts)).toBe("📄 a 返回：b")
  })
  test("覆盖模板里的未知占位符同样原样保留", () => {
    expect(renderCopy("TEXT", { snippet: "s" }, { TEXT: "[{nope}] {snippet}" })).toBe("[{nope}] s")
  })
})

describe("renderCopy 占位符边界", () => {
  test("未知占位符原样保留（fail-visible）", () => {
    expect(renderCopy("TOOL_CALL", { tool: "bash" }, { TOOL_CALL: "{tool} {unknown}" })).toBe("bash {unknown}")
    expect(renderCopy("TOOL_CALL", { tool: "bash" }, { TOOL_CALL: "{tool} {unknown}" })).not.toContain("🔧")
  })
  test("缺失 var 渲染为空串", () => {
    expect(renderCopy("TOOL_CALL", {})).toBe("🔧 调用工具：")
    expect(renderCopy("HEARTBEAT", {})).toBe("⏳ 仍在处理中（已用  分  秒）…")
  })
  test("vars 为 undefined 时等价空对象", () => {
    expect(renderCopy("TOOL_CALL")).toBe("🔧 调用工具：")
  })
  test("var 值为空串时渲染为空串（区别于未知占位符）", () => {
    expect(renderCopy("TOOL_CALL", { tool: "" })).toBe("🔧 调用工具：")
  })
})
