// @input:  ./api (getAccessToken, sendC2CInputNotify), ./types (MessageContext), ../config (Config)
// @output: startInputNotify, InputNotifyHandle
// @pos:    qq层 - C2C「正在输入」状态（回合开始提示一次；预算零续发、零消退）
import { getAccessToken, sendC2CInputNotify } from "./api.js"
import type { MessageContext } from "./types.js"
import type { Config } from "../config.js"

/** 「正在输入」状态句柄：回合结束时调 stop()（幂等，成功/失败/异常路径都必须调） */
export interface InputNotifyHandle {
  stop: () => Promise<void>
}

/**
 * 启动「正在输入」状态提示（仅私聊 + INPUT_NOTIFY=on，其余返回 no-op 句柄）。
 *
 * 预算语义（真机 40034128 修复）：input_notify 带 msg_id 占被动回复名额，续发+消退
 * 会把 4 个名额吃光导致兜底回复失败。因此整回合只发一次（input_second = 配置值，
 * 默认 60 = 官方上限，覆盖绝大多数回合），不续发、stop() 不发任何请求（含
 * input_second=1 消退）——预算零占用：整回合恰好占 1 个名额，与 sender.ts 的
 * MAX_STREAM_OPENS 算术联动（INPUT_NOTIFY=on 时开流上限降为 2）。
 *
 * 取舍：超过 input_second（默认 60s）的回合状态自然消失——可接受，占位流的
 * 等待动画仍在提供视觉反馈；换来的是绝不挤占流式开流与兜底回复的名额。
 *
 * 锚定：调用带 msg_id（被动锚定到用户消息）——真机实测不带 msg_id 时 QQ 会渲染出
 * 一个内容为 "null" 的消息气泡；带上后渲染为纯状态。msg_seq 随机（getNextMsgSeq），
 * 去重安全。发送失败仅 console.error 一次，不影响回合主流程。
 */
export function startInputNotify(ctx: MessageContext, config: Config): InputNotifyHandle {
  if (ctx.type !== "c2c" || !config.inputNotify.enabled) {
    return { stop: () => Promise.resolve() }
  }

  const seconds = config.inputNotify.seconds
  void (async (): Promise<void> => {
    try {
      const token = await getAccessToken(config.qq.appId, config.qq.clientSecret)
      await sendC2CInputNotify(token, ctx.userId, ctx.msgId, seconds)
    } catch (error) {
      console.error(
        "[input-notify] 输入状态发送失败（忽略，不影响回合主流程）:",
        error instanceof Error ? error.message : String(error),
      )
    }
  })()

  return {
    stop: async () => {
      // 只清状态、不发任何请求（无定时器可清、无消退调用）：预算零占用
    },
  }
}
