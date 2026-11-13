/**
 * panel-system.tsx
 * 参数：无（host 指标是全局的，不随 workspace/session 变化）
 * 核心流程：右侧面板 System tab —— 每 2s 轮询 GET /v1/system/metrics，
 *           展示 CPU（总体 + 逐核 + 负载）、内存、磁盘各挂载点、网卡收发速率；
 *           CPU 占用与网卡速率在组件内保留最近 60 个采样点画迷你走势图；
 *           后端返回 supported=false（非 Linux）时直接展示原因，不渲染一堆 0
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { getSystemMetrics, type SystemMetrics } from "../lib/system-metrics"

/** 轮询间隔：服务端差分窗口最小 500ms，2s 既能看清趋势又不至于压满连接 */
const POLL_MS = 2000
/** 走势图保留的采样点数量（约 2 分钟） */
const HISTORY_POINTS = 60

/**
 * formatBytes
 * 参数：n 字节数
 * 核心流程：1024 进制转 B/KB/MB/GB/TB，小于 100 保留一位小数
 */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = n
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

/**
 * formatRate
 * 参数：bytesPerSecond 每秒字节数
 * 核心流程：复用 formatBytes 再加 /s 后缀
 */
function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

/**
 * formatUptime
 * 参数：seconds 开机秒数
 * 核心流程：超过 1 天按「Nd Nh」、超过 1 小时按「Nh Nm」、否则「Nm」，突出量级而非精确值
 */
function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—"
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/**
 * pushSample
 * 参数：values 已有采样；value 新值
 * 核心流程：追加并裁掉超出 HISTORY_POINTS 的旧点，返回新数组（保持信号不可变更新）
 */
function pushSample(values: number[], value: number): number[] {
  const next = [...values, value]
  return next.length > HISTORY_POINTS ? next.slice(next.length - HISTORY_POINTS) : next
}

/**
 * Sparkline
 * 参数：values 采样序列；max 纵轴上限（不传则按序列最大值自适应）；class 颜色类
 * 核心流程：把序列映射成 0~100 的折线坐标；点不足两个时不画，避免出现一条竖直假线
 */
function Sparkline(props: { values: number[]; max?: number; class?: string }) {
  const points = createMemo(() => {
    const values = props.values
    if (values.length < 2) return ""
    const max = Math.max(props.max ?? 0, ...values, 1)
    return values
      .map((value, index) => {
        const x = (index / (values.length - 1)) * 100
        const y = 100 - Math.min(1, Math.max(0, value / max)) * 100
        return `${x.toFixed(2)},${y.toFixed(2)}`
      })
      .join(" ")
  })

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      class={`h-10 w-full ${props.class ?? "text-accent"}`}
      aria-hidden="true"
    >
      <polyline
        points={points()}
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
    </svg>
  )
}

/**
 * UsageBar
 * 参数：percent 占用百分比；tone 颜色（normal/accent）
 * 核心流程：横向进度条；超过 90% 统一转成警示红，提醒磁盘/内存告急
 */
function UsageBar(props: { percent: number; tone?: "accent" | "normal" }) {
  const width = () => `${Math.min(100, Math.max(0, props.percent)).toFixed(1)}%`
  const color = () =>
    props.percent >= 90
      ? "bg-[#e5484d]"
      : props.tone === "normal"
        ? "bg-[var(--color-muted)]"
        : "bg-accent"
  return (
    <div class="h-1.5 w-full overflow-hidden rounded-full bg-raised">
      <div class={`h-full rounded-full transition-[width] duration-500 ${color()}`} style={{ width: width() }} />
    </div>
  )
}

/**
 * MetricCard
 * 参数：title 标题；value 主数值；hint 右侧说明；children 额外内容
 * 核心流程：统一的卡片外壳 —— 标题行（标题 + 数值）与内容区
 */
function MetricCard(props: { title: string; value?: string; hint?: string; children?: JSX.Element }) {
  return (
    <div class="rounded-[8px] border border-edge bg-base/40 p-2.5">
      <div class="mb-1.5 flex items-baseline justify-between gap-2">
        <span class="text-[11px] font-medium tracking-wide text-muted uppercase">{props.title}</span>
        <span class="flex items-baseline gap-2">
          <Show when={props.hint}>
            <span class="text-[10px] text-faint">{props.hint}</span>
          </Show>
          <Show when={props.value}>
            <span class="text-[13px] font-medium text-text tabular-nums">{props.value}</span>
          </Show>
        </span>
      </div>
      {props.children}
    </div>
  )
}

/**
 * SystemTab
 * 参数：无
 * 核心流程：挂载即拉一次并起 2s 定时器，卸载时停表；
 *           每帧把 CPU 与网卡总速率追加进走势图序列，并用 sampled_at 去重（后端缓存命中时返回同一帧）
 */
export default function SystemTab() {
  const [snapshot, setSnapshot] = createSignal<SystemMetrics>()
  const [error, setError] = createSignal("")
  const [cpuHistory, setCpuHistory] = createSignal<number[]>([])
  const [rxHistory, setRxHistory] = createSignal<number[]>([])
  const [txHistory, setTxHistory] = createSignal<number[]>([])
  let lastSampledAt = 0

  const networkTotals = createMemo(() => {
    const networks = snapshot()?.networks ?? []
    let rx = 0
    let tx = 0
    for (const item of networks) {
      rx += item.rx_bytes_per_sec
      tx += item.tx_bytes_per_sec
    }
    return { rx, tx }
  })

  // 收发两条曲线共用同一个纵轴上限，否则各自缩放会让形状无法比较
  const networkCeiling = createMemo(() =>
    Math.max(...rxHistory(), ...txHistory(), 1),
  )

  onMount(() => {
    let alive = true

    const load = async () => {
      try {
        const data = await getSystemMetrics()
        if (!alive) return
        setSnapshot(data)
        setError("")
        // 后端缓存命中时 sampled_at 不变：同一帧不重复进走势图，否则曲线会被拉平
        if (data.sampled_at === lastSampledAt) return
        lastSampledAt = data.sampled_at
        setCpuHistory((values) => pushSample(values, data.cpu.percent))
        const totals = data.networks.reduce(
          (acc, item) => ({ rx: acc.rx + item.rx_bytes_per_sec, tx: acc.tx + item.tx_bytes_per_sec }),
          { rx: 0, tx: 0 },
        )
        setRxHistory((values) => pushSample(values, totals.rx))
        setTxHistory((values) => pushSample(values, totals.tx))
      } catch (err) {
        if (!alive) return
        const failure = err as { message?: string }
        setError(failure?.message ?? "Failed to load host metrics")
      }
    }

    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    onCleanup(() => {
      alive = false
      clearInterval(timer)
    })
  })

  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      <Show when={error()}>
        <div class="mx-3 mt-3 rounded-[6px] border border-[#e5484d]/40 bg-[#e5484d]/10 px-2.5 py-2 text-[11px] leading-4 text-[#e5484d]">
          {error()}
        </div>
      </Show>

      <Show
        when={snapshot()}
        fallback={<div class="px-3 py-6 text-center text-[12px] leading-4 text-faint">Collecting metrics…</div>}
      >
        {(snap) => (
          <div class="flex flex-col gap-2.5 p-3">
            {/* 主机信息：主机名 + 平台/核数/开机时长 */}
            <div class="flex items-baseline justify-between gap-2">
              <span class="truncate text-[12px] font-medium text-text" title={snap().host.hostname}>
                {snap().host.hostname}
              </span>
              <span class="shrink-0 text-[10px] text-faint">
                {snap().host.platform} · {snap().host.num_cpu} cores · up {formatUptime(snap().host.uptime_s)}
              </span>
            </div>

            <Show when={!snap().supported}>
              <div class="rounded-[6px] border border-edge bg-raised/40 px-2.5 py-2 text-[11px] leading-4 text-muted">
                {snap().reason ?? "Host metrics are not available on this platform"}
              </div>
            </Show>

            <Show when={snap().supported}>
              {/* CPU：总体占用 + 逐核柱状 + 1/5/15 分钟负载 */}
              <MetricCard title="CPU" value={`${snap().cpu.percent.toFixed(1)}%`} hint={`load ${snap().cpu.load1.toFixed(2)}`}>
                <Sparkline values={cpuHistory()} max={100} class="text-accent" />
                <UsageBar percent={snap().cpu.percent} />
                {/* 逐核占用：一根细柱一个核，至少留 6% 高度让空闲核也能看出位置 */}
                <div class="mt-2 flex h-10 items-end gap-[2px]">
                  <For each={snap().cpu.per_core}>
                    {(value, index) => (
                      <div
                        class="flex-1 rounded-[1px] bg-accent/70"
                        title={`core ${index()} · ${value.toFixed(1)}%`}
                        style={{ height: `${Math.min(100, Math.max(6, value)).toFixed(1)}%` }}
                      />
                    )}
                  </For>
                </div>
                <div class="mt-1.5 text-[10px] text-faint">
                  load {snap().cpu.load1.toFixed(2)} / {snap().cpu.load5.toFixed(2)} / {snap().cpu.load15.toFixed(2)}
                </div>
              </MetricCard>

              {/* 内存：已用/总量 + swap（有 swap 才展示） */}
              <MetricCard
                title="Memory"
                value={`${snap().memory.percent.toFixed(1)}%`}
                hint={`${formatBytes(snap().memory.used_bytes)} / ${formatBytes(snap().memory.total_bytes)}`}
              >
                <UsageBar percent={snap().memory.percent} />
                <div class="mt-1.5 flex justify-between text-[10px] text-faint">
                  <span>available {formatBytes(snap().memory.available_bytes)}</span>
                  <Show when={snap().memory.swap_total_bytes > 0}>
                    <span>
                      swap {formatBytes(snap().memory.swap_used_bytes)} / {formatBytes(snap().memory.swap_total_bytes)}
                    </span>
                  </Show>
                </div>
              </MetricCard>

              {/* 磁盘：逐个挂载点一行 */}
              <MetricCard title="Disk" hint={`${snap().disks.length} mounts`}>
                <div class="flex flex-col gap-2">
                  <For each={snap().disks}>
                    {(disk) => (
                      <div>
                        <div class="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
                          <span class="truncate text-text" title={`${disk.mount} (${disk.fs_type})`}>
                            {disk.mount}
                          </span>
                          <span class="shrink-0 text-faint tabular-nums">
                            {formatBytes(disk.used_bytes)} / {formatBytes(disk.total_bytes)} · {disk.percent.toFixed(1)}%
                          </span>
                        </div>
                        <UsageBar percent={disk.percent} tone="normal" />
                      </div>
                    )}
                  </For>
                </div>
              </MetricCard>

              {/* 网络：总吞吐走势 + 每张网卡当前速率 */}
              <MetricCard title="Network" hint={snap().warming ? "sampling…" : `window ${(snap().interval_ms / 1000).toFixed(1)}s`}>
                <Sparkline values={rxHistory()} max={networkCeiling()} class="text-accent" />
                <Sparkline values={txHistory()} max={networkCeiling()} class="text-[#46a758]" />
                <div class="mt-1 flex justify-between text-[10px]">
                  <span class="text-accent tabular-nums">↓ {formatRate(networkTotals().rx)}</span>
                  <span class="text-[#46a758] tabular-nums">↑ {formatRate(networkTotals().tx)}</span>
                </div>
                <div class="mt-2 flex flex-col gap-1">
                  <For each={snap().networks}>
                    {(item) => (
                      <div class="flex items-baseline justify-between gap-2 text-[11px]">
                        <span class="truncate text-text" title={`${item.name} · total ↓${formatBytes(item.rx_total_bytes)} ↑${formatBytes(item.tx_total_bytes)}`}>
                          {item.name}
                        </span>
                        <span class="shrink-0 text-faint tabular-nums">
                          ↓ {formatRate(item.rx_bytes_per_sec)} · ↑ {formatRate(item.tx_bytes_per_sec)}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </MetricCard>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}
