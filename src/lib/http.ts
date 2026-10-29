/**
 * http.ts
 * 核心流程：fetch 薄封装 —— baseURL 统一 /v1，请求/响应均为 JSON，
 *           非 2xx 时读取 {message} 并抛出 ApiError，网络异常抛固定文案
 */

/** 统一错误形状：后端 message + HTTP 状态码（供调用方按状态分支处理） */
export interface ApiError {
  message: string
  status?: number
}

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE"

/**
 * request
 * 参数：method HTTP 动词；path 以 / 开头的接口路径（相对 /v1）；body 可选 JSON 载荷
 * 核心流程：拼接 /v1 前缀发起 fetch → 解析 JSON 响应 → 非 2xx 抛 {message}，网络失败抛降级文案
 */
async function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    // 请求后端：/v1 由 vite 代理转发到 crush 服务
    res = await fetch(`/v1${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    // 网络层失败：连接拒绝 / DNS 等，无响应体可读
    throw { message: "Network request failed" } satisfies ApiError
  }

  const data: unknown = await res.json().catch(() => undefined)

  if (!res.ok) {
    // 后端错误体形如 proto.Error {message}
    const message =
      typeof data === "object" && data !== null && "message" in data && typeof data.message === "string"
        ? data.message
        : `Request failed with status ${res.status}`
    throw { message, status: res.status } satisfies ApiError
  }

  return data as T
}

export function httpGet<T>(path: string): Promise<T> {
  return request<T>("GET", path)
}

export function httpPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>("POST", path, body)
}

export function httpPut<T>(path: string, body: unknown): Promise<T> {
  return request<T>("PUT", path, body)
}

export function httpDelete<T>(path: string): Promise<T> {
  return request<T>("DELETE", path)
}
