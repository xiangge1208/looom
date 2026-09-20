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
# 前置：本机需有 mysql 客户端；.env 里配好 DB_ROOT_PASSWORD
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
echo "[3/4] 建表..."
for f in "$ROOT_DIR"/db/schema-*.sql; do
  [ -e "$f" ] || continue
  echo "      执行 $(basename "$f")"
  run_sql < "$f"
done
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
