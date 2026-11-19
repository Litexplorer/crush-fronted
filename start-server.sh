#!/usr/bin/env bash
# my-crush server 启停脚本：start | stop | restart | status
# workspace 在 SSE 断开后保留 604800s（7 天）；空闲也 7 天后才自我退出
set -u

# 动作：cd -P 把软链解析成物理路径 → 结果：BIN 与 /proc/<pid>/cmdline 里的真实 argv 完全一致
cd -P "$(dirname "$0")/.." || exit 1

BIN="$(pwd -P)/my-crush"
ADDR="${CRUSH_SERVER_ADDR:-tcp://0.0.0.0:9027}"
PORT="${ADDR##*:}"
LOG="${CRUSH_SERVER_LOG:-/tmp/crush-server.log}"
PIDFILE="${CRUSH_SERVER_PID:-/tmp/crush-server.pid}"

# 动作：直接赋值（不用 ${VAR:-默认}）→ 结果：上层 Crush 会话/父进程里残留的旧值不会静默覆盖这里
export CRUSH_SERVER_DETACH_GRACE=604800   # 最后一条 SSE 断开后，workspace 保活 7 天（默认 10s）
export CRUSH_SERVER_IDLE_TIMEOUT=604800   # 最后一个 workspace 拆掉后，服务再活 7 天（默认 60s）

# 参数：pid
# 核心流程：/proc 校验该 pid 确实是 my-crush，避免 PID 复用误杀/误判
is_server() {
  [ -r "/proc/$1/cmdline" ] && tr '\0' ' ' < "/proc/$1/cmdline" | grep -q "my-crush server"
}

# 参数：pid
# 核心流程：用 ss 校验该 pid 真的在监听 PORT → 进程活着不代表端口可用，空壳进程不算启动成功
is_listening() {
  ss -ltnp 2>/dev/null | grep -F ":${PORT} " | grep -qF "pid=$1,"
}

# 参数：无
# 核心流程：从 ss 里列出所有监听 PORT 的 pid → 端口占用是事实，不依赖进程 argv 里的路径
port_pids() {
  ss -ltnp 2>/dev/null | grep -F ":${PORT} " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
}

# 参数：无
# 核心流程：读 pidfile → 进程活着且是 my-crush → 输出 pid
managed_pid() {
  local pid
  pid=$(cat "$PIDFILE" 2>/dev/null) || return 1
  [ -n "$pid" ] && is_server "$pid" || return 1
  echo "$pid"
}

start() {
  local pid others i

  # 动作：pidfile 进程活着且真在监听 → 结果：直接判定已在运行
  if pid=$(managed_pid); then
    if is_listening "$pid"; then
      echo "already running: pid $pid, addr $ADDR"
      return 0
    fi
    # 动作：进程活着但端口没有 listener（上一轮端口被占留下的空壳）→ 结果：清掉它再重新拉起
    echo "stale shell detected: pid $pid alive but not listening on :$PORT; killing it"
    /usr/bin/kill -9 "$pid" 2>/dev/null
    sleep 0.5
  fi

  # 动作：按端口查真实占用者 → 结果：端口被别人占着就直接报错，不制造只活着不监听的假启动
  others=$(port_pids | tr '\n' ' ')
  others=$(echo $others)
  if [ -n "$others" ]; then
    echo "port :$PORT already in use by pid $others (not managed by this script); stop it before start"
    return 1
  fi

  rm -f "$PIDFILE"

  # 动作：setsid 另起会话 + 断开 stdin → 结果：终端/IDE 退出不再把 server 带走
  setsid /bin/sh -c "echo \$\$ > '$PIDFILE'; exec '$BIN' server -H '$ADDR'" \
    </dev/null >>"$LOG" 2>&1 &

  # 动作：等到端口真正 bind（实测冷启动 30~40s 才 listen）→ 结果：不再把"进程活着"当成"已启动"
  for i in $(seq 1 90); do
    pid=$(cat "$PIDFILE" 2>/dev/null)
    if [ -n "${pid:-}" ] && is_listening "$pid"; then
      echo "started: pid $pid, addr $ADDR, listening after ${i}s, log $LOG"
      return 0
    fi
    # 动作：进程已经退出 → 结果：立刻判失败，不用等满 90s
    if [ -n "${pid:-}" ] && ! is_server "$pid"; then
      echo "process exited during startup; tail of $LOG:"
      tail -5 "$LOG" 2>/dev/null
      rm -f "$PIDFILE"
      return 1
    fi
    sleep 1
  done

  # 动作：清理半启动进程 + 回滚 pidfile → 结果：不留空壳进程占着 pidfile 让下次误判
  pid=$(cat "$PIDFILE" 2>/dev/null)
  [ -n "${pid:-}" ] && /usr/bin/kill -9 "$pid" 2>/dev/null
  rm -f "$PIDFILE"
  echo "failed to start: nothing listening on :$PORT after 90s; tail of $LOG:"
  tail -5 "$LOG" 2>/dev/null
  return 1
}

stop() {
  local pid others i
  pid=$(managed_pid) || {
    rm -f "$PIDFILE"
    others=$(port_pids | tr '\n' ' ')
    others=$(echo $others)
    if [ -n "$others" ]; then
      echo "port :$PORT held by unmanaged pid $others; kill it manually"
      return 1
    fi
    echo "not running"
    return 0
  }
  /usr/bin/kill "$pid" 2>/dev/null
  for i in $(seq 1 20); do
    is_server "$pid" || break
    sleep 0.5
  done
  if is_server "$pid"; then
    /usr/bin/kill -9 "$pid" 2>/dev/null
    echo "stopped (forced): pid $pid"
  else
    echo "stopped: pid $pid"
  fi
  rm -f "$PIDFILE"
}

status() {
  local pid others
  if pid=$(managed_pid); then
    if is_listening "$pid"; then
      echo "running: pid $pid, addr $ADDR"
      return 0
    fi
    echo "degraded: pid $pid alive but nothing listening on :$PORT"
    return 1
  fi
  others=$(port_pids | tr '\n' ' ')
  others=$(echo $others)
  if [ -n "$others" ]; then
    echo "running (unmanaged): pid $others"
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
