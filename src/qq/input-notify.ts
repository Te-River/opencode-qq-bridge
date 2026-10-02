// @input:  ./api (getAccessToken, sendC2CInputNotify), ./types (MessageContext), ../config (Config)
// @output: startInputNotify, InputNotifyHandle
// @pos:    qq层 - C2C「正在输入」状态生命周期（回合开始提示 → 期间续发 → 结束消退）
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
 * - 回合开始立即发一次 input_notify（input_second = 配置值，默认 10）
 * - 期间每 input_second × 0.8 续发一次（状态到期前刷新，不留空窗）
 * - stop()：清定时器 + 发 input_second=1 加速消退（该调用失败靠短时长自然过期兜底）
 *
 * 预算安全：所有调用不带 msg_id —— 该端点 msg_id 可选，带上会占被动回复预算，
 * 威胁流式开流预算（MAX_STREAM_OPENS 的算术）。发送失败仅 console.error 一次
 * （防刷屏），不影响回合主流程。
 */
export function startInputNotify(ctx: MessageContext, config: Config): InputNotifyHandle {
  if (ctx.type !== "c2c" || !config.inputNotify.enabled) {
    return { stop: () => Promise.resolve() }
  }

  const seconds = config.inputNotify.seconds
  let timer: ReturnType<typeof setInterval> | null = null
  let stopped = false
  let loggedFailure = false

  const fire = async (inputSecond: number): Promise<void> => {
    try {
      const token = await getAccessToken(config.qq.appId, config.qq.clientSecret)
      await sendC2CInputNotify(token, ctx.userId, undefined, inputSecond)
    } catch (error) {
      if (!loggedFailure) {
        loggedFailure = true
        console.error(
          "[input-notify] 输入状态发送失败（本回合后续失败静默忽略）:",
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }

  void fire(seconds)

  timer = setInterval(() => {
    void fire(seconds)
  }, Math.round(seconds * 0.8 * 1000))
  timer.unref?.() // 不阻止进程退出

  return {
    stop: async () => {
      if (stopped) return
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      await fire(1)
    },
  }
}
