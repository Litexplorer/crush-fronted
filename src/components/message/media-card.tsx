/**
 * media-card.tsx
 * 参数：source classifyMedia 的分类结果（url / kind / name / host）
 * 核心流程：头部（种类徽标 + 名称 + host + 新窗口打开）→ 正文按 kind 分派 ——
 *           音频/视频用原生播放器（preload 不预取，避免一条会话里批量开流）、
 *           图片交给 ImagePreview（缩略图 + 全屏）、pdf/html/page 只保留链接态；
 *           媒体加载失败（跨域、防盗链、mixed-content）时降级成提示 + 链接，不留空白播放器。
 */
import { createSignal, Match, Show, Switch } from "solid-js"
import { kindLabel, type MediaSource } from "../../lib/media-kind"
import ImagePreview from "./image-preview"

/**
 * formatDuration
 * 参数：seconds 音频/视频时长（秒）
 * 核心流程：换算成 m:ss，非有限值或负数返回空串
 */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ""
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, "0")}`
}

export default function MediaCard(props: { source: MediaSource }) {
  const [failed, setFailed] = createSignal(false)
  const [duration, setDuration] = createSignal(0)

  // 只有用户点开播放才会真正拉流；失败时整体降级成链接，避免卡在空播放器
  const meta = () => formatDuration(duration())

  return (
    <div class="media-card">
      <div class="media-card-bar">
        <span class="media-card-kind">{kindLabel(props.source.kind)}</span>
        <span class="media-card-name" title={props.source.url}>
          {props.source.name}
        </span>
        <Show when={duration() > 0}>
          <span class="media-card-meta">{meta()}</span>
        </Show>
        <span class="media-card-host">{props.source.host}</span>
        <a class="media-card-open" href={props.source.url} target="_blank" rel="noopener noreferrer">
          Open
        </a>
      </div>
      <Switch>
        <Match when={props.source.kind === "audio" && !failed()}>
          <div class="media-card-body">
            <audio
              class="media-card-audio"
              src={props.source.url}
              controls
              preload="none"
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
              onError={() => setFailed(true)}
            />
          </div>
        </Match>
        <Match when={props.source.kind === "video" && !failed()}>
          <div class="media-card-body">
            <video
              class="media-card-video"
              src={props.source.url}
              controls
              preload="metadata"
              playsinline
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
              onError={() => setFailed(true)}
            />
          </div>
        </Match>
        <Match when={props.source.kind === "image"}>
          <div class="media-card-body media-card-image">
            <ImagePreview src={props.source.url} alt={props.source.name} maxHeight={320} />
          </div>
        </Match>
        <Match when={failed()}>
          <div class="media-card-hint">Media could not be loaded (blocked or offline). Use Open to view it directly.</div>
        </Match>
      </Switch>
    </div>
  )
}
