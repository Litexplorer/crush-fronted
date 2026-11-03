#!/usr/bin/env bash
# my-crush server 启停脚本：start | stop | restart | status
# workspace 在 SSE 断开后保留 1800s（默认 10s）
set -u

cd "$(dirname "$0")/.." || exit 1

BIN="$(pwd)/my-crush"
ADDR="${CRUSH_SERVER_ADDR:-tcp://0.0.0.0:9027}"
LOG="${CRUSH_SERVER_LOG:-/tmp/crush-server.log}"
PIDFILE="${CRUSH_SERVER_PID:-/tmp/crush-server.pid}"

export CRUSH_SERVER_DETACH_GRACE="${CRUSH_SERVER_DETACH_GRACE:-1800}"
export CRUSH_SERVER_IDLE_TIMEOUT="${CRUSH_SERVER_IDLE_TIMEOUT:-1800}"

# 参数：pid
# 核心流程：/proc 校验该 pid 确实是 my-crush，避免 PID 复用误杀/误判
is_server() {
  [ -r "/proc/$1/cmdline" ] && tr '\0' ' ' < "/proc/$1/cmdline" | grep -q "my-crush server"
}

# 参数：无
# 核心流程：读 pidfile → 进程活着且是 my-crush → 输出 pid
managed_pid() {
  local pid
  pid=$(cat "$PIDFILE" 2>/dev/null) || return 1
  [ -n "$pid" ] && is_server "$pid" || return 1
  echo "$pid"
}

# 参数：无
# 核心流程：列出未由本脚本启动的 my-crush server（例如旧的 while 循环）
unmanaged_pids() {
  pgrep -f "$BIN server" 2>/dev/null
}

start() {
  local pid
  if pid=$(managed_pid); then
    echo "already running: pid $pid, addr $ADDR"
    return 0
  fi
  local ext
  ext=$(unmanaged_pids || true)
  if [ -n "$ext" ]; then
    echo "already running (unmanaged): pid $(echo $ext); stop it before start"
    return 1
  fi
  rm -f "$PIDFILE"

  nohup "$BIN" server -H "$ADDR" >> "$LOG" 2>&1 &
  pid=$!
  echo "$pid" > "$PIDFILE"
  sleep 1
  if ! is_server "$pid"; then
    echo "failed to start; see $LOG"
    rm -f "$PIDFILE"
    return 1
  fi
  echo "started: pid $pid, addr $ADDR, log $LOG"
}

stop() {
  local pid i ext
  pid=$(managed_pid) || {
    rm -f "$PIDFILE"
    ext=$(unmanaged_pids || true)
    if [ -n "$ext" ]; then
      echo "not managed by this script: pid $(echo $ext); kill it manually"
      return 1
    fi
    echo "not running"
    return 0
  }
  kill "$pid" 2>/dev/null
  for i in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null
    echo "stopped (forced): pid $pid"
  else
    echo "stopped: pid $pid"
  fi
  rm -f "$PIDFILE"
}

status() {
  local pid
  if pid=$(managed_pid); then
    echo "running: pid $pid, addr $ADDR"
    return 0
  fi
  local ext
  ext=$(unmanaged_pids || true)
  if [ -n "$ext" ]; then
    echo "running (unmanaged): pid $(echo $ext)"
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
