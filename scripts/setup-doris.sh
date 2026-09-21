#!/usr/bin/env bash
#
# Doris 初始化脚本（幂等，可重复执行）
#
# 做三件事：
#   1. 建库（looom）
#   2. 建表（db/schema-*.sql，全部 CREATE TABLE IF NOT EXISTS）
#   3. 灌 seed 数据（db/seed.sql，可用 --skip-seed 跳过）
#
# 用法：
#   bash scripts/setup-doris.sh     # 建库建表 + seed
#   bash scripts/setup-doris.sh --skip-seed  # 只建库建表
#
#   RESET_KEYWORD_DOMAIN=1 bash scripts/setup-doris.sh
#     ↑ 额外执行 db/schema-04-keyword-text-key.sql，**会清空 16 张关键词表**
#
#   RUN_PARTITION_MIGRATION=1 bash scripts/setup-doris.sh
#     ↑ 额外执行 db/schema-05-partitions.sql，给两张大表加按月自动分区。
#       会搬 165 万行数据并 RENAME，旧表留成 *_old 待人工核对后删。只需跑一次。
#
# 前置：本机需有 mysql 客户端；.env 里配好 DB_ROOT_PASSWORD
#
# 为什么 schema-04 不在默认流程里（重要）：
#   schema-04 用 DROP TABLE + CREATE TABLE（不是 IF NOT EXISTS），
#   它做的是「关键词域主键从 keyword_id 改成 (keyword,country)」的一次性改造。
#   放进 glob 会导致每次跑本脚本都清空 dim_keyword 等 16 张表，
#   其中 dim_keyword(13,070 行)、fact_keyword_competition_snapshot(3,244)、
#   fact_keyword_conversion_funnel(854) 已有真实数据，清掉要重跑 ETL 才能恢复。
#   所以改成显式 opt-in：只有全新建库或确实要重置关键词域时才带上这个变量。
#
# 安全约束（重要）：
#   本脚本只操作 $DB_NAME 指定的库。
#   绝不触碰 reroll_analysis 和 loom 这两个已有库。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---- 读取 .env ----
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT_DIR/.env"
  set +a
else
  echo "错误：找不到 $ROOT_DIR/.env"
  echo "请先复制 .env.example 为 .env 并填入真实密码。"
  exit 1
fi

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-9030}"
DB_NAME="${DB_NAME:-looom}"
DB_ROOT_USER="${DB_ROOT_USER:-root}"
DB_ROOT_PASSWORD="${DB_ROOT_PASSWORD:-}"
DB_USER="${DB_USER:-etl_user}"

# ---- 安全护栏：禁止把目标库指向已有的其它库 ----
case "$DB_NAME" in
  reroll_analysis|loom|mysql|information_schema|__internal_schema)
    echo "错误：DB_NAME=$DB_NAME 是受保护的已有库，拒绝执行。"
    echo "请在 .env 里把 DB_NAME 改成本项目自己的库名。"
    exit 1
    ;;
esac

if [ -z "$DB_ROOT_PASSWORD" ]; then
  echo "错误：.env 里没有 DB_ROOT_PASSWORD，无法建库。"
  exit 1
fi

SKIP_SEED=0
[ "${1:-}" = "--skip-seed" ] && SKIP_SEED=1

# 统一的 mysql 调用（密码走环境变量，不出现在进程列表里）
run_sql() {
  MYSQL_PWD="$DB_ROOT_PASSWORD" mysql \
    -h "$DB_HOST" -P "$DB_PORT" -u "$DB_ROOT_USER" \
    --default-character-set=utf8mb4 "$@"
}

echo "=========================================="
echo " Doris 初始化"
echo " 目标: $DB_HOST:$DB_PORT / 库 $DB_NAME"
echo "=========================================="

# ---- 1. 连通性检查 ----
echo "[1/4] 检查连通性..."
if ! run_sql -e "SELECT 1" >/dev/null 2>&1; then
  echo "错误：连不上 Doris ($DB_HOST:$DB_PORT)。请检查："
  echo "  - Doris FE 是否在运行"
  echo "  - .env 里的 DB_HOST / DB_PORT 是否正确"
  echo "  - 后端跑在容器里时 DB_HOST 应为 host.docker.internal 或宿主机内网 IP"
  exit 1
fi
echo "      连接正常。"

# ---- 2. 建库 ----
echo "[2/4] 建库 $DB_NAME（已存在则跳过）..."
run_sql -e "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\`;"
echo "      完成。"

# ---- 3. 建表 ----
#
# 只跑幂等的 schema，跳过三个非幂等文件：
#   schema-04 关键词域重建（DROP+CREATE）→ RESET_KEYWORD_DOMAIN=1
#   schema-05 大表分区迁移（搬数据+RENAME）→ RUN_PARTITION_MIGRATION=1
#   schema-07 M13 返工（RENAME + INSERT SELECT）→ 见下方单独处理
# 通配符 schema-0[!457]-*.sql 排除这三个；将来有 schema-1x 需改成显式列表。
echo "[3/4] 建表..."
for f in "$ROOT_DIR"/db/schema-0[!457]-*.sql; do
  [ -e "$f" ] || continue
  echo "      执行 $(basename "$f")"
  run_sql < "$f"
done

# ---- schema-07：M13 数据层返工，非幂等，带存在性守卫 ----
#
# 为什么不能进上面的 glob：
#   1. 含 `ALTER TABLE ... RENAME`，表已改名后再跑会报 Unknown table 并中断
#   2. 含 `INSERT INTO ... SELECT` 迁移数据，重复跑虽因 Unique Key 覆盖而安全，
#      但会白跑一遍 33,019 行
#   3. Doris 的 ADD COLUMN 是异步 SCHEMA_CHANGE，同表连续 ALTER 会报
#      `state(SCHEMA_CHANGE) is not NORMAL`，必须分批
#
# 守卫方式：探测目标表 fact_keyword_acos_estimate 是否已存在。
# 存在 = 已执行过，跳过；不存在 = 需要执行。
REWORK_SCHEMA="$ROOT_DIR/db/schema-07-m13-rework.sql"
if [ -f "$REWORK_SCHEMA" ]; then
  ACOS_EXISTS=$(run_sql -N -e \
    "SELECT COUNT(*) FROM information_schema.TABLES
      WHERE TABLE_SCHEMA='$DB_NAME' AND TABLE_NAME='fact_keyword_acos_estimate';")
  if [ "$ACOS_EXISTS" = "0" ]; then
    echo "      执行 $(basename "$REWORK_SCHEMA")（M13 返工：改名+拆维+补列）"
    # ⚠️ 不加 --force：这个文件的语句有先后依赖（改名 → 建表 → 迁数据），
    #    中途失败必须停下来让人看，不能跳过继续。
    run_sql < "$REWORK_SCHEMA" || {
      echo "      ⚠️  schema-07 执行中断。Doris 的 ADD COLUMN 是异步的，"
      echo "          若报 'state(SCHEMA_CHANGE) is not NORMAL'，等几秒重跑本脚本即可"
      echo "          （已完成的部分有守卫，不会重复执行）。"
      exit 1
    }
  else
    echo "      跳过 schema-07（fact_keyword_acos_estimate 已存在，说明已执行过）"
  fi
fi

# schema-04 是破坏性的关键词域重建，只在显式要求时执行
KEYWORD_SCHEMA="$ROOT_DIR/db/schema-04-keyword-text-key.sql"
if [ "${RESET_KEYWORD_DOMAIN:-0}" = "1" ]; then
  if [ -f "$KEYWORD_SCHEMA" ]; then
    echo "      执行 $(basename "$KEYWORD_SCHEMA")（RESET_KEYWORD_DOMAIN=1，将清空关键词表）"
    run_sql < "$KEYWORD_SCHEMA"
  fi
else
  # 全新库里这 16 张表不存在，不跑 schema-04 会让后端按文本键写的 JOIN 报
  # Unknown column 'keyword'，所以这里主动探测并提示，而不是静默跳过。
  KW_EXISTS=$(run_sql -N -e \
    "SELECT COUNT(*) FROM information_schema.TABLES
      WHERE TABLE_SCHEMA='$DB_NAME' AND TABLE_NAME='dim_keyword';")
  if [ "$KW_EXISTS" = "0" ]; then
    echo "      ⚠️  dim_keyword 不存在，说明这是全新库。"
    echo "          关键词域 16 张表需要执行 schema-04 才会建出来："
    echo "            RESET_KEYWORD_DOMAIN=1 bash scripts/setup-doris.sh"
    echo "          （新库里执行无数据损失风险）"
  else
    echo "      跳过 schema-04（破坏性重建）。需重置关键词域时设 RESET_KEYWORD_DOMAIN=1。"
  fi
fi

# schema-05 是大表分区迁移，会搬 165 万行数据并 RENAME，只在显式要求时执行
PARTITION_SCHEMA="$ROOT_DIR/db/schema-05-partitions.sql"
if [ "${RUN_PARTITION_MIGRATION:-0}" = "1" ] && [ -f "$PARTITION_SCHEMA" ]; then
  echo "      执行 $(basename "$PARTITION_SCHEMA")（搬数据 + RENAME，大表耗时）"
  run_sql < "$PARTITION_SCHEMA"
  echo "      ⚠️  旧表保留为 *_old，核对行数后手动 DROP（见该 SQL 文件 §3）"
fi

TABLE_COUNT=$(run_sql -N -e \
  "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB_NAME';")
echo "      完成，当前共 $TABLE_COUNT 张表。"

# ---- 4. 授权 ----
echo "[4/4] 给 $DB_USER 授权..."
run_sql -e \
  "GRANT SELECT_PRIV, LOAD_PRIV, ALTER_PRIV, CREATE_PRIV, DROP_PRIV ON \`$DB_NAME\`.* TO '$DB_USER';" \
  2>/dev/null || echo "      （授权失败或已存在，可忽略）"
echo "      完成。"

# ---- seed ----
if [ "$SKIP_SEED" = "0" ] && [ -f "$ROOT_DIR/db/seed.sql" ]; then
  echo "[+] 灌入 seed 数据..."
  run_sql < "$ROOT_DIR/db/seed.sql"
  echo "    完成。"
elif [ "$SKIP_SEED" = "1" ]; then
  echo "[+] 按 --skip-seed 跳过 seed。"
else
  echo "[+] 没有 db/seed.sql，跳过。"
fi

echo
echo "=========================================="
echo " 初始化完成。验证："
echo "   mysql -h $DB_HOST -P $DB_PORT -u $DB_USER -p -D $DB_NAME -e 'SHOW TABLES;'"
echo "=========================================="
