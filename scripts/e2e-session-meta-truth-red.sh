#!/usr/bin/env bash
# ============================================================================
# e2e-session-meta-truth-red.sh —— 隔离断言的 RED 自检（14 个 RED-CASE）
#
# 用途：验证 `e2e-session-meta-truth.sh` 里隔离断言的「该红时红」——即它们不是
#   空通过（文件不存在 → grep 拿不到输出 → 计数为 0 → 断言假绿）。共 14 个 RED-CASE，
#   每个都用 `rc <期望退出码> <说明>` 钉死（应红的必须 exit 1，应绿的必须 exit 0）。
#
# 前置条件：无（脚本自建 mktemp 假真实库，不连真实数据）。
#
# 执行方式：bash scripts/e2e-session-meta-truth-red.sh
#   默认 source 同目录的 `scripts/e2e-session-meta-truth.sh`（BASH_SOURCE 守卫保证不跑 main）。
#
# 隔离声明：只用 mktemp -d /tmp/piweb-e2e-red-* 造出的「假真实库 / 假会话文件」，
#   不碰真实 ~/.pi/agent、不发任何网络请求、不建会话。
#
# 做法：source 主脚本（不会跑 main），把 REAL_DB / OUT_DIR / AGENT_DIR 指向临时
# 造物，逐个演示「该红时真会红」：
#   1. 真实库 id 集合差集：往假「真实库」里插一条 e2e-meta-* → 断言必须 FAIL
#   2. 真实库 id 直查：真实库里出现本次测试会话 id → 断言必须 FAIL
#   3. 我方新增 id 清零 → 断言恢复 PASS
#   4. 哨兵计数：文件不存在时**旧写法**空通过（现场演示）vs 新写法硬失败
#   5. 控制组：assert_file_contains 找不到文本时 FAIL
# ============================================================================
set -uo pipefail
export LC_ALL=C

SCRIPT=${SCRIPT:-$(cd "$(dirname "$0")" && pwd)/e2e-session-meta-truth.sh}
TMP=$(mktemp -d /tmp/piweb-e2e-red-XXXXXX)
FAKE_DB="$TMP/pi-web.db"
FAKE_AGENT="$TMP/agent"
OUT_DIR="$TMP/out"
mkdir -p "$FAKE_AGENT" "$OUT_DIR"

# 造一个「假真实库」：结构只要 session_meta/tasks 两列够断言用
sqlite3 "$FAKE_DB" "
  CREATE TABLE session_meta (session_id TEXT PRIMARY KEY, task_id TEXT, updated INTEGER NOT NULL, last_reply TEXT);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT);
  INSERT INTO session_meta (session_id, updated) VALUES ('pre-existing-1', 1), ('pre-existing-2', 2);
  INSERT INTO tasks (id, name) VALUES ('t-1', '旧任务');
"

REAL_DB="$FAKE_DB"
REAL_AGENT_DIR="$FAKE_AGENT"
AGENT_DIR="$FAKE_AGENT"
TASK_ID="" SESSION_ID="" CHILD_ID="" CONTROL_ID="" PROBE_ID=""
# shellcheck disable=SC1090
source "$SCRIPT"   # 定义函数；BASH_SOURCE 守卫保证不会跑 main

rc() { # $1=期望的退出码 $2=说明（在子 shell 里跑断言，die 的 exit 不会带走本脚本）
  local want=$1 desc=$2 got=0
  shift 2
  ( "$@" ) && got=0 || got=$?
  if [ "$got" = "$want" ]; then
    printf '  ✔ RED-CASE %s：exit=%s（期望 %s）\n' "$desc" "$got" "$want"
    return 0
  fi
  printf '  ✘ RED-CASE %s：exit=%s 但期望 %s\n' "$desc" "$got" "$want"
  return 1
}

FAILED=0
say "=================================================================="
say " RED 自检：新增隔离断言是否有牙（假真实库 $FAKE_DB）"
say "=================================================================="
real_db_snapshot "before"

say "[1] 差集为空时应当 PASS"
rc 0 "id 差集（未改动）" assert_real_db_id_diff t1 || FAILED=1

say "[2] 真实库被插入一条 e2e-meta-* 时，差集断言必须 FAIL"
sqlite3 "$FAKE_DB" "INSERT INTO session_meta (session_id, updated) VALUES ('e2e-meta-redcase', 3);"
rc 1 "id 差集（新增本次测试 id）" assert_real_db_id_diff t2 || FAILED=1

say "[2b] 新增的是**非我方** id（用户实例在跑）→ 只应 WARN + 仍 PASS（不假红）"
sqlite3 "$FAKE_DB" "DELETE FROM session_meta WHERE session_id='e2e-meta-redcase';"
sqlite3 "$FAKE_DB" "INSERT INTO session_meta (session_id, updated) VALUES ('someone-elses-session', 5);"
rc 0 "id 差集（只有非我方新增）" assert_real_db_id_diff t2c || FAILED=1
say "[2c] 非我方新增里混进一条我方 id → 必须 FAIL"
sqlite3 "$FAKE_DB" "INSERT INTO session_meta (session_id, updated) VALUES ('e2e-meta-redcase-x', 4);"
rc 1 "id 差集（我方 id 混在里面）" assert_real_db_id_diff t2b || FAILED=1
sqlite3 "$FAKE_DB" "DELETE FROM session_meta WHERE session_id IN ('e2e-meta-redcase-x','someone-elses-session');"
rc 0 "id 差集（全部清掉）" assert_real_db_id_diff t2d || FAILED=1

say "[2d] 用户自己的 e2e- 前缀会话（真实库里的 e2e-subagent-001 这种）不得算成我方 → 只 WARN"
sqlite3 "$FAKE_DB" "INSERT INTO session_meta (session_id, updated) VALUES ('e2e-subagent-001', 6);"
rc 0 "id 差集（用户自己的 e2e- 前缀）" assert_real_db_id_diff t2e || FAILED=1
sqlite3 "$FAKE_DB" "DELETE FROM session_meta WHERE session_id='e2e-subagent-001';"

say "[3] 真实库里出现本次测试会话 id 时，直查断言必须 FAIL"
sqlite3 "$FAKE_DB" "INSERT INTO session_meta (session_id, updated) VALUES ('e2e-meta-redcase', 3);"
SESSION_ID="e2e-meta-redcase"
rc 1 "真实库本次测试 id 直查" assert_real_db_free_of_our_ids t3 || FAILED=1

say "[4] 清掉后应当恢复 PASS"
sqlite3 "$FAKE_DB" "DELETE FROM session_meta WHERE session_id='e2e-meta-redcase';"
rc 0 "id 差集（已清除）" assert_real_db_id_diff t4 || FAILED=1
SESSION_ID=""
rc 0 "真实库本次测试 id 直查（已清除）" assert_real_db_free_of_our_ids t5 || FAILED=1

say "[5] 哨兵计数：文件不存在时旧写法空通过（现场演示）vs 新写法硬失败"
hits=$(grep -cF "E2E-DB-SENTINEL" "$TMP/does-not-exist.jsonl" 2>/dev/null || true)
BEFORE_HITS=$hits
if [ "${BEFORE_HITS:-0}" = "0" ]; then
  say "  · 旧写法：hits=[$BEFORE_HITS] → \${hits:-0}=0 → assert_zero 会通过（这就是空通过的病根）"
else
  say "  ✘ 旧写法居然拿到了 [$BEFORE_HITS]"; FAILED=1
fi
rc 1 "assert_file_lacks（文件不存在）" assert_file_lacks "E2E-DB-SENTINEL" "$TMP/does-not-exist.jsonl" "哨兵" || FAILED=1

printf '收到\nE2E-DB-SENTINEL-TEST\n' > "$TMP/session.jsonl"
rc 0 "assert_file_contains（控制组命中）" assert_file_contains "收到" "$TMP/session.jsonl" "真实回复" || FAILED=1
rc 1 "assert_file_lacks（哨兵真在文件里）" assert_file_lacks "E2E-DB-SENTINEL" "$TMP/session.jsonl" "哨兵" || FAILED=1
rc 1 "assert_file_contains（文本不存在）" assert_file_contains "不存在的文本" "$TMP/session.jsonl" "控制组" || FAILED=1

say "[6] 启动/清理期的哨兵：基准清单为空时必须拒绝继续（空通过防线）"
REAL_IDS_BEFORE_FILE=""
rc 1 "id 差集（基准清单为空）" assert_real_db_id_diff t6 || FAILED=1

rm -rf "$TMP"
say "=================================================================="
if [ "$FAILED" = "0" ]; then
  say "RED 自检结果：全部符合预期（该红的都红了，该绿的都是绿的）"
  exit 0
fi
say "RED 自检结果：有不符合预期的用例"
exit 1
