// @input:  ./api (sendC2CMessage, sendGroupMessage, sendStreamMessage, classifyStreamError), ./types (MessageContext), ../copy (Scene, CopyVars)
// @output: replyToQQ, formatForQQ, splitMessage, sendProactiveToQQ, stripThinkingTags, StreamSession
// @pos:    qq层 - 消息发送 (Markdown格式化 + 分割 + 被动回复 + 流式会话状态机)
import {
  sendC2CMessage,
  sendGroupMessage,
  getNextMsgSeq,
  uploadC2CFile,
  uploadGroupFile,
  sendC2CMediaMessage,
  sendGroupMediaMessage,
  sendStreamMessage,
  classifyStreamError,
  type StreamShard,
  type StreamShardResponse,
} from "./api.js"
import { readFileSync, statSync } from "fs"
import { basename } from "path"
import type { MessageContext } from "./types.js"
import type { Scene, CopyVars } from "../copy.js"

const DEFAULT_MAX_LENGTH = 3000

// QQ 原生 markdown（msg_type=2）；关闭则回退纯文本
const MARKDOWN_ENABLED = (process.env.MARKDOWN ?? "on").toLowerCase() !== "off"

// 流式分片 content_type 跟随 MARKDOWN 开关（上游普通路径 on→原生 markdown，流式同款；模块级 env 读取，不新增 env 键）
const STREAM_CONTENT_TYPE: "markdown" | "text" = MARKDOWN_ENABLED ? "markdown" : "text"

// Markdown -> QQ 纯文本: 保留代码块，去除其他标记
export function formatForQQ(text: string): string {
  const codeBlocks: string[] = []

  // 保护代码块，用占位符替换
  let processed = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match)
    return `\x00CB${codeBlocks.length - 1}\x00`
  })

  // 去除 markdown 标记
  processed = processed
    .replace(/\*\*(.+?)\*\*/g, "$1")       // **bold** -> bold
    .replace(/\*(.+?)\*/g, "$1")           // *italic* -> italic
    .replace(/__(.+?)__/g, "$1")           // __underline__ -> underline
    .replace(/~~(.+?)~~/g, "$1")           // ~~strike~~ -> strike
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")  // [text](url) -> text (url)
    .replace(/^#{1,6}\s+/gm, "")           // ### heading -> heading
    .replace(/^>\s?/gm, "")                // > quote -> quote
    .replace(/^---$/gm, "----------")      // --- -> ----------

  // 还原代码块
  for (let i = 0; i < codeBlocks.length; i++) {
    processed = processed.replace(`\x00CB${i}\x00`, codeBlocks[i])
  }

  return processed.trim()
}

// 按段落/代码块边界分割长消息
export function splitMessage(text: string, maxLength: number = DEFAULT_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }

    // 优先在双换行处截断 (段落边界)
    let splitAt = remaining.lastIndexOf("\n\n", maxLength)
    if (splitAt < maxLength * 0.3) {
      // 次选单换行
      splitAt = remaining.lastIndexOf("\n", maxLength)
    }
    if (splitAt < maxLength * 0.3) {
      // 最后才硬截
      splitAt = maxLength
    }

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n+/, "")
  }

  return chunks
}

export async function replyToQQ(
  accessToken: string,
  ctx: MessageContext,
  text: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): Promise<void> {
  if (MARKDOWN_ENABLED) {
    try {
      await sendReplyChunks(accessToken, ctx, text, maxLength, true)
      return
    } catch (error) {
      console.error("[sender] markdown 发送失败，回退纯文本:", error instanceof Error ? error.message : String(error))
    }
  }
  await sendReplyChunks(accessToken, ctx, text, maxLength, false)
}

async function sendReplyChunks(
  accessToken: string,
  ctx: MessageContext,
  text: string,
  maxLength: number,
  markdown: boolean,
): Promise<void> {
  const formatted = markdown ? text.trim() : formatForQQ(text)
  const chunks = splitMessage(formatted, maxLength)

  for (const chunk of chunks) {
    const msgSeq = getNextMsgSeq(ctx.msgId)
    if (ctx.type === "group" && ctx.groupId) {
      await sendGroupMessage(accessToken, ctx.groupId, chunk, ctx.msgId, msgSeq, markdown)
    } else {
      await sendC2CMessage(accessToken, ctx.userId, chunk, ctx.msgId, msgSeq, markdown)
    }
  }
}

/**
 * 主动消息（不带 msg_id）：不受被动回复次数限制，用于中间进度推送。
 */
export async function sendProactiveToQQ(
  accessToken: string,
  ctx: MessageContext,
  text: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): Promise<void> {
  const send = async (markdown: boolean): Promise<void> => {
    const formatted = markdown ? text.trim() : formatForQQ(text)
    const chunks = splitMessage(formatted, maxLength)
    for (const chunk of chunks) {
      if (ctx.type === "group" && ctx.groupId) {
        await sendGroupMessage(accessToken, ctx.groupId, chunk, undefined, undefined, markdown)
      } else {
        await sendC2CMessage(accessToken, ctx.userId, chunk, undefined, undefined, markdown)
      }
    }
  }

  if (MARKDOWN_ENABLED) {
    try {
      await send(true)
      return
    } catch (error) {
      console.error("[sender] markdown 发送失败，回退纯文本:", error instanceof Error ? error.message : String(error))
    }
  }
  await send(false)
}

/** 根据扩展名判断 QQ 富媒体类型：1=图片 2=视频 3=语音 4=文件 */
export function detectOutboundFileType(name: string): number {
  const ext = name.toLowerCase().split(".").pop() ?? ""
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"].includes(ext)) return 1
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) return 2
  if (["mp3", "wav", "silk", "flac", "amr", "ogg"].includes(ext)) return 3
  return 4
}

/**
 * 把本机文件发送给 QQ 用户/群（先上传富媒体，再发 msg_type=7 消息，作为被动回复关联原消息）。
 */
export async function sendFileToQQ(
  accessToken: string,
  ctx: MessageContext,
  filePath: string,
  maxBytes: number = 0,
): Promise<void> {
  const stat = statSync(filePath)
  if (!stat.isFile()) {
    throw new Error(`不是文件：${filePath}`)
  }
  if (maxBytes > 0 && stat.size > maxBytes) {
    throw new Error(`文件过大 ${(stat.size / 1048576).toFixed(1)}MB（上限 ${Math.round(maxBytes / 1048576)}MB）`)
  }
  const name = basename(filePath)
  const fileType = detectOutboundFileType(name)
  const fileData = readFileSync(filePath).toString("base64")
  const msgSeq = getNextMsgSeq(ctx.msgId)

  if (ctx.type === "group" && ctx.groupId) {
    const fileInfo = await uploadGroupFile(accessToken, ctx.groupId, { fileType, fileData, fileName: name })
    await sendGroupMediaMessage(accessToken, ctx.groupId, fileInfo, ctx.msgId, msgSeq)
  } else {
    const fileInfo = await uploadC2CFile(accessToken, ctx.userId, { fileType, fileData, fileName: name })
    await sendC2CMediaMessage(accessToken, ctx.userId, fileInfo, ctx.msgId, msgSeq)
  }
}

// ---------------------------------------------------------------------------
// 流式会话（实验性，仅 C2C）
// ---------------------------------------------------------------------------

/** 正文累计达到该长度才允许 flush（内部常量，不设 env） */
const MIN_FLUSH_CHARS = 24

/** 频控重试上限与指数退避基数（官方 streaming.ts：50002/HTTP 429 最多 3 次重试，1000/2000/4000ms） */
const RATE_LIMIT_RETRIES = 3
const RATE_LIMIT_BACKOFF_BASE_MS = 1000

/** 等待动画帧序列：前缀单调递增，满足 40007「已下发前缀不可修改」约束 */
const DOTS_FRAMES = ["", ".", "..", "..."] as const

// 与 bridge.ts 的 SEND_FILE_RE 保持一致语义（[[sendfile:路径]]，路径不含 ] 和换行）；
// 两处需同步修改。流式缓冲用它剥离标记，避免标记原文随正文露给用户。
const SEND_FILE_MARKER_RE = /\[\[\s*sendfile\s*:\s*([^\]\n]+?)\s*\]\]/gi
const SEND_FILE_KEYWORD = "sendfile"

/**
 * text 尾部若是「疑似未闭合的 [[sendfile:...]] 标记前缀」片段（如 [[、[[sendf、
 * [[sendfile:/tmp/a、或只差一个 ] 的 [[sendfile:/tmp/a]），返回该片段；否则返回 ""。
 * 从最早的候选 [[ 起算，嵌在路径区里的 [[ 也一并扣留。
 */
function trailingSendFileFragment(text: string): string {
  for (let i = text.indexOf("[["); i !== -1; i = text.indexOf("[[", i + 1)) {
    if (isSendFilePrefix(text.slice(i))) return text.slice(i)
  }
  return ""
}

/** s（以 [[ 开头）是否仍可能被后续 delta 补全成一个完整标记（SEND_FILE_MARKER_RE 的前缀语言） */
function isSendFilePrefix(s: string): boolean {
  let i = 2
  while (i < s.length && /\s/.test(s[i])) i++
  for (let k = 0; k < SEND_FILE_KEYWORD.length; k++) {
    if (i >= s.length) return true // 关键字未输完（含 s 恰为 "[[" 或 "[["+空白）
    if (s[i] !== SEND_FILE_KEYWORD[k]) return false
    i++
  }
  while (i < s.length && /\s/.test(s[i])) i++
  if (i >= s.length) return true
  if (s[i] !== ":") return false
  i++
  // 冒号后是路径区（[^\]\n]*）；末尾至多一个 ]（闭合 ]] 的前半，且其前至少 1 个路径字符）
  let end = s.length
  let closable = false
  if (end > i && s[end - 1] === "]") {
    end--
    closable = true
  }
  let pathChars = 0
  for (let k = i; k < end; k++) {
    const ch = s[k]
    if (ch === "]" || ch === "\n") return false
    pathChars++
  }
  return !closable || pathChars > 0
}

// ---- 思考标签剥离（官方 sanitize.ts 同款） -----------------------------------

/** 成对思考标签块：<system-reminder>/<previous_response>/<thinking> 与 deepseek 反引号风格 `think`...`/think` */
const THINK_BLOCK_RE =
  /<system-reminder>[\s\S]*?<\/system-reminder>|<previous_response>[\s\S]*?<\/previous_response>|<thinking>[\s\S]*?<\/thinking>|`think`[\s\S]*?`\/think`/g
/** 残标签：未闭合的开标签（吞到文末）与孤立的闭标签 */
const THINK_RESIDUAL_RE = /<system-reminder>[\s\S]*$|<previous_response>[\s\S]*$|<thinking>[\s\S]*$|`think`[\s\S]*$/g
const THINK_ORPHAN_CLOSE_RE = /<\/(?:system-reminder|previous_response|thinking)>|`\/think`/g

/**
 * 剥离模型思考标签（成对块 + 残标签）。
 * 单一剥离函数两处共用：StreamSession 流式正文（本文件）与 finish 比对基准（bridge.ts），
 * 保证两侧对同一段文本产出一致，finish 比对不因剥离口径漂移而误判。
 */
export function stripThinkingTags(text: string): string {
  return text
    .replace(THINK_BLOCK_RE, "")
    .replace(THINK_RESIDUAL_RE, "")
    .replace(THINK_ORPHAN_CLOSE_RE, "")
}

/** 思考标签开/闭串全集（含反引号风格）；流式尾部疑似未闭合片段按其前缀语言扣留 */
const THINK_TAG_STRINGS = [
  "<system-reminder>",
  "</system-reminder>",
  "<previous_response>",
  "</previous_response>",
  "<thinking>",
  "</thinking>",
  "`think`",
  "`/think`",
] as const

/**
 * text 尾部若是「疑似未闭合的思考标签前缀」片段（如 <thi、`/thi），返回该片段；否则返回 ""。
 * 与 trailingSendFileFragment 同款语义：扣留给后续 delta 补全，避免半截标签闪现。
 */
function trailingThinkingFragment(text: string): string {
  const maxLen = Math.min(text.length, THINK_TAG_STRINGS.reduce((m, s) => Math.max(m, s.length), 0))
  for (let len = maxLen; len >= 1; len--) {
    const tail = text.slice(text.length - len)
    if (THINK_TAG_STRINGS.some((tag) => tail.length < tag.length && tag.startsWith(tail))) return tail
  }
  return ""
}

export interface StreamSessionOptions {
  token: () => Promise<string> // 惰性取 token（复用 getAccessToken 缓存），勿存字符串
  ctx: MessageContext // 仅 C2C；构造时校验，群聊抛错（双保险，bridge 侧已按 ctx.type 过滤）
  render: (scene: Scene, vars: CopyVars) => string // bridge 传入绑定 config.texts 的 renderCopy
  intervalMs: number // 任意两次 HTTP 发送的最小间隔
  chunkSize: number // 兼容保留（append 时代的正文单片上限；replace 全量模式下不再切分，配置键不动）
  maxScenes: number // 占位流条数上限（含首条 WAITING；占位流+正文流共享被动回复 4 次预算）
  fetchImpl?: typeof fetch // 测试注入，缺省 globalThis.fetch
  now?: () => number // 测试注入假时钟，缺省 Date.now
}

export type StreamSessionState = "idle" | "streaming" | "finished" | "aborted" | "failed"

/**
 * 一条 QQ 消息的流式输出会话。
 *
 * 核心语义（对齐官方 SDK @tencent-connect/qqbot-nodejs 的 streaming.ts）：
 * 正文每帧发送「当前累计全文」（input_mode=replace，index 每帧递增），不做 append 增量——
 * deliveredBody 的唯一真理源 = 最后一次成功下发的全量文本（lastAcceptedFull），不存在「部分消费」状态。
 * 40007 前缀约束 ⇒ 场景文案无法原地改写 ⇒ switchScene = 旧流终片(state10) + 另起新流首片；
 * dots 动画因帧序列前缀单调可用 replace。
 * 所有发送经 sendChain 串行并按 intervalMs 节流；任何方法失败不抛给 bridge（内部 catch + 置 state）。
 */
export class StreamSession {
  private readonly opts: StreamSessionOptions
  private readonly now: () => number
  private readonly fetchImpl?: typeof fetch

  private _state: StreamSessionState = "idle"
  private streamMsgId: string | null = null // 当前流的 id（最近一次分片响应 id）
  private nextIndex = 0 // 当前流下一片 index（每条新流重置 0）
  private msgSeq = 0 // 每条新流首片取一次 getNextMsgSeq 并在同流内复用（官方示例同流 msg_seq 恒定）
  private sceneStreamsOpened = 0 // 已开启的占位流条数（含首条 WAITING）
  private bodyStreamActive = false
  private rawBody = "" // 当前段正文全量累计（未剥离；剥离在 flush 时对全量重算，无「部分消费」状态）
  private lastAcceptedFull = "" // 最后一次成功下发的全量正文（剥离后基准；deliveredBody 的唯一真理源）
  private activeScene: Scene | null = null
  private dotsFrame = 0
  private dotsTimer: ReturnType<typeof setInterval> | null = null
  private lastSendAt = Number.NEGATIVE_INFINITY // 节流时间戳（首片不等待）
  private finishResult = false
  private sendChain: Promise<void> = Promise.resolve()

  constructor(options: StreamSessionOptions) {
    if (options.ctx.type !== "c2c") {
      throw new Error("群聊不支持流式消息")
    }
    this.opts = options
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetchImpl
  }

  get state(): StreamSessionState {
    return this._state
  }

  /** 已成功下发的正文（= 最后一次成功下发的全量文本，剥离标记/思考标签后） */
  get deliveredBody(): string {
    return this.lastAcceptedFull
  }

  /** WAITING 首片：index0/replace/state1/msg_id 被动锚定；失败置 state=failed */
  async start(): Promise<void> {
    if (this._state !== "idle") return
    try {
      await this.enqueue(async () => {
        if (this._state !== "idle") return
        const content = this.opts.render("WAITING", { dots: DOTS_FRAMES[0] })
        await this.openStream(content)
        this._state = "streaming"
        this.activeScene = "WAITING"
        this.sceneStreamsOpened = 1
        this.dotsFrame = 0
        this.startDotsTimer()
      })
    } catch (err) {
      console.error("[stream] 流式首片发送失败，本轮回退非流式:", err instanceof Error ? err.message : String(err))
      this.markFailed()
    }
  }

  /**
   * 场景切换 = 旧流终片(state10) + 另起新流首片。
   * - 正文流进行中：TEXT 场景=新一段正文（关闭当前正文流，下段另起，不重复发摘要）；
   *   其余场景走主动消息，不打断正文流。
   * - 占位流预算用尽：场景文案改走主动消息（对齐 STREAMING=off 的进度通道）。
   * - 新流首片失败：重试 1 次（频控先退避），再败 state=failed 并以主动消息发出场景文案。
   */
  async switchScene(scene: Scene, vars: CopyVars): Promise<void> {
    if (this._state !== "streaming") return
    this.stopDotsTimer()
    await this.enqueue(async () => {
      if (this._state !== "streaming") return

      if (this.bodyStreamActive) {
        if (scene === "TEXT") {
          // 上一段正文已流式展示：以终片（全量+state10）关闭，下一段 pushBody 另起新正文流
          await this.flushBody(true)
          if (this._state !== "streaming") return
          this.bodyStreamActive = false
          this.lastAcceptedFull = ""
          this.rawBody = ""
          this.streamMsgId = null // 正文流已以终片关闭，避免对已关闭的流再发终片
          this.nextIndex = 0
          return
        }
        await this.sendSceneProactive(scene, vars)
        return
      }

      if (this.sceneStreamsOpened >= this.opts.maxScenes) {
        await this.sendSceneProactive(scene, vars)
        return
      }

      const content = this.opts.render(scene, vars)
      if (this.streamMsgId) {
        try {
          await this.closeStream()
        } catch (err) {
          console.error("[stream] 旧流终片失败（忽略）:", err instanceof Error ? err.message : String(err))
        }
      }
      try {
        await this.openStream(content)
        this.sceneStreamsOpened++
        this.activeScene = scene
      } catch (err) {
        console.error("[stream] 场景流首片失败，回退主动消息:", err instanceof Error ? err.message : String(err))
        this.markFailed()
        await this.sendSceneProactive(scene, vars)
      }
    })
  }

  /**
   * 正文增量：累计进全量缓冲，节流后以 replace+全量分片下发（达到 minFlush 才发）。
   * [[sendfile:...]] 标记与思考标签在 flush 时对全量文本统一剥离：完整标记/标签块直接删掉；
   * 尾部疑似未闭合的片段扣留给后续 delta 补全，避免半截标记/标签闪现（文件由 bridge 的
   * deliverResult 单独发送，不走流式正文）。
   */
  async pushBody(delta: string): Promise<void> {
    if (this._state !== "streaming") return
    if (!delta) return
    this.stopDotsTimer()
    this.rawBody += delta
    await this.enqueue(() => this.flushBody(false))
  }

  /**
   * 收尾：冲刷剩余正文并以终片(state10)结束。
   * 返回 deliveredBody 与 finalText（trim 后）是否一致；不一致时 bridge 走全量回退。
   */
  async finish(finalText: string): Promise<boolean> {
    if (this._state === "finished") return this.finishResult
    if (this._state !== "streaming") return false
    this.stopDotsTimer()
    await this.enqueue(async () => {
      if (this._state === "finished") return
      if (this._state !== "streaming") {
        this._state = "finished"
        this.finishResult = false
        return
      }
      if (this.bodyStreamActive) {
        await this.flushBody(true)
        this.finishResult =
          this._state === "streaming" && this.lastAcceptedFull.trim() === finalText.trim()
      } else {
        // 正文流从未开启：关闭占位流；仅当最终文本为空才算已投递
        if (this.streamMsgId) {
          try {
            await this.closeStream()
          } catch (err) {
            console.error("[stream] 占位流终片失败（忽略）:", err instanceof Error ? err.message : String(err))
          }
        }
        this.finishResult = finalText.trim() === ""
      }
      if (this._state === "streaming") this._state = "finished"
    })
    return this.finishResult
  }

  /** 停发一切请求（在途请求自然完成），不发终片 */
  async abort(): Promise<void> {
    this.stopDotsTimer()
    this._state = "aborted"
    await this.sendChain
  }

  /** 弃流 → replyToQQ 全量回退（被动回复） */
  async fallbackToReply(text: string): Promise<void> {
    this.stopDotsTimer()
    this._state = "aborted"
    const token = await this.opts.token()
    await replyToQQ(token, this.opts.ctx, text)
  }

  // ---- 内部：发送管道 ----------------------------------------------------

  /** 串行化所有发送；链上任务失败不传染 */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.sendChain.then(task)
    this.sendChain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /** 任意两次 HTTP 发送的最小间隔（用注入时钟计算等待时长） */
  private async throttle(): Promise<void> {
    const wait = this.opts.intervalMs - (this.now() - this.lastSendAt)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.lastSendAt = this.now()
  }

  /**
   * 频控指数退避（官方基数 1000ms：1000/2000/4000）。
   * 从上一次发送起算补足等待时长（注入时钟步进 ≥ 4000 可在测试中归零真实等待）。
   */
  private async backoff(retry: number): Promise<void> {
    const delay = RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (retry - 1)
    const wait = delay - (this.now() - this.lastSendAt)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }

  private async sendShard(shard: StreamShard): Promise<StreamShardResponse> {
    if (this._state === "finished" || this._state === "aborted" || this._state === "failed") {
      throw new Error(`[stream] session ${this._state}，拒绝发送分片`)
    }
    await this.throttle()
    const token = await this.opts.token()
    return sendStreamMessage(token, this.opts.ctx.userId, shard, this.fetchImpl)
  }

  /**
   * 另起新流：首片 replace/state1/index0，带 msg_id 被动锚定；msg_seq 本流内复用。
   * 频控（50002/HTTP 429）按官方策略重试：最多 3 次、指数退避。首片重试保持 index0
   * （msg_id+msg_seq 去重锚定；index>0 需要 stream_msg_id，而失败响应不携带）。
   */
  private async openStream(content: string): Promise<void> {
    this.msgSeq = getNextMsgSeq(this.opts.ctx.msgId)
    this.nextIndex = 0
    for (let retry = 0; ; retry++) {
      try {
        const res = await this.sendShard({
          content,
          index: 0,
          inputMode: "replace",
          inputState: 1,
          contentType: STREAM_CONTENT_TYPE,
          msgId: this.opts.ctx.msgId,
          msgSeq: this.msgSeq,
        })
        this.streamMsgId = res.id
        this.nextIndex = 1
        return
      } catch (err) {
        if (classifyStreamError(err) === "rate-limited" && retry < RATE_LIMIT_RETRIES) {
          await this.backoff(retry + 1)
          continue
        }
        throw err
      }
    }
  }

  /** 旧流终片：state10 空内容标记结束（append+空串不改写已下发内容） */
  private async closeStream(): Promise<void> {
    if (!this.streamMsgId) return
    await this.sendShard({
      content: "",
      index: this.nextIndex,
      inputMode: "append",
      inputState: 10,
      contentType: STREAM_CONTENT_TYPE,
      streamMsgId: this.streamMsgId,
      msgSeq: this.msgSeq,
    })
    this.streamMsgId = null
    this.nextIndex = 0
  }

  /**
   * 正文分片：replace + 当前累计全文（官方语义：update() 携带全文而非增量）。
   * 频控重试对齐官方：最多 3 次、指数退避，且重试时 index 前进
   * （官方注释：Advance index for the retry to avoid stale index conflict）。
   * 重试全部失败向上抛，由 flushBody 决定跳帧或终局。
   */
  private async sendBodyFrame(sendable: string, state: 1 | 10): Promise<void> {
    if (!this.streamMsgId) throw new Error("[stream] 正文分片无活动流")
    for (let retry = 0; ; retry++) {
      const index = this.nextIndex
      try {
        const res = await this.sendShard({
          content: this.renderBody(sendable),
          index,
          inputMode: "replace",
          inputState: state,
          contentType: STREAM_CONTENT_TYPE,
          streamMsgId: this.streamMsgId,
          msgSeq: this.msgSeq,
        })
        this.streamMsgId = res.id
        this.nextIndex = index + 1
        this.lastAcceptedFull = sendable
        return
      } catch (err) {
        const kind = classifyStreamError(err)
        if (kind === "prefix-conflict") throw err // 由 flushBody 统一走冲突终局
        if (kind === "rate-limited") {
          // 官方注释：Advance index for the retry to avoid stale index conflict
          // （含耗尽的最后一次失败也推进，下一帧绝不复用已尝试过的 index）
          this.nextIndex = index + 1
          if (retry < RATE_LIMIT_RETRIES) {
            await this.backoff(retry + 1)
            continue
          }
          throw err
        }
        throw err
      }
    }
  }

  /**
   * 前缀冲突终局（官方 streaming-controller 的 prefixMatches 检查 + transition('failed') 同款）：
   * 新全量文本不是已下发文本的前缀延伸（模型改写了已下发内容，或服务端 40007）——
   * 以不改写内容的安全终片结束当前流并置 state=failed，交由 bridge 全量兜底（finish 返回 false）。
   */
  private async endStreamAsFailed(): Promise<void> {
    if (this.streamMsgId) {
      try {
        await this.closeStream()
      } catch (err) {
        console.error("[stream] 冲突终片失败（忽略）:", err instanceof Error ? err.message : String(err))
      }
    }
    this.markFailed()
  }

  private renderBody(text: string): string {
    return this.opts.render("BODY", { body: text })
  }

  /** 场景文案走普通主动消息（预算用尽 / 正文流进行中 / 场景流失败时） */
  private async sendSceneProactive(scene: Scene, vars: CopyVars): Promise<void> {
    try {
      await this.throttle()
      const token = await this.opts.token()
      await sendProactiveToQQ(token, this.opts.ctx, this.opts.render(scene, vars))
    } catch (err) {
      console.error("[stream] 场景文案主动发送失败（忽略）:", err instanceof Error ? err.message : String(err))
    }
  }

  private markFailed(): void {
    this.stopDotsTimer()
    this._state = "failed"
  }

  // ---- 内部：正文冲刷 ----------------------------------------------------

  /**
   * 冲刷正文：对全量累计重算「可下发文本」，按需发 replace+全量帧。
   * 可下发文本 = 剥完整 sendfile 标记 → 剥思考标签（成对块+残标签）→ 扣留尾部疑似未闭合片段
   * （sendfile 残片终刷时丢弃；思考标签残片终刷时放行——与官方完整文本 sanitize 口径一致，
   * 避免正文以反引号/`<` 结尾时无谓回退）。
   */
  private async flushBody(final: boolean): Promise<void> {
    if (this._state !== "streaming") return
    const stripped = stripThinkingTags(this.rawBody.replace(SEND_FILE_MARKER_RE, ""))
    let sendable = stripped
    const markerTail = trailingSendFileFragment(stripped)
    if (markerTail) sendable = sendable.slice(0, sendable.length - markerTail.length)
    if (!final) {
      const tagTail = trailingThinkingFragment(sendable)
      if (tagTail) sendable = sendable.slice(0, sendable.length - tagTail.length)
    }

    if (!this.bodyStreamActive) {
      // 开流门槛：仅非终刷且满 MIN_FLUSH_CHARS 才开正文流（终刷从不开流——未开流的收尾走占位流关闭+空比对）
      if (final || !sendable || sendable.length < MIN_FLUSH_CHARS) return
      if (this.streamMsgId) {
        try {
          await this.closeStream()
        } catch (err) {
          console.error("[stream] 占位流终片失败（忽略）:", err instanceof Error ? err.message : String(err))
        }
      }
      try {
        await this.openStream(this.renderBody(sendable))
      } catch (err) {
        if (classifyStreamError(err) === "rate-limited") {
          // 开流频控重试耗尽：本轮跳过（占位流已关，下轮 flush 重新开流），会话保持
          console.error("[stream] 正文流首片频控重试耗尽，本轮跳过（finish 比对失败将回退全量）")
          return
        }
        console.error("[stream] 正文流首片失败:", err instanceof Error ? err.message : String(err))
        this.markFailed()
        return
      }
      this.bodyStreamActive = true
      this.activeScene = "BODY"
      this.lastAcceptedFull = sendable
      return
    }

    if (sendable === this.lastAcceptedFull) {
      if (!final) return
      // 无新增内容也要补 DONE 帧（replace+全量+state10，内容幂等）
      try {
        await this.sendBodyFrame(sendable, 10)
      } catch (err) {
        console.error("[stream] 终片失败:", err instanceof Error ? err.message : String(err))
        this.markFailed()
      }
      return
    }

    if (!sendable.startsWith(this.lastAcceptedFull)) {
      // 官方 prefixMatches 检查：模型改写了已下发文本 → 冲突终局
      console.error("[stream] 新全量文本不是已下发文本的前缀延伸，结束流并回退全量")
      await this.endStreamAsFailed()
      return
    }
    if (!final && sendable.length - this.lastAcceptedFull.length < MIN_FLUSH_CHARS) return

    try {
      await this.sendBodyFrame(sendable, final ? 10 : 1)
    } catch (err) {
      if (classifyStreamError(err) === "prefix-conflict") {
        await this.endStreamAsFailed()
        return
      }
      if (final || classifyStreamError(err) !== "rate-limited") {
        console.error("[stream] 正文分片失败:", err instanceof Error ? err.message : String(err))
        this.markFailed()
        return
      }
      // 频控重试耗尽：跳过该帧，lastAcceptedFull 不推进（不丢内容：finish 比对失败 → 回退全量；
      // replace 全量语义下后续任一成功帧即自愈补齐全部欠账）
      console.error("[stream] 正文分片频控重试耗尽，跳过该帧（内容不丢：finish 比对失败将回退全量）")
    }
  }

  // ---- 内部：等待动画 ----------------------------------------------------

  private startDotsTimer(): void {
    this.stopDotsTimer()
    this.dotsTimer = setInterval(() => {
      if (
        this._state !== "streaming" ||
        this.activeScene !== "WAITING" ||
        this.bodyStreamActive ||
        this.rawBody !== ""
      ) {
        return
      }
      this.dotsFrame = Math.min(this.dotsFrame + 1, DOTS_FRAMES.length - 1)
      const frame = DOTS_FRAMES[this.dotsFrame]
      void this.enqueue(async () => {
        if (
          this._state !== "streaming" ||
          this.activeScene !== "WAITING" ||
          this.bodyStreamActive ||
          this.rawBody !== "" ||
          !this.streamMsgId
        ) {
          return
        }
        try {
          const res = await this.sendShard({
            content: this.opts.render("WAITING", { dots: frame }),
            index: this.nextIndex,
            inputMode: "replace",
            inputState: 1,
            contentType: STREAM_CONTENT_TYPE,
            streamMsgId: this.streamMsgId,
            msgSeq: this.msgSeq,
          })
          this.streamMsgId = res.id
          this.nextIndex++
        } catch (err) {
          console.error("[stream] 等待动画帧发送失败（忽略）:", err instanceof Error ? err.message : String(err))
        }
      })
    }, this.opts.intervalMs)
    this.dotsTimer.unref?.()
  }

  private stopDotsTimer(): void {
    if (this.dotsTimer) {
      clearInterval(this.dotsTimer)
      this.dotsTimer = null
    }
  }
}
