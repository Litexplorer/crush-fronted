/**
 * system-metrics.ts
 * 核心流程：对接 GET /v1/system/metrics（全局 host 指标，不按 workspace 划分）——
 *           字段对应 internal/proto/system.go；CPU 与网卡速率由服务端用两次采样差值算出，
 *           因此轮询间隔不要低于 500ms（服务端会复用缓存快照，返回相同的 sampled_at）。
 */
import { httpGet } from "./http"

export interface SystemHost {
  hostname: string
  platform: string
  num_cpu: number
  uptime_s: number
}

export interface SystemCPU {
  percent: number
  per_core: number[]
  load1: number
  load5: number
  load15: number
}

export interface SystemMemory {
  total_bytes: number
  used_bytes: number
  available_bytes: number
  percent: number
  swap_total_bytes: number
  swap_used_bytes: number
}

export interface SystemDisk {
  mount: string
  fs_type: string
  total_bytes: number
  used_bytes: number
  free_bytes: number
  percent: number
}

export interface SystemNetwork {
  name: string
  rx_bytes_per_sec: number
  tx_bytes_per_sec: number
  rx_total_bytes: number
  tx_total_bytes: number
}

export interface SystemMetrics {
  sampled_at: number
  interval_ms: number
  warming: boolean
  supported: boolean
  reason?: string
  host: SystemHost
  cpu: SystemCPU
  memory: SystemMemory
  disks: SystemDisk[]
  networks: SystemNetwork[]
}

/**
 * getSystemMetrics
 * 参数：无
 * 核心流程：GET /system/metrics → 归一空数组，避免后端返回 null 时前端 For 报错
 */
export async function getSystemMetrics(): Promise<SystemMetrics> {
  const data = await httpGet<SystemMetrics>("/system/metrics")
  return {
    ...data,
    cpu: { ...data.cpu, per_core: data.cpu?.per_core ?? [] },
    disks: data.disks ?? [],
    networks: data.networks ?? [],
  }
}
