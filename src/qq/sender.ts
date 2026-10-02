// @input:  ./api (sendC2CMessage, sendGroupMessage, sendStreamMessage, classifyStreamError), ./types (MessageContext), ../copy (Scene, CopyVars)
// @output: replyToQQ, formatForQQ, splitMessage, sendProactiveToQQ, StreamSession
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

/** 正文缓冲达到该长度才允许 flush（内部常量，不设 env） */
const MIN_FLUSH_CHARS = 24

/** 等待动画帧序列：前缀单调递增，满足 40007「已下发前缀不可修改」约束 */
const DOTS_FRAMES = ["", ".", "..", "..."] as const

export interface StreamSessionOptions {
  token: () => Promise<string> // 惰性取 token（复用 getAccessToken 缓存），勿存字符串
  ctx: MessageContext // 仅 C2C；构造时校验，群聊抛错（双保险，bridge 侧已按 ctx.type 过滤）
  render: (scene: Scene, vars: CopyVars) => string // bridge 传入绑定 config.texts 的 renderCopy
  intervalMs: number // 任意两次 HTTP 发送的最小间隔
  chunkSize: number // 正文单片最大字符数
  maxScenes: number // 占位流条数上限（含首条 WAITING；占位流+正文流共享被动回复 4 次预算）
  fetchImpl?: typeof fetch // 测试注入，缺省 globalThis.fetch
  now?: () => number // 测试注入假时钟，缺省 Date.now
}

export type StreamSessionState = "idle" | "streaming" | "finished" | "aborted" | "failed"

/**
 * 一条 QQ 消息的流式输出会话。
 *
 * 核心语义（由 40007 前缀约束推出）：replace 新内容必须以已下发前缀开头，
 * 场景文案无法原地改写 ⇒ switchScene = 旧流终片(state10) + 另起新流（新 QQ 消息）首片；
 * dots 动画因帧序列前缀单调可用 replace；pushBody 用 append 增量。
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
  private bodyDelivered = "" // 已成功下发的正文（原始字符，不含 BODY 模板前缀）
  private bodyBuffer = "" // 待 flush 的正文增量
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

  /** 已成功下发的正文（原始字符） */
  get deliveredBody(): string {
    return this.bodyDelivered
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
          // 上一段正文已流式展示：冲刷尾巴并以终片关闭，下一段 pushBody 另起新正文流
          await this.flushBody(true)
          if (this._state !== "streaming") return
          this.bodyStreamActive = false
          this.bodyDelivered = ""
          this.bodyBuffer = ""
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
        await this.openStreamWithRetry(content)
        this.sceneStreamsOpened++
        this.activeScene = scene
      } catch (err) {
        console.error("[stream] 场景流首片失败，回退主动消息:", err instanceof Error ? err.message : String(err))
        this.markFailed()
        await this.sendSceneProactive(scene, vars)
      }
    })
  }

  /** 正文增量：缓冲 + 节流 append 分片（达到 minFlush 才发，单片不超过 chunkSize） */
  async pushBody(delta: string): Promise<void> {
    if (this._state !== "streaming") return
    if (!delta) return
    this.stopDotsTimer()
    this.bodyBuffer += delta
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
          this._state === "streaming" && this.bodyDelivered.trim() === finalText.trim()
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

  private async backoff(): Promise<void> {
    await new Promise((r) => setTimeout(r, 2 * this.opts.intervalMs))
  }

  private async sendShard(shard: StreamShard): Promise<StreamShardResponse> {
    if (this._state === "finished" || this._state === "aborted" || this._state === "failed") {
      throw new Error(`[stream] session ${this._state}，拒绝发送分片`)
    }
    await this.throttle()
    const token = await this.opts.token()
    return sendStreamMessage(token, this.opts.ctx.userId, shard, this.fetchImpl)
  }

  /** 另起新流：首片 replace/state1/index0，带 msg_id 被动锚定；msg_seq 本流内复用 */
  private async openStream(content: string): Promise<void> {
    this.msgSeq = getNextMsgSeq(this.opts.ctx.msgId)
    this.nextIndex = 0
    const res = await this.sendShard({
      content,
      index: 0,
      inputMode: "replace",
      inputState: 1,
      contentType: "text",
      msgId: this.opts.ctx.msgId,
      msgSeq: this.msgSeq,
    })
    this.streamMsgId = res.id
    this.nextIndex = 1
  }

  /** 新流首片：频控先退避 2×intervalMs，重试 1 次；再败向上抛 */
  private async openStreamWithRetry(content: string): Promise<void> {
    try {
      await this.openStream(content)
    } catch (err) {
      if (classifyStreamError(err) === "rate-limited") await this.backoff()
      await this.openStream(content)
    }
  }

  /** 旧流终片：state10 空内容标记结束 */
  private async closeStream(): Promise<void> {
    if (!this.streamMsgId) return
    await this.sendShard({
      content: "",
      index: this.nextIndex,
      inputMode: "append",
      inputState: 10,
      contentType: "text",
      streamMsgId: this.streamMsgId,
      msgSeq: this.msgSeq,
    })
    this.streamMsgId = null
    this.nextIndex = 0
  }

  /** 正文 append 分片；40007 另起流（首片=已下发+缓冲全文），50002 退避重试 */
  private async sendAppendWithRetry(chunk: string, state: 1 | 10): Promise<void> {
    try {
      await this.sendAppend(chunk, state)
      return
    } catch (err) {
      const kind = classifyStreamError(err)
      if (kind === "prefix-conflict") {
        // 另起流：新流首片 = 已下发 + 当前缓冲 全文（replace）
        const fullRaw = this.bodyDelivered + this.bodyBuffer
        await this.openStreamWithRetry(this.renderBody(fullRaw))
        this.bodyDelivered = fullRaw
        this.bodyBuffer = ""
        if (state === 10) await this.sendAppend("", 10) // 补终片
        return
      }
      if (kind === "rate-limited") {
        await this.backoff()
        try {
          await this.sendAppend(chunk, state)
          return
        } catch (err2) {
          if (classifyStreamError(err2) === "rate-limited") return // 仍频控：缓冲保留，会话保持
          throw err2
        }
      }
      throw err
    }
  }

  private async sendAppend(chunk: string, state: 1 | 10): Promise<void> {
    if (!this.streamMsgId) throw new Error("[stream] append 无活动流")
    const res = await this.sendShard({
      content: chunk,
      index: this.nextIndex,
      inputMode: "append",
      inputState: state,
      contentType: "text",
      streamMsgId: this.streamMsgId,
      msgSeq: this.msgSeq,
    })
    // 续片携带最近一次分片响应 id（若服务端整流恒定 id，则等价于首片 id）
    this.streamMsgId = res.id
    this.nextIndex++
  }

  /** 终片：剩余缓冲作为内容（可能为空串）；任意失败重试 1 次 */
  private async sendFinalShard(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.sendAppendWithRetry(this.bodyBuffer, 10)
        this.bodyDelivered += this.bodyBuffer
        this.bodyBuffer = ""
        return
      } catch (err) {
        if (attempt === 1) throw err
      }
    }
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

  private async flushBody(final: boolean): Promise<void> {
    if (this._state !== "streaming") return
    if (!final && this.bodyBuffer.length < MIN_FLUSH_CHARS) return

    if (!this.bodyStreamActive) {
      if (!this.bodyBuffer) return
      // 开正文流：关闭占位流，首片 replace 全量（BODY 模板仅作用于首片）
      const firstChunk = this.bodyBuffer.slice(0, this.opts.chunkSize)
      if (this.streamMsgId) {
        try {
          await this.closeStream()
        } catch (err) {
          console.error("[stream] 占位流终片失败（忽略）:", err instanceof Error ? err.message : String(err))
        }
      }
      try {
        await this.openStreamWithRetry(this.renderBody(firstChunk))
      } catch (err) {
        console.error("[stream] 正文流首片失败:", err instanceof Error ? err.message : String(err))
        this.markFailed()
        return
      }
      this.bodyStreamActive = true
      this.activeScene = "BODY"
      this.bodyDelivered = firstChunk
      this.bodyBuffer = this.bodyBuffer.slice(firstChunk.length)
    }

    while (this.bodyBuffer) {
      if (final && this.bodyBuffer.length <= this.opts.chunkSize) {
        try {
          await this.sendFinalShard()
        } catch {
          this.markFailed()
        }
        return
      }
      if (!final && this.bodyBuffer.length < MIN_FLUSH_CHARS) return
      const chunk = this.bodyBuffer.slice(0, this.opts.chunkSize)
      try {
        await this.sendAppendWithRetry(chunk, 1)
      } catch {
        this.markFailed()
        return
      }
      this.bodyDelivered += chunk
      this.bodyBuffer = this.bodyBuffer.slice(chunk.length)
    }

    if (final && this.bodyStreamActive) {
      // 缓冲已冲刷完：补一个空终片标记流结束
      try {
        await this.sendFinalShard()
      } catch {
        this.markFailed()
      }
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
        this.bodyBuffer !== ""
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
          this.bodyBuffer !== "" ||
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
            contentType: "text",
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
