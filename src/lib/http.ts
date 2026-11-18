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
 * REQUEST_TIMEOUT_MS
 * 单请求超时：连接被同源连接池排队或服务端半开时 fetch 会永不返回，
 * 没有超时调用方只能一直转圈（例如 @ 文件列表永远停在 Loading…）
 */
const REQUEST_TIMEOUT_MS = 20_000

/** 单请求可覆盖超时：同步等待大模型生成的接口（如会话压缩）远超 20s */
export interface RequestOptions {
  timeoutMs?: number
  /** 外部取消：路由切换时调用方用它叫停旧会话的大响应 */
  signal?: AbortSignal
}

/** 响应信封：data 为 JSON 主体，headers 供需要读响应头的接口（如分页游标）使用 */
export interface HttpResult<T> {
  data: T
  headers: Headers
}

/**
 * request
 * 参数：method HTTP 动词；path 以 / 开头的接口路径（相对 /v1）；body 可选 JSON 载荷；
 *       opts.timeoutMs 覆盖默认超时；opts.signal 外部取消
 * 核心流程：拼接 /v1 前缀发起 fetch（内部超时 + 外部 signal 合并）→ 解析 JSON 响应 →
 *           非 2xx 抛 {message}，网络失败/超时/被取消抛降级文案
 */
async function request<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  opts?: RequestOptions,
): Promise<HttpResult<T>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? REQUEST_TIMEOUT_MS)
  const external = opts?.signal
  // 外部取消（切换会话）要能叫停正在下载的大响应；已取消的 signal 直接照办
  const onExternalAbort = () => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener("abort", onExternalAbort, { once: true })
  }
  try {
    let res: Response
    try {
      // 请求后端：/v1 由 vite 代理转发到 crush 服务
      res = await fetch(`/v1${path}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch {
      // 网络层失败：连接拒绝 / DNS / 超时 / 被取消，无响应体可读
      throw {
        message: external?.aborted
          ? "请求已取消"
          : controller.signal.aborted
            ? "请求超时，请重试"
            : "Network request failed",
      } satisfies ApiError
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

    return { data: data as T, headers: res.headers }
  } finally {
    // 无论成功、失败还是超时都清掉计时器，避免悬挂的 abort 打到已结束的请求
    clearTimeout(timer)
    external?.removeEventListener("abort", onExternalAbort)
  }
}

export async function httpGet<T>(path: string, opts?: RequestOptions): Promise<T> {
  return (await request<T>("GET", path, undefined, opts)).data
}

/** GET 需要读响应头时用：返回 data 与 headers（分页 X-Has-More 等） */
export async function httpGetResult<T>(path: string, opts?: RequestOptions): Promise<HttpResult<T>> {
  return request<T>("GET", path, undefined, opts)
}

export async function httpPost<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
  return (await request<T>("POST", path, body, opts)).data
}

export async function httpPut<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
  return (await request<T>("PUT", path, body, opts)).data
}

export async function httpDelete<T>(path: string, opts?: RequestOptions): Promise<T> {
  return (await request<T>("DELETE", path, undefined, opts)).data
}
