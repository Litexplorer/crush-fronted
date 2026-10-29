/**
 * media-kind.ts
 * 核心流程：把一条 URL 分类成可预览的媒体种类 ——
 *           classifyMedia  只认 http(s)；按路径扩展名定 kind，未知扩展名归为 page
 *           kindLabel      种类徽标文案
 * 判定完全基于 URL 本身，不发任何网络请求：HEAD 探测会给每条链接增加一次外发，
 * 既慢又泄露意图，而扩展名已知的场景占绝大多数。
 */

export type MediaKind = "audio" | "video" | "image" | "pdf" | "html" | "page"

export interface MediaSource {
  url: string
  kind: MediaKind
  /** 卡片主标题：路径末段，缺失时用 host */
  name: string
  host: string
  /** 小写扩展名（不含点），无扩展名时为空串 */
  ext: string
}

const AUDIO_EXT = new Set(["mp3", "m4a", "wav", "ogg", "oga", "flac", "aac", "opus"])
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v", "ogv"])
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"])

/**
 * extensionOf
 * 参数：pathname URL 路径部分
 * 核心流程：取最后一个非空路径段的扩展名并小写化，取不到返回空串
 */
function extensionOf(pathname: string): string {
  const segment = pathname.split("/").filter(Boolean).pop() ?? ""
  const dot = segment.lastIndexOf(".")
  if (dot <= 0 || dot === segment.length - 1) return ""
  return segment.slice(dot + 1).toLowerCase()
}

/**
 * fileNameOf
 * 参数：pathname URL 路径部分
 * 核心流程：取最后一段作为标题，去掉常见查询噪音后再解码，失败时原样返回
 */
function fileNameOf(pathname: string): string {
  const segment = pathname.split("/").filter(Boolean).pop() ?? ""
  if (!segment) return ""
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * classifyMedia
 * 参数：raw 待判定的 URL
 * 核心流程：非 http(s)（含 javascript:、data:）一律返回 undefined，交给调用方保留原始链接；
 *           解析成功后按扩展名归类，认不出的扩展名按 page 处理（仍给链接卡）
 */
export function classifyMedia(raw: string): MediaSource | undefined {
  const value = raw.trim()
  if (!/^https?:\/\//i.test(value)) return undefined

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }

  const ext = extensionOf(parsed.pathname)
  const kind: MediaKind = AUDIO_EXT.has(ext)
    ? "audio"
    : VIDEO_EXT.has(ext)
      ? "video"
      : IMAGE_EXT.has(ext)
        ? "image"
        : ext === "pdf"
          ? "pdf"
          : ext === "html" || ext === "htm"
            ? "html"
            : "page"

  return {
    url: parsed.toString(),
    kind,
    name: fileNameOf(parsed.pathname) || parsed.host,
    host: parsed.host,
    ext,
  }
}

/**
 * kindLabel
 * 参数：kind 媒体种类
 * 核心流程：给出卡片头部的大写徽标文案
 */
export function kindLabel(kind: MediaKind): string {
  switch (kind) {
    case "audio":
      return "AUDIO"
    case "video":
      return "VIDEO"
    case "image":
      return "IMAGE"
    case "pdf":
      return "PDF"
    case "html":
      return "HTML"
    default:
      return "LINK"
  }
}
