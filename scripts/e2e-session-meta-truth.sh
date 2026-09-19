#!/usr/bin/env bash
# ============================================================================
# e2e-session-meta-truth.sh —— 会话集合链路（session_meta 真相源）端到端验证
#
# 用途：检查「建会话即建全列行 / 事件链路落 last_reply / 读取侧零扫盘 / 任务归属 +
#   fork 子树继承 / 两区不重复 / 删任务连带子树」六条链路，并对真实 ~/.pi/agent 做
#   只读隔离性断言。失败即非零退出（可重复运行）。
#
# 前置条件：无（脚本自建隔离环境）。需要本机有 tmux / curl / sqlite3 / node，
#   以及可用的外网模型额度（Step 4 真的要发一次 prompt）。
#
# 执行方式：
#   bash scripts/e2e-session-meta-truth.sh                    # 默认 PORT=30155
#   PORT=30155 AGENT_DIR=/tmp/xxx PROJECT_DIR=/tmp/yyy bash scripts/e2e-session-meta-truth.sh
#   START_SERVER=0 ...   # 复用已在跑的 server（必须已存在 $AGENT_DIR/pi-web.db，脚本会跑绑定探针）
#
# 隔离声明（铁律，绝不碰真实 ~/.pi/agent）：
#   · PI_CODING_AGENT_DIR 与项目目录一律 mktemp 到 /tmp —— lib/sqlite-db.ts 的 dbPath()
#     走 getAgentDir()，所以 SDK 会话目录与 pi-web.db 全落在临时目录里
#   · 端口只用 30155，硬拒绝 30143/30141（用户实例）；绑定探针往临时库插一行，
#     必须能从该 server 的 API 读到（读不到 = 复用了绑真实 agent dir 的 server → 立即失败）
#   · 对真实 ~/.pi/agent 只读；硬证据是「真实库 session_meta 的 **id 集合差集**（before/mid/after
#     + 清理后多次）+ 本次测试 id 直查 + server 绑定证明」。真实库 md5 / -wal 指纹同时记录，
#     但**不是硬断言**：真实库 journal_mode=wal，主文件 md5 在未 checkpoint 前不会变（WAL 盲），
#     而 -wal 会因用户自己的实例在写而变化 → 只作 WARN + 打印。
#
# 耗时 / 成本：每次往 /tmp 克隆约 1GB 的 npm/（APFS clonefile，约 10s；不克隆则所有模型 402），
#   全程约 1–2 分钟且需要外网模型。KEEP=1 保留临时目录/日志以便取证（默认成功即删）。
#
# 输出：原始响应 JSON 落在 $OUT_DIR，默认 `$REPO_ROOT/.agent/tmp/e2e-raw`
#   （仓库工作区约定；可用 OUT_DIR= 覆盖）。
#
# 也可 `source` 本脚本（不会执行 main），用于复用其中的断言函数写 RED 自检：
#   见 scripts/e2e-session-meta-truth-red.sh。
#
# 验证内容（全部只操作本脚本自己创建的测试数据）：
#   1. 建会话即建「全列」session_meta 行（path/cwd/project_key/created 齐全）
#   2. 事件驱动落库：agent_settled → last_reply 非空 + modified 在最近 60s
#   3. 读取侧零扫盘：GET /api/sessions?project= 的 lastReply 来自库（哨兵证据 +
#      引用 lib/session-reader.noscan.test.mjs 作为机械证据）
#   4. 任务归属：POST /api/tasks + assign-session → 行 task_id 正确
#   5. fork 归属继承（V1 修复）：子会话 task_id 与父相同、parent_id = 父 id
#   6. 两区不重复（原 bug 回归）：子会话只在任务区，聊天区不含父/子
#   7. 清理：DELETE 任务连带删会话 → 停 server → 删临时目录
# ============================================================================
set -euo pipefail

# 固定为 C locale：macOS 自带的 bash 3.2 在 UTF-8 locale（如 zh_CN.UTF-8）下会把紧跟
# 变量的多字节字符当成变量名的一部分（`"$V（括号）"` → `V（: unbound variable`）。
# 本脚本会大量输出中文，不固定 locale 就会在中文标点处随机炸掉。
# 同时所有紧邻非 ASCII 的变量引用仍一律写 `${VAR}`（双保险，与调用者环境无关）。
export LC_ALL=C

PORT=${PORT:-30155}
BASE_URL=${BASE_URL:-http://127.0.0.1:${PORT}}
AGENT_DIR=${AGENT_DIR:-}
PROJECT_DIR=${PROJECT_DIR:-}
# 运行 id：tmux 会话名/日志名带 run id，两次并发运行不会互杀会话/交叉写日志
RUN_ID=${RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}
TMUX_SESSION=${TMUX_SESSION:-piweb-e2e-${RUN_ID}}
SERVER_LOG=${SERVER_LOG:-/tmp/piweb-e2e-${PORT}-${RUN_ID}.log}
REAL_AGENT_DIR=${REAL_AGENT_DIR:-$HOME/.pi/agent}
REAL_DB=${REAL_DB:-$REAL_AGENT_DIR/pi-web.db}
START_SERVER=${START_SERVER:-1}
RUN_NOSCAN_TEST=${RUN_NOSCAN_TEST:-1}
WAIT_SERVER_SECS=${WAIT_SERVER_SECS:-180}
WAIT_REPLY_SECS=${WAIT_REPLY_SECS:-150}
PROMPT_TEXT=${PROMPT_TEXT:-只回复两个字：收到}
KEEP=${KEEP:-0}

# 本脚本现在住在 scripts/（仓库根下一层）：REPO_ROOT = 本文件所在目录的父目录。
# 用 BASH_SOURCE 而不是 $0：被 e2e-session-meta-truth-red.sh `source` 时 $0 是它的路径。
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)
OUT_DIR=${OUT_DIR:-$REPO_ROOT/.agent/tmp/e2e-raw}

# ── 运行时状态 ──────────────────────────────────────────────────────────────
OWN_AGENT_DIR=0
OWN_PROJECT_DIR=0
STARTED_SERVER=0
SERVER_READY=0
FINISHED=0
FAILURES=0
STEP_NO=0
TASK_ID=""
SESSION_ID=""
CHILD_ID=""
CONTROL_ID=""
PROBE_ID=""
PK=""
HARD_FAILURES=0
WARN_COUNT=0
ASSERTIONS=0
REAL_IDS_BEFORE_FILE=""
REAL_DB_DRIFT=0

say()   { printf '%s\n' "$*"; }
hr()    { say "──────────────────────────────────────────────────────────────"; }
step()  { STEP_NO=$((STEP_NO + 1)); hr; say "STEP $STEP_NO: $*"; hr; }
ok()    { ASSERTIONS=$((ASSERTIONS + 1)); say "  ✔ $*"; }
info()  { say "  · $*"; }
die()   { say "  ✘ $*"; FAILURES=$((FAILURES + 1)); HARD_FAILURES=$((HARD_FAILURES + 1)); say "FATAL: $*"; exit 1; }
warn()  { WARN_COUNT=$((WARN_COUNT + 1)); say "  ⚠ $*"; }

# ── 工具函数 ────────────────────────────────────────────────────────────────
file_md5() {
  if command -v md5 >/dev/null 2>&1; then md5 -q "$1"; else md5sum "$1" | awk '{print $1}'; fi
}
sql_real() { sqlite3 -readonly "$REAL_DB" "$1"; }
sql_ephemeral() { sqlite3 "$AGENT_DIR/pi-web.db" "$1"; }
# 从 JSON 文件里取字段：$1=文件 $2=对 `j` 求值的 JS 表达式
jqq() {
  node -e '
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const v = eval(process.argv[2]);
    if (v === undefined || v === null) { process.stdout.write(""); }
    else if (typeof v === "string") { process.stdout.write(v); }
    else { process.stdout.write(JSON.stringify(v)); }
  ' "$1" "$2"
}
assert_eq() {
  if [ "$1" != "$2" ]; then die "$3: actual [$1] != expected [$2]"; fi
  ok "$3 = [$1]"
}
assert_ne() {        # $1=实际 $2=参考 $3=标签
  if [ "$1" = "$2" ]; then die "$3: 值不应相等，但都是 [$1]"; fi
  ok "$3 = [$1] (≠ [$2])"
}
assert_nonempty() {  # $1=值 $2=标签
  if [ -z "$1" ]; then die "$2: 为空"; fi
  ok "$2 = [$1]"
}
assert_zero() {      # $1=值 $2=标签
  if [ "$1" != "0" ]; then die "$2: 期望 0，实际 [$1]"; fi
  ok "$2 = 0"
}
# 文件内计数：返回数字，**不把「文件不存在」的臭名昭著的空输出当成 0**。
# 背景：`hits=$(grep -c X f || true)` 在 f 不存在时什么都不输出 → ${hits:-0} 得 0
# → 「文件里没有 X」的空断言空通过。这里把三种异常（文件不存在/无输出/非数字）
# 全变成硬失败，并单独提供控制组断言（必须先能 grep 到真实回复文本）。
file_hit_count() {   # $1=模式 $2=文件 → 数字 | MISSING | NULL
  if [ ! -f "$2" ]; then printf 'MISSING'; return 0; fi
  local n
  n=$(grep -cF "$1" "$2" 2>/dev/null || true)
  if [ -z "$n" ]; then printf 'NULL'; else printf '%s' "$n"; fi
}
assert_file_lacks() {     # $1=模式 $2=文件 $3=标签 → 必须为 0
  local n
  n=$(file_hit_count "$1" "$2")
  case "$n" in
    MISSING) die "$3: 文件不存在（grep -c 空输出会假通过）: $2" ;;
    NULL|'') die "$3: grep -c 无输出（无法证明）: $2" ;;
    *[!0-9]*) die "$3: grep -c 输出非法 [$n]: $2" ;;
  esac
  assert_zero "$n" "$3"
}
assert_file_contains() {  # $1=模式 $2=文件 $3=标签 → 必须 ≥1（控制组）
  local n
  n=$(file_hit_count "$1" "$2")
  case "$n" in
    MISSING) die "$3: 文件不存在: $2" ;;
    NULL|'') die "$3: grep -c 无输出: $2" ;;
    *[!0-9]*) die "$3: grep -c 输出非法 [$n]: $2" ;;
  esac
  if [ "$n" -lt 1 ]; then die "$3: 文件里找不到 [$1]: $2"; fi
  ok "$3 = $n 次（≥1）"
}
curl_get() {  # $1=url $2=输出文件
  local code
  code=$(curl -sS -o "$2" -w '%{http_code}' "$1")
  if [ "$code" != "200" ]; then die "GET $1 → HTTP $code ($(head -c 300 "$2"))"; fi
  info "GET $1 → 200  (raw: $2)"
}
curl_post() { # $1=url $2=json body $3=输出文件 $4=期望状态码（默认 200）
  local code expected
  expected=${4:-200}
  code=$(curl -sS -o "$3" -w '%{http_code}' -X POST "$1" -H 'content-type: application/json' -d "$2")
  if [ "$code" != "$expected" ]; then die "POST $1 → HTTP $code（期望 $expected） ($(head -c 300 "$3"))"; fi
  info "POST $1 ← $2 → $code  (raw: $3)"
}

# ── guard：绝不碰真实数据 / 真实端口 ────────────────────────────────────────
guard() {
  case "$PORT" in
    30143|30141) die "拒绝使用真实端口 ${PORT}（用户正在运行的实例）" ;;
  esac
  if [ -n "$AGENT_DIR" ]; then
    local resolved
    resolved=$(cd "$AGENT_DIR" 2>/dev/null && pwd || printf '%s' "$AGENT_DIR")
    case "$resolved" in
      "$REAL_AGENT_DIR"|"$REAL_AGENT_DIR"/*) die "拒绝把 AGENT_DIR 指向真实 agent 目录: $resolved" ;;
    esac
    case "$resolved" in
      /tmp/*|/var/folders/*|"$TMPDIR"*) : ;;
      *) die "AGENT_DIR 必须是临时目录（/tmp 或 \$TMPDIR 下）：$resolved" ;;
    esac
  fi
  if [ -n "$PROJECT_DIR" ]; then
    case "$PROJECT_DIR" in
      /tmp/*|/var/folders/*) : ;;
      *) die "PROJECT_DIR 必须是临时目录：$PROJECT_DIR" ;;
    esac
  fi
}

setup_dirs() {
  step "隔离环境准备"
  if [ -z "$AGENT_DIR" ]; then
    AGENT_DIR=$(mktemp -d /tmp/piweb-e2e-agent-XXXXXX); OWN_AGENT_DIR=1
  fi
  if [ -z "$PROJECT_DIR" ]; then
    PROJECT_DIR=$(mktemp -d /tmp/piweb-e2e-proj-XXXXXX); OWN_PROJECT_DIR=1
  fi
  mkdir -p "$AGENT_DIR" "$PROJECT_DIR" "$OUT_DIR"
  info "AGENT_DIR   = $AGENT_DIR (own=$OWN_AGENT_DIR)"
  info "PROJECT_DIR = $PROJECT_DIR (own=$OWN_PROJECT_DIR)"

  # 凭据/配置：只读复制，绝不写回真实目录
  local f
  for f in auth.json models.json settings.json; do
    if [ -f "$REAL_AGENT_DIR/$f" ]; then
      cp "$REAL_AGENT_DIR/$f" "$AGENT_DIR/$f"
      info "copied $f ($(wc -c < "$AGENT_DIR/$f" | tr -d ' ') bytes)"
    else
      info "skip $f (not present)"
    fi
  done
  # settings.json 的 packages（provider 扩展，如 pi-commandcode-provider）从
  # <agentDir>/npm 解析；缺了就没有可用模型凭据。用 APFS clone 复制（快、写时复制），
  # 失败退回普通复制。**不**用 symlink：SDK 若做 npm install 会写进用户真实目录。
  if [ ! -e "$AGENT_DIR/npm" ] && [ -d "$REAL_AGENT_DIR/npm" ]; then
    if /bin/cp -Rc "$REAL_AGENT_DIR/npm" "$AGENT_DIR/npm" 2>/dev/null; then
      info "cloned npm/ (APFS clonefile)"
    else
      cp -R "$REAL_AGENT_DIR/npm" "$AGENT_DIR/npm"
      info "copied npm/ (plain copy)"
    fi
  fi
  info "$AGENT_DIR 内容：$(ls "$AGENT_DIR" | tr '\n' ' ')"
}

# ── 真实数据指纹（前后对比 + 只读断言） ─────────────────────────────────────
# 重要：真实库是 journal_mode=wal，写入优先落在 -wal，**主文件 md5 在未 checkpoint 前
# 不会变** → 只看主文件 md5 是「WAL 盲」的。所以指纹同时抓三样：
#   · session_meta 的 id 集合（硬证据：本次测试 id 不得出现 + 集合差集）
#   · 主文件 md5/size/mtime
#   · -wal 的 size/md5/mtime（变化只作 WARN：用户自己的两个实例也在写真实库）
real_db_ids() {  # $1=输出文件（排序后的 id 清单）
  sqlite3 -readonly "$REAL_DB" "SELECT session_id FROM session_meta ORDER BY session_id" > "$1" 2>/dev/null || true
}

stat_mtime() { stat -f '%Sm' "$1" 2>/dev/null || stat -c '%y' "$1" 2>/dev/null || echo '?'; }

real_db_snapshot() {  # $1 = 标签（before/mid/after）；before 会把 id 清单存为基准
  local label=$1
  if [ ! -f "$REAL_DB" ]; then info "真实库不存在，跳过指纹($label): $REAL_DB"; return 0; fi
  local ids_file="$OUT_DIR/real-db-ids-$label.txt"
  real_db_ids "$ids_file"
  if [ "$label" = "before" ]; then REAL_IDS_BEFORE_FILE="$ids_file"; fi
  local wal="$REAL_DB-wal" wal_info="wal(不存在)"
  if [ -f "$wal" ]; then
    wal_info="wal(size=$(wc -c < "$wal" | tr -d ' ') md5=$(file_md5 "$wal") mtime=$(stat_mtime "$wal"))"
  fi
  say "  真实库 [$label] 主文件 md5=$(file_md5 "$REAL_DB") size=$(wc -c < "$REAL_DB" | tr -d ' ') mtime=$(stat_mtime "$REAL_DB")"
  say "                   $wal_info"
  say "                   session_meta id 数=$(wc -l < "$ids_file" | tr -d ' ')  清单=$ids_file"
}

# 硬断言：本次测试用过的任何 id/字串都不得出现在真实库里。
# 这是「没写真实库」的**判别性**证据：此刻临时库里这些行是活着的，若 server 绑的是
# 真实库，这里立即红（而清理后的计数断言对这种情况零区分度）。
assert_real_db_free_of_our_ids() {  # $1 = 阶段标签
  local phase=$1 hits
  hits=$(sql_real "SELECT COUNT(*) FROM session_meta WHERE session_id IN ('$SESSION_ID','$CHILD_ID','$CONTROL_ID','$PROBE_ID')" 2>/dev/null || echo "N/A")
  assert_zero "$hits" "真实库内本次测试会话 id 数（$phase）"
  hits=$(sql_real "SELECT COUNT(*) FROM session_meta WHERE session_id LIKE 'e2e-meta-%' OR session_id LIKE 'e2e-probe-%'" 2>/dev/null || echo "N/A")
  assert_zero "$hits" "真实库内 e2e-meta-*/e2e-probe-* 行数（$phase）"
  hits=$(sql_real "SELECT COUNT(*) FROM tasks WHERE id='$TASK_ID' OR name LIKE 'e2e-临时-%'" 2>/dev/null || echo "N/A")
  assert_zero "$hits" "真实库内 e2e-临时-* 任务数（$phase）"
  hits=$(sql_real "SELECT COUNT(*) FROM session_meta WHERE last_reply LIKE '%E2E-DB-SENTINEL%'" 2>/dev/null || echo "N/A")
  assert_zero "$hits" "真实库内哨兵字样行数（$phase）"
}

# id 集合差集（brief Step 4 要求）：先比【我们自己的 id 是否被添加】——硬失败；
# 再报整体差集：非我方新增（用户实例/扫描器在跑）只作 WARN 并计入汇总，否则会假红。
assert_real_db_id_diff() {  # $1 = 阶段标签
  local phase=$1
  if [ -z "$REAL_IDS_BEFORE_FILE" ] || [ ! -s "$REAL_IDS_BEFORE_FILE" ]; then
    die "真实库 id 基准清单为空（$REAL_IDS_BEFORE_FILE）——id 差集断言会空通过，拒绝继续"
  fi
  local now_file="$OUT_DIR/real-db-ids-$phase.txt"
  real_db_ids "$now_file"
  local added="$OUT_DIR/real-db-ids-$phase.added.txt" removed="$OUT_DIR/real-db-ids-$phase.removed.txt"
  comm -13 "$REAL_IDS_BEFORE_FILE" "$now_file" > "$added"
  comm -23 "$REAL_IDS_BEFORE_FILE" "$now_file" > "$removed"
  local n_added n_removed
  n_added=$(wc -l < "$added" | tr -d ' ')
  n_removed=$(wc -l < "$removed" | tr -d ' ')
  # 我方 id 被添加 → 一定是泄漏，硬失败。
  # 只看**本脚本自己的 id 前缀**（e2e-meta-/e2e-probe-）：真实库里就存在用户自己的
  # `e2e-subagent-001`（2026-09-16 建的），拿 `^e2e-` 当“我方”会因用户活动假红。
  assert_zero "$(grep -cE '^e2e-(meta|probe)-' "$added" || true)" "真实库新增 id 中的本次测试 id 数（$phase）"
  assert_zero "$n_removed" "真实库消失的会话 id 数（$phase）"
  if [ "$n_added" = "0" ]; then
    ok "真实库 session_meta id 集合差集为空（$phase：基准 $(wc -l < "$REAL_IDS_BEFORE_FILE" | tr -d ' ') 条）"
  else
    REAL_DB_DRIFT=1
    warn "真实库 session_meta 新增了 $n_added 条非本次测试 id（$phase）——用户自己的实例也在写真实库，无法单独归因；清单 $added"
    head -5 "$added" | sed 's/^/      /'
  fi
}

# 绑定探针：往临时库插一行探针（只写临时库），必须能从该 server 的 API 读到
# → 证明 server 读的就是 $AGENT_DIR/pi-web.db。
# 这是 START_SERVER=0 复用模式的关键防线：万一把任务发给了真实实例，
# 后面所有写请求（建会话/发消息/建任务）都会落到真实库。
probe_server_binding() {
  PROBE_ID="e2e-probe-$(date +%s)-$$"
  local now_ms
  now_ms=$(sql_ephemeral "SELECT CAST(strftime('%s','now') AS INTEGER)*1000")
  sql_ephemeral "INSERT INTO session_meta (session_id, updated, pinned, path, cwd, project_key, created, modified) VALUES ('$PROBE_ID', $now_ms, 0, '/nonexistent/$PROBE_ID.jsonl', '$PROJECT_DIR', '$PROJECT_DIR', $now_ms, $now_ms)"
  info "绑定探针：往 $AGENT_DIR/pi-web.db 插一行 $PROBE_ID，看 server 能不能读到"
  curl_get "$BASE_URL/api/sessions" "$OUT_DIR/00-binding-probe.json"
  local seen
  seen=$(jqq "$OUT_DIR/00-binding-probe.json" "[...j.sessions].some(s=>s.id==='$PROBE_ID')")
  if [ "$seen" != "true" ]; then
    die "绑定探针失败：server（$BASE_URL）读不到临时库里的探针行 → 它很可能绑的是另一个 agent dir（甚至真实 ~/.pi/agent）。拒绝继续，未发出任何业务写请求"
  fi
  ok "server 绑定 ${AGENT_DIR}（探针行可见）"
  sql_ephemeral "DELETE FROM session_meta WHERE session_id='$PROBE_ID'"
  assert_zero "$(sql_ephemeral "SELECT COUNT(*) FROM session_meta WHERE session_id='$PROBE_ID'")" "探针行已从临时库删除"
}

start_server() {
  step "启动 dev server（tmux 异步，PI_CODING_AGENT_DIR=临时目录）"
  local pre_code
  pre_code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/home" 2>/dev/null || true)
  if [ "$START_SERVER" != "1" ]; then
    # 复用模式（上一轮刚跑完、server 仍在）：必须先确认待复用的 server 绑的就是临时库。
    # 只查「文件存在」还是不够，所以下面 unconditional 跑绑定探针。
    if [ ! -f "$AGENT_DIR/pi-web.db" ]; then
      die "START_SERVER=0（复用模式）要求 $AGENT_DIR/pi-web.db 已存在——否则无法确认复用对象绑定哪个 agent dir，拒绝发出任何写请求"
    fi
    if [ "$pre_code" != "200" ]; then
      die "START_SERVER=0 但 $BASE_URL 没有 server 在响应（HTTP $pre_code）"
    fi
    info "START_SERVER=0 → 复用已在 $BASE_URL 上的 server（已确认 $AGENT_DIR/pi-web.db 存在）"
  else
    # 必须用 `=` 前缀精确匹配：tmux 的 -t 默认做前缀匹配，`-t piweb-e2e` 会把
    # 名叫 `piweb-e2e-run` 的会话一起干掉（开发时踩过——脚本把自己的 tmux 会话杀了）。
    if [ -n "${TMUX:-}" ] && [ "$(tmux display-message -p '#S' 2>/dev/null)" = "$TMUX_SESSION" ]; then
      die "TMUX_SESSION=$TMUX_SESSION 与本脚本运行所在的 tmux 会话同名，会自杀"
    fi
    if [ "$pre_code" = "200" ]; then
      die "端口 $PORT 上已有 server 在响应，而本脚本要用它自己的临时 server——拒绝默默复用一个未知实例（先停掉它，或显式用 START_SERVER=0 复用并让绑定探针验证）"
    fi
    tmux kill-session -t "=$TMUX_SESSION" 2>/dev/null || true
    tmux new -d -s "$TMUX_SESSION" "cd $REPO_ROOT && PI_CODING_AGENT_DIR=$AGENT_DIR PORT=$PORT node server.mjs > $SERVER_LOG 2>&1"
    STARTED_SERVER=1
    info "tmux session: $TMUX_SESSION   日志: $SERVER_LOG"
  fi
  local i code
  i=0
  while [ "$i" -lt "$WAIT_SERVER_SECS" ]; do
    code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/home" 2>/dev/null || true)
    if [ "$code" = "200" ]; then SERVER_READY=1; break; fi
    sleep 2; i=$((i + 2))
  done
  if [ "$SERVER_READY" != "1" ]; then
    say "  --- server 日志尾部 ---"; tail -30 "$SERVER_LOG" 2>/dev/null || true
    die "server 未在 ${WAIT_SERVER_SECS}s 内就绪 ($BASE_URL)"
  fi
  ok "server 就绪：${BASE_URL}（等待 ${i}s）"
  local real_refs
  real_refs=$(grep -c "$REAL_AGENT_DIR/pi-web.db" "$SERVER_LOG" 2>/dev/null || true)
  info "server 日志里提到真实库路径的次数：${real_refs:-0}（应为 0）"
}

cleanup() {
  local exit_code=$?
  hr
  say "清理"
  if [ "$STARTED_SERVER" = "1" ]; then
    tmux kill-session -t "=$TMUX_SESSION" 2>/dev/null && info "已停止 tmux $TMUX_SESSION" || info "tmux $TMUX_SESSION 已不在"
  fi
  # 日志带 run id、结束就删（失败时先把尾部抖进 transcript，便于排障且不留文件）
  if [ -f "$SERVER_LOG" ]; then
    if [ "$KEEP" = "1" ]; then
      info "KEEP=1 → 保留 server 日志 $SERVER_LOG"
    else
      if [ "$FINISHED" != "1" ]; then
        say "  --- server 日志尾部（$SERVER_LOG，删除前留下） ---"
        tail -20 "$SERVER_LOG" | sed 's/^/    /' || true
      fi
      rm -f "$SERVER_LOG" && info "已删 server 日志 $SERVER_LOG"
    fi
  fi
  if [ "$KEEP" = "1" ]; then
    info "KEEP=1 → 保留 $AGENT_DIR 与 $PROJECT_DIR"
  else
    [ "$OWN_AGENT_DIR" = "1" ] && { rm -rf "$AGENT_DIR"; info "已删临时 agent dir: $AGENT_DIR"; }
    [ "$OWN_PROJECT_DIR" = "1" ] && { rm -rf "$PROJECT_DIR"; info "已删临时项目目录: $PROJECT_DIR"; }
  fi
  hr
  if [ "$FINISHED" = "1" ] && [ "$FAILURES" = "0" ] && [ "$exit_code" = "0" ]; then
    say "结果：PASS（$STEP_NO 步，$ASSERTIONS 断言，$WARN_COUNT 警告，0 失败）"
    [ "$REAL_DB_DRIFT" = "1" ] && say "  （提示：真实库 id 集合有非本次测试 id 变动，见上面的 WARN 与 $OUT_DIR/real-db-ids-*）"
  else
    # 未跑到结尾（die / 信号 / 命令失败）也算失败：裸露的 EXIT 码可能为 0（如 SIGHUP）
    say "结果：FAIL（exit=$exit_code, failures=$FAILURES, finished=$FINISHED, steps=${STEP_NO}）"
    [ "$exit_code" = "0" ] && exit_code=1
  fi
  real_db_snapshot "after"
  [ "$KEEP" = "1" ] && say "（KEEP=1：临时目录保留在 $AGENT_DIR / ${PROJECT_DIR}）"
  # 注意：绝不能在这里 return 非零——EXIT trap 的返回码会覆盖 shell 的真实退出码
  # （bash 行为：trap 里最后一个命令的状态即最终状态）。
  if [ "$exit_code" != "0" ]; then exit "$exit_code"; fi
  return 0
}

# ── Step 1：建会话 → 断言全列行 ─────────────────────────────────────────────
step1_create_session() {
  step "建会话（ensure_session，指定 id）→ 断言 session_meta 全列行"
  SESSION_ID="e2e-meta-$(date +%s)"
  info "SESSION_ID = $SESSION_ID"
  curl_post "$BASE_URL/api/agent/new" \
    "{\"cwd\":\"$PROJECT_DIR\",\"type\":\"ensure_session\",\"id\":\"$SESSION_ID\"}" \
    "$OUT_DIR/01-agent-new.json"
  assert_eq "$(jqq "$OUT_DIR/01-agent-new.json" 'j.sessionId')" "$SESSION_ID" "agent/new 返回的 sessionId"

  local row
  row=$(sql_ephemeral "SELECT session_id||'|'||COALESCE(path,'<NULL>')||'|'||COALESCE(cwd,'<NULL>')||'|'||COALESCE(project_key,'<NULL>')||'|'||COALESCE(created,'<NULL>')||'|'||COALESCE(modified,'<NULL>') FROM session_meta WHERE session_id='$SESSION_ID'")
  info "行摘要 session_id|path|cwd|project_key|created|modified:"
  say "    $row"
  local sid path cwd pk created modified
  sid=$(printf '%s' "$row" | cut -d'|' -f1)
  path=$(printf '%s' "$row" | cut -d'|' -f2)
  cwd=$(printf '%s' "$row" | cut -d'|' -f3)
  pk=$(printf '%s' "$row" | cut -d'|' -f4)
  created=$(printf '%s' "$row" | cut -d'|' -f5)
  modified=$(printf '%s' "$row" | cut -d'|' -f6)
  assert_eq "$sid" "$SESSION_ID" "行存在"
  for v in "path:$path" "cwd:$cwd" "project_key:$pk" "created:$created" "modified:$modified"; do
    case "$v" in *"<NULL>") die "全列行为空: $v" ;; esac
  done
  ok "全列非空：path/cwd/project_key/created/modified 全部有值"
  assert_eq "$cwd" "$PROJECT_DIR" "行 cwd = \$PROJECT_DIR"
  PK=$pk
  assert_eq "$PK" "$PROJECT_DIR" "project_key（会话目录同源）"
  if [ -f "$path" ]; then ok "会话文件已落盘: $path"; else die "会话文件不存在: $path"; fi
  # created/modified 应是「刚刚」（证明来自建行链路，不是 1970 幽灵行）
  local age_ms
  age_ms=$(sql_ephemeral "SELECT (CAST(strftime('%s','now') AS INTEGER)*1000 - created) FROM session_meta WHERE session_id='$SESSION_ID'")
  if [ "$age_ms" -gt 60000 ]; then die "created 距今 ${age_ms}ms（>60s）——疑似幽灵行"; fi
  ok "created 距今 ${age_ms}ms（<60s）"
}

# ── Step 2：prompt → 事件驱动落库 ───────────────────────────────────────────
step2_prompt_event() {
  step "发短 prompt → 等 agent_settled → 断言 last_reply/modified 来自事件链路"
  local t0 t1
  t0=$(sql_ephemeral "SELECT CAST(strftime('%s','now') AS INTEGER)*1000")
  local scans_before
  scans_before=$(grep -c 'session index scan:' "$SERVER_LOG" 2>/dev/null || true); scans_before=${scans_before:-0}
  curl_post "$BASE_URL/api/agent/$SESSION_ID" \
    "{\"type\":\"prompt\",\"message\":\"$PROMPT_TEXT\"}" \
    "$OUT_DIR/02-prompt.json"
  local i reply
  i=0; reply=""
  while [ "$i" -lt "$WAIT_REPLY_SECS" ]; do
    reply=$(sql_ephemeral "SELECT COALESCE(last_reply,'') FROM session_meta WHERE session_id='$SESSION_ID'")
    [ -n "$reply" ] && break
    sleep 2; i=$((i + 2))
  done
  t1=$(sql_ephemeral "SELECT CAST(strftime('%s','now') AS INTEGER)*1000")
  local path
  path=$(sql_ephemeral "SELECT path FROM session_meta WHERE session_id='$SESSION_ID'")
  if [ -z "$reply" ]; then
    say "  --- 会话文件尾部（排障）---"; tail -3 "$path" 2>/dev/null | cut -c1-400 || true
    die "last_reply 在 ${WAIT_REPLY_SECS}s 内仍为空（模型调用失败？看上面的 stopReason/errorMessage）"
  fi
  assert_nonempty "$reply" "last_reply（事件链路写入）"
  info "prompt 到落库耗时约 $(( (t1 - t0) / 1000 ))s"
  local modified age
  modified=$(sql_ephemeral "SELECT modified FROM session_meta WHERE session_id='$SESSION_ID'")
  age=$((t1 - modified))
  if [ "$age" -gt 60000 ] || [ "$age" -lt 0 ]; then die "modified 距今 ${age}ms（要求 0..60000）"; fi
  ok "modified 距今 ${age}ms（<60s）→ 「最后活跃时间来自事件」"
  # 文件里确有同一条 assistant 文本（证明不是凭空写库）
  if grep -q "$reply" "$path" 2>/dev/null; then ok "会话文件里能找到同一条 assistant 文本"; else die "会话文件里找不到 last_reply 文本"; fi
  # 「不是扫描器写的」旁证（**弱旁证**，不单独构成证据）：
  #   · 只数真正的扫描结果行 `session index scan:`（带冒号），排除启动期的
  #     “session index scanner started”（旧版把两者一起数，几乎永远不会变）。
  #   · 即使这样，观测窗只有几秒、而首次 tick 在启动后立即发生，所以本项**很可能恒成立**，
  #     只能当弱旁证；真正的硬证据是上面「prompt → 落库耗时」远小于 30s 周期。
  #   · 先比一对控制组：窗口前的扫描行数必须 > 0（证明 grep 模式确实能匹配到扫描行）。
  local scans_after
  scans_after=$(grep -c 'session index scan:' "$SERVER_LOG" 2>/dev/null || true); scans_after=${scans_after:-0}
  if [ "$scans_before" -lt 1 ]; then
    warn "扫描日志模式匹配不到任何行（$scans_before）——本旁证无意义，忽略"
  elif [ "$scans_after" = "$scans_before" ]; then
    info "弱旁证：窗口内扫描结果行数无变化（$scans_before → $scans_after，扫描器 30s 一轮）"
  else
    warn "窗口内跑了索引扫描（$scans_before → $scans_after）——本步「事件驱动」证据减弱，需人看时序"
  fi
  # 注意：本步**没有**手工触发扫描器（未调 runSessionIndexScan、未等 30s tick 之外的额外动作）
}

# ── Step 3：读取侧零扫盘（哨兵证据）────────────────────────────────────────
step3_read_side() {
  step "读取侧零扫盘：GET /api/sessions?project= 的 lastReply 来自库"

  # (a) 归属任务之前，会话在聊天区 → 列表里应带 lastReply
  curl_get "$BASE_URL/api/sessions?project=$PK" "$OUT_DIR/03-sessions-chat.json"
  local list_reply db_reply
  list_reply=$(jqq "$OUT_DIR/03-sessions-chat.json" "j.sessions.find(s=>s.id==='$SESSION_ID').lastReply")
  db_reply=$(sql_ephemeral "SELECT last_reply FROM session_meta WHERE session_id='$SESSION_ID'")
  assert_eq "$list_reply" "$db_reply" "列表 lastReply == 库 last_reply"

  # (b) 哨兵：把「我们自己临时库」里该行的 last_reply 改成一个文件里绝不可能出现的字符串。
  #     若接口仍返回库值 → 读取路径走库，没读文件尾。（只写临时库，真实库只读）
  local sentinel="E2E-DB-SENTINEL-$(date +%s)"
  sql_ephemeral "UPDATE session_meta SET last_reply='$sentinel' WHERE session_id='$SESSION_ID'"
  curl_get "$BASE_URL/api/sessions?project=$PK" "$OUT_DIR/03b-sessions-sentinel.json"
  local sentinel_reply
  sentinel_reply=$(jqq "$OUT_DIR/03b-sessions-sentinel.json" "j.sessions.find(s=>s.id==='$SESSION_ID').lastReply")
  assert_eq "$sentinel_reply" "$sentinel" "哨兵值原样返回（只可能来自库）"
  # 非空性守卫：文件不存在时 grep -c 什么都不输出，${hits:-0} 会得 0 → 哨兵断言空通过。
  # assert_file_contains 先当控制组（同一 grep 能找到真实回复文本），再说哨兵 0 次。
  local path
  path=$(sql_ephemeral "SELECT path FROM session_meta WHERE session_id='$SESSION_ID'")
  assert_file_contains "$db_reply" "$path" "控制组：会话文件里能找到真实回复文本（证明下面那次 grep 有牙）"
  assert_file_lacks "$sentinel" "$path" "会话文件里出现哨兵次数（文件不是来源）"
  # 还原真实值，后续步骤继续用
  sql_ephemeral "UPDATE session_meta SET last_reply='$(printf '%s' "$db_reply" | sed "s/'/''/g")' WHERE session_id='$SESSION_ID'"
  ok "已还原库内 last_reply"

  # (c) 机械证据：T5/T2 单测（:memory: 库 + 临时目录，不碰真实数据）
  if [ "$RUN_NOSCAN_TEST" = "1" ]; then
    run_unit_test "lib/session-reader.noscan.test.mjs" "$OUT_DIR/03c-noscan-test.txt"
    ok "noscan 测试通过（列表/任务区/路径解析全部只查 session_meta）"
    run_unit_test "lib/session-index-scanner.test.mjs" "$OUT_DIR/03d-scanner-test.txt"
    ok "扫描器单测通过（子目录发现 + 归属收敛到父 + last_reply 回填 + modified 单调）"
  else
    info "RUN_NOSCAN_TEST=0 → 跳过单测"
  fi
}

# 跑单个单测文件（全部在临时目录 + :memory: 库，隔离）
run_unit_test() { # $1=测试文件 $2=输出文件
  info "机械证据：node --experimental-strip-types --test $1"
  if ! ( cd "$REPO_ROOT" && node --experimental-strip-types --test "$1" > "$2" 2>&1 ); then
    tail -20 "$2" | sed 's/^/    /'
    die "$1 失败（见 $2）"
  fi
  grep -E '^(ℹ|#) (tests|pass|fail)' "$2" | sed 's/^/    /' || true
}

# ── Step 4：建任务 + 归属 ───────────────────────────────────────────────────
step4_task_assign() {
  step "建任务 + 归属（projectKey 用会话的 project_key）"
  local name="e2e-临时-$(date +%s)"
  curl_post "$BASE_URL/api/tasks" \
    "{\"projectKey\":\"$PK\",\"name\":\"$name\"}" \
    "$OUT_DIR/04-task-create.json" 201
  TASK_ID=$(jqq "$OUT_DIR/04-task-create.json" 'j.task.id')
  assert_nonempty "$TASK_ID" "task.id"
  assert_eq "$(jqq "$OUT_DIR/04-task-create.json" 'j.task.name')" "$name" "task.name"

  curl_post "$BASE_URL/api/tasks/$TASK_ID/assign-session" \
    "{\"sessionId\":\"$SESSION_ID\"}" \
    "$OUT_DIR/04b-assign.json"
  local task_of_session
  task_of_session=$(sql_ephemeral "SELECT COALESCE(task_id,'<NULL>') FROM session_meta WHERE session_id='$SESSION_ID'")
  assert_eq "$task_of_session" "$TASK_ID" "会话行 task_id"
}

# ── Step 5：fork 归属继承（V1 修复）─────────────────────────────────────────
step5_fork() {
  step "fork 归属继承（V1）：子会话 task_id 与父相同 + parent_id = 父 id"
  curl_get "$BASE_URL/api/sessions/$SESSION_ID" "$OUT_DIR/05-session-detail.json"
  local leaf entry
  leaf=$(jqq "$OUT_DIR/05-session-detail.json" 'j.leafId')
  entry=$(jqq "$OUT_DIR/05-session-detail.json" "j.context.entryIds[j.context.entryIds.length-1]")
  assert_nonempty "$leaf" "leafId"
  assert_nonempty "$entry" "fork 用的 entryId（entryIds 末项）"
  info "entryIds = $(jqq "$OUT_DIR/05-session-detail.json" 'j.context.entryIds')"

  curl_post "$BASE_URL/api/agent/$SESSION_ID" \
    "{\"type\":\"fork\",\"entryId\":\"$entry\"}" \
    "$OUT_DIR/05b-fork.json"
  assert_eq "$(jqq "$OUT_DIR/05b-fork.json" 'j.data.cancelled')" "false" "fork 未取消"
  CHILD_ID=$(jqq "$OUT_DIR/05b-fork.json" 'j.data.newSessionId')
  assert_nonempty "$CHILD_ID" "newSessionId（子会话）"

  local parent_task child_task child_parent
  parent_task=$(sql_ephemeral "SELECT COALESCE(task_id,'<NULL>') FROM session_meta WHERE session_id='$SESSION_ID'")
  child_task=$(sql_ephemeral "SELECT COALESCE(task_id,'<NULL>') FROM session_meta WHERE session_id='$CHILD_ID'")
  child_parent=$(sql_ephemeral "SELECT COALESCE(parent_id,'<NULL>') FROM session_meta WHERE session_id='$CHILD_ID'")
  assert_eq "$child_task" "$parent_task" "子会话 task_id == 父 task_id"
  assert_eq "$child_parent" "$SESSION_ID" "子会话 parent_id == 父 id"
  info "子会话行：$(sql_ephemeral "SELECT session_id||' task='||COALESCE(task_id,'-')||' parent='||COALESCE(parent_id,'-')||' path='||COALESCE(path,'-') FROM session_meta WHERE session_id='$CHILD_ID'")"
}

# ── Step 6：两区不重复（原 bug 回归）────────────────────────────────────────
step6_two_regions() {
  step "两区不重复：子会话只在任务区，聊天区不含父/子"
  # 先建一个「不归属任务」的控制会话：否则聊天区本就为空，
  # “聊天区不含父/子”就成了永真的空断言（回归测试必须有牙）。
  CONTROL_ID="e2e-meta-ctrl-$(date +%s)"
  info "CONTROL_ID（任务无关会话）= $CONTROL_ID"
  curl_post "$BASE_URL/api/agent/new" \
    "{\"cwd\":\"$PROJECT_DIR\",\"type\":\"ensure_session\",\"id\":\"$CONTROL_ID\"}" \
    "$OUT_DIR/06a-control-session.json"
  assert_eq "$(jqq "$OUT_DIR/06a-control-session.json" 'j.sessionId')" "$CONTROL_ID" "控制会话 sessionId"
  assert_eq "$(sql_ephemeral "SELECT COALESCE(task_id,'') FROM session_meta WHERE session_id='$CONTROL_ID'")" "" "控制会话无归属（聊天区候选）"

  curl_get "$BASE_URL/api/sessions?project=$PK" "$OUT_DIR/06-sessions-chat.json"
  curl_get "$BASE_URL/api/tasks?projectKey=$PK" "$OUT_DIR/06-tasks.json"

  local in_chat_parent in_chat_child in_chat_control
  in_chat_control=$(jqq "$OUT_DIR/06-sessions-chat.json" "[...j.sessions].some(s=>s.id==='$CONTROL_ID')")
  in_chat_parent=$(jqq "$OUT_DIR/06-sessions-chat.json" "[...j.sessions].some(s=>s.id==='$SESSION_ID')")
  in_chat_child=$(jqq "$OUT_DIR/06-sessions-chat.json" "[...j.sessions].some(s=>s.id==='$CHILD_ID')")
  assert_eq "$in_chat_control" "true" "聊天区含控制会话（证明这轮断言不是对空列表断言）"
  assert_eq "$in_chat_parent" "false" "聊天区不含父会话（已归属任务）"
  assert_eq "$in_chat_child" "false" "聊天区不含子会话（原 bug 回归点）"
  info "聊天区本轮 id 列表：$(jqq "$OUT_DIR/06-sessions-chat.json" 'JSON.stringify(j.sessions.map(s=>s.id))')"

  local task_child_parent task_child_present counts
  local task_json="$OUT_DIR/06-tasks.json"
  task_child_present=$(jqq "$task_json" "[...j.tasks].find(t=>t.id==='$TASK_ID').sessions.some(s=>s.id==='$CHILD_ID')")
  task_child_parent=$(jqq "$task_json" "[...j.tasks].find(t=>t.id==='$TASK_ID').sessions.find(s=>s.id==='$CHILD_ID').parentSessionId")
  assert_eq "$task_child_present" "true" "任务区含子会话"
  assert_eq "$task_child_parent" "$SESSION_ID" "任务区里 parentSessionId 指向父"
  counts=$(jqq "$task_json" "[...j.tasks].find(t=>t.id==='$TASK_ID').rootTotal + '/' + [...j.tasks].find(t=>t.id==='$TASK_ID').sessionTotal")
  assert_eq "$counts" "1/2" "该任务 rootTotal/sessionTotal（子会话不重复成根）"
}

# ── Step 7：清理自己的数据 ──────────────────────────────────────────────────
step7_cleanup_data() {
  step "清理测试数据：DELETE /api/tasks/[id]（连带删自己的会话）"
  local parent_path child_path
  parent_path=$(sql_ephemeral "SELECT COALESCE(path,'') FROM session_meta WHERE session_id='$SESSION_ID'")
  child_path=$(sql_ephemeral "SELECT COALESCE(path,'') FROM session_meta WHERE session_id='$CHILD_ID'")
  info "删前文件：父=$parent_path"
  info "删前文件：子=$child_path"
  local code
  code=$(curl -sS -o "$OUT_DIR/07-delete-task.json" -w '%{http_code}' -X DELETE "$BASE_URL/api/tasks/$TASK_ID")
  assert_eq "$code" "200" "DELETE /api/tasks/$TASK_ID HTTP"
  info "响应：$(cat "$OUT_DIR/07-delete-task.json")"
  local deleted
  deleted=$(jqq "$OUT_DIR/07-delete-task.json" 'JSON.stringify(j.deletedSessionIds)')
  info "deletedSessionIds = $deleted"
  assert_eq "$(jqq "$OUT_DIR/07-delete-task.json" "[...j.deletedSessionIds].includes('$SESSION_ID')")" "true" "deletedSessionIds 含父会话"
  assert_eq "$(jqq "$OUT_DIR/07-delete-task.json" "[...j.deletedSessionIds].includes('$CHILD_ID')")" "true" "deletedSessionIds 含子会话（子树连带）"
  assert_eq "$(jqq "$OUT_DIR/07-delete-task.json" "[...j.deletedSessionIds].includes('$CONTROL_ID')")" "false" "deletedSessionIds 不含控制会话（不误删非成员）"

  assert_zero "$(sql_ephemeral "SELECT COUNT(*) FROM session_meta WHERE session_id IN ('$SESSION_ID','$CHILD_ID')")" "库内父/子会话行（应为 0）"
  assert_zero "$(sql_ephemeral "SELECT COUNT(*) FROM tasks WHERE id='$TASK_ID'")" "库内任务行（应为 0）"
  # 会话文件也应被连带删除（deletedSessionIds 是文件删除的目标集）
  if [ -n "$parent_path" ] && [ -e "$parent_path" ]; then die "父会话文件仍在: $parent_path"; fi
  if [ -n "$child_path" ] && [ -e "$child_path" ]; then die "子会话文件仍在: $child_path"; fi
  ok "父/子会话文件均已删除（此前的路径已不存在）"

  # 控制会话（不属任务）不被任务删除连带，自己单独删
  local ctrl_code
  ctrl_code=$(curl -sS -o "$OUT_DIR/07b-delete-control.json" -w '%{http_code}' -X DELETE "$BASE_URL/api/sessions/$CONTROL_ID")
  assert_eq "$ctrl_code" "200" "DELETE /api/sessions/$CONTROL_ID HTTP"
  assert_zero "$(sql_ephemeral "SELECT COUNT(*) FROM session_meta WHERE session_id='$CONTROL_ID'")" "库内控制会话行（应为 0）"
  info "临时 agent dir 残留清单：$(ls "$AGENT_DIR" | tr '\n' ' ')"
}

# ── 收尾断言：真实数据未被改动 ─────────────────────────────────────────────
final_checks() {
  step "真实数据隔离性断言（只读，清理之后）"
  assert_real_db_free_of_our_ids "after"
  assert_real_db_id_diff "after"
  # 真实盘布局只读观察（不做任何写入）：子目录会话（forks/ 等）数量 —— T2 递归发现的目标
  local real_sessions="$REAL_AGENT_DIR/sessions"
  if [ -d "$real_sessions" ]; then
    local total nested
    total=$(find "$real_sessions" -name '*.jsonl' -type f 2>/dev/null | wc -l | tr -d ' ')
    nested=$(find "$real_sessions" -mindepth 2 -name '*.jsonl' -type f 2>/dev/null | wc -l | tr -d ' ')
    info "真实 sessions 目录（只读）：*.jsonl 共 ${total} 个，其中子目录（forks/ 等）内 ${nested} 个"
  else
    info "真实 sessions 目录不存在，跳过只读观察"
  fi
  if [ -f "$REAL_AGENT_DIR/pi-web.db" ]; then
    say "  真实库 md5(after)（仅主文件，WAL 见上面的指纹行）= $(file_md5 "$REAL_DB")"
  fi
}

# ── main ────────────────────────────────────────────────────────────────────
# ── 隔离性中期断言：测试数据此刻还活着 ─────────────────
# 为什么必须有这一步：只在清理后断言「真实库里没有 e2e-* 行」是零区分度的——
# 即便前面的写请求真的落到了真实库，脚本自己的 DELETE 也会把它们删掉。
# 在「临时库里父/子/任务都存活」的时刻查真实库：若 server 绑的是真实库，这里必红。
mid_isolation_check() {
  step "真实数据隔离性中期断言（测试数据此时仍在临时库里）"
  local rows tasks
  rows=$(sql_ephemeral "SELECT COUNT(*) FROM session_meta")
  tasks=$(sql_ephemeral "SELECT COUNT(*) FROM tasks")
  info "临时库此刻会话行数=${rows} / 任务数=${tasks}（测试数据活着）"
  assert_real_db_free_of_our_ids "mid"
  assert_real_db_id_diff "mid"
}

# ── main ──────────────────────────────────────────────
main() {
  guard
  say "=================================================================="
  say " e2e: 会话集合链路（session_meta 真相源）   $(date '+%F %T')"
  say " repo=$REPO_ROOT"
  say " run-id=$RUN_ID  PORT=$PORT  START_SERVER=$START_SERVER"
  say " tmux=$TMUX_SESSION  log=$SERVER_LOG"
  say " out=$OUT_DIR"
  say "=================================================================="
  # 快照在【建任何测试数据之前】：真实库 session_meta 的 id 基准清单 + 主文件/WAL 指纹
  real_db_snapshot "before"
  assert_real_db_free_of_our_ids "before"
  trap cleanup EXIT
  setup_dirs
  start_server
  probe_server_binding
  step1_create_session
  step2_prompt_event
  step3_read_side
  step4_task_assign
  step5_fork
  step6_two_regions
  mid_isolation_check
  step7_cleanup_data
  final_checks
  hr
  say "全部断言通过。"
  FINISHED=1
}

# 可被 `source` 复用（RED 自检脚本会 import 其中的断言函数），只有直接执行才跑 main。
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  main "$@"
fi
