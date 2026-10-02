// @input:  undici-types (类型-only)
// @output: (全局类型补丁) Response / Request / RequestInit / Headers / FormData
// @pos:    根层 - 环境类型补丁（无运行时影响）
// 说明：@types/node@22.20 的 web-globals 用 `typeof globalThis extends { onmessage: any }`
// 条件类型派生 fetch 全局类型，在本仓库的 tsconfig（lib 无 DOM）+ TS 5.9 组合下解析为空接口，
// 导致 `res.ok` / `RequestInit.body` 等报 TS2339（main 分支即存在，非本次改动引入）。
// 这里直接从 undici-types 合并成员，恢复这些全局类型的完整定义。
import type {
  Response as UndiciResponse,
  Request as UndiciRequest,
  RequestInit as UndiciRequestInit,
  Headers as UndiciHeaders,
  FormData as UndiciFormData,
} from "undici-types"

declare global {
  interface Response extends UndiciResponse {}
  interface Request extends UndiciRequest {}
  interface RequestInit extends UndiciRequestInit {}
  interface Headers extends UndiciHeaders {}
  interface FormData extends UndiciFormData {}
}

export {}
