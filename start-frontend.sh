#!/usr/bin/env bash
# crush-fronted 前端 dev server 常驻启停脚本：start | stop | restart | status
# 用 setsid 另起会话脱离父进程，终端/父进程退出不会带走前端
set -u

cd "$(dirname "$0")" || exit 1

PROJ="$(pwd)"
BUN="${BUN:-$(command -v bun || echo /root/.proto/tools/bun/1.3.11/bun)}"
HOST="${CRUSH_FRONTEND_HOST:-0.0.0.0}"
PORT="${CRUSH_FRONTEND_PORT:-8070}"
LOG="${CRUSH_FRONTEND_LOG:-/tmp/crush-frontend.log}"
PIDFILE="${CRUSH_FRONTEND_PID:-/tmp/crush-frontend.pid}"

# 参数：pid
# 核心流程：/proc 校验该 pid 是本项目的前端 dev 进程（bun run dev 或 vite）且工作目录就是本项目，避免 PID 复用误判/误杀
is_frontend() {
  [ -r "/proc/$1/cmdline" ] || return 1
  tr '\0' ' ' < "/proc/$1/cmdline" | grep -qE "vite|bun run dev" || return 1
  [ "$(readlink "/proc/$1/cwd" 2>/dev/null)" = "$PROJ" ]
}

# 参数：无
# 核心流程：读 pidfile → 进程活着且是本项目 vite → 输出 pid
managed_pid() {
  local pid
  pid=$(cat "$PIDFILE" 2>/dev/null) || return 1
  [ -n "$pid" ] && is_frontend "$pid" || return 1
  echo "$pid"
}

# 参数：无
# 核心流程：扫描所有 vite 进程，挑出工作目录为本项目但未写入 pidfile 的野进程
unmanaged_pids() {
  local pid out=""
  for pid in $(pgrep -f 'vite|bun run dev' 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    is_frontend "$pid" && out="$out $pid"
  done
  echo "$out"
}

# 参数：无
# 核心流程：从 ss 解析端口监听者，用于启动前判断端口是否已被占用
port_pids() {
  ss -lntp "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u | tr '\n' ' '
}

start() {
  local pid
  if pid=$(managed_pid); then
    echo "already running: pid $pid, port $PORT"
    return 0
  fi
  local ext
  ext=$(unmanaged_pids)
  if [ -n "$ext" ]; then
    echo "already running (unmanaged): pid$ext; run '$0 stop' first"
    return 1
  fi
  if [ -n "$(port_pids)" ]; then
    echo "port $PORT already in use by pid $(port_pids); abort"
    return 1
  fi
  rm -f "$PIDFILE"

  # 动作：setsid 新建会话 + nohup 忽略 SIGHUP + stdin 断开 → 结果：父进程/终端退出后前端仍常驻
  setsid /bin/sh -c "echo \$\$ > '$PIDFILE'; exec '$BUN' run dev --host '$HOST' --port '$PORT'" \
    </dev/null >>"$LOG" 2>&1 &

  local i
  for i in $(seq 1 60); do
    pid=$(cat "$PIDFILE" 2>/dev/null)
    [ -n "${pid:-}" ] && [ -n "$(port_pids)" ] && break
    sleep 0.5
  done
  if [ -z "${pid:-}" ] || ! is_frontend "$pid"; then
    echo "failed to start; see $LOG"
    rm -f "$PIDFILE"
    return 1
  fi
  if [ -z "$(port_pids)" ]; then
    echo "process $pid alive but port $PORT not listening; see $LOG"
    return 1
  fi
  echo "started: pid $pid, addr http://$HOST:$PORT, log $LOG"
}

stop() {
  local pid i ext
  pid=$(managed_pid) || {
    rm -f "$PIDFILE"
    ext=$(unmanaged_pids)
    if [ -n "$ext" ]; then
      echo "not managed by this script: pid$ext; kill it manually"
      return 1
    fi
    echo "not running"
    return 0
  }
  # 动作：按进程组杀（setsid 后 pid 即组长）→ 结果：vite 及其 esbuild 子进程一并退出
  /bin/kill -TERM -- "-$pid" 2>/dev/null || /bin/kill -TERM "$pid" 2>/dev/null
  for i in $(seq 1 20); do
    /bin/kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if /bin/kill -0 "$pid" 2>/dev/null; then
    /bin/kill -9 -- "-$pid" 2>/dev/null || /bin/kill -9 "$pid" 2>/dev/null
    echo "stopped (forced): pid $pid"
  else
    echo "stopped: pid $pid"
  fi
  rm -f "$PIDFILE"
}

status() {
  local pid
  if pid=$(managed_pid); then
    echo "running: pid $pid, addr http://$HOST:$PORT, log $LOG"
    return 0
  fi
  local ext
  ext=$(unmanaged_pids)
  if [ -n "$ext" ]; then
    echo "running (unmanaged): pid$ext"
    return 0
  fi
  if [ -n "$(port_pids)" ]; then
    echo "port $PORT held by pid $(port_pids), not managed by this script"
    return 0
  fi
  echo "stopped"
  return 3
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *)
    echo "usage: $0 {start|stop|restart|status}"
    exit 2
    ;;
esac
