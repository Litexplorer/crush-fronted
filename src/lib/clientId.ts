/**
 * clientId.ts
 * 核心流程：生成并持久化客户端 UUID —— 首次生成写入 localStorage，
 *           之后始终复用，保证跨导航是同一个 client
 */

const STORAGE_KEY = "crush_client_id"

let cached: string | null = null

/**
 * randomUuid
 * 参数：无
 * 核心流程：优先 crypto.randomUUID；非安全上下文（http）下退化为 v4 随机 UUID
 */
export function randomUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  // 非安全上下文回退：手工拼 v4 UUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * getClientId
 * 参数：无
 * 核心流程：内存缓存优先 → 读 localStorage → 未命中则生成并落盘
 */
export function getClientId(): string {
  if (cached) return cached

  let value = localStorage.getItem(STORAGE_KEY)
  if (!value) {
    // 生成新 UUID 并持久化，供后端 requireClientID / validateClientID 校验
    value = randomUuid()
    localStorage.setItem(STORAGE_KEY, value)
  }

  cached = value
  return value
}
