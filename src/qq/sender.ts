// @input:  ./api (sendC2CMessage, sendGroupMessage), ./types (MessageContext)
// @output: replyToQQ, formatForQQ, splitMessage
// @pos:    qq层 - 消息发送 (Markdown格式化 + 分割 + 被动回复)
import { sendC2CMessage, sendGroupMessage, getNextMsgSeq, uploadC2CFile, uploadGroupFile, sendC2CMediaMessage, sendGroupMediaMessage } from "./api.js"
import { readFileSync, statSync } from "fs"
import { basename } from "path"
import type { MessageContext } from "./types.js"

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
