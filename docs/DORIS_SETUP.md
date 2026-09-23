# Doris 接入说明

> ⚠️ **此文件含凭据，不要提交到公开仓库。**

## 一、连接信息

| 项 | 值 |
|---|---|
| 内网地址 | `127.0.0.1` |
| 外网地址 | `120.24.248.175` |
| MySQL 协议端口 | `9030` |
| HTTP / Web UI | `8030` |
| 本项目库 | **`looom`** |
| Doris 版本 | 内核报 `5.7.99`（MySQL 协议兼容版本号） |

### 账号

| 账号 | 密码 | 用途 |
|---|---|---|
| `root` | `<YOUR_DB_ROOT_PASSWORD>` | 建库、建表、授权。仅 `scripts/setup-doris.sh` 用 |
| `etl_user` | `<YOUR_DB_PASSWORD>` | **后端运行时账号** |

### DB_HOST 怎么选

写进了 `.env.example` 的注释，这里再说明一次：

| 后端跑在哪 | DB_HOST 填什么 |
|---|---|
| 本机（`npm run start:dev`） | `127.0.0.1` |
| Docker 容器里，Doris 在宿主机 | `host.docker.internal`（或宿主机内网 IP） |
| 部署到别处，走公网 | `120.24.248.175` |

**当前 `.env` 用的是 `120.24.248.175`** —— 因为实测本机 `127.0.0.1:9030` **不通**
（见下方「遇到过的坑」第 1 条）。

## 二、⚠️ 绝对不要碰的库

这台 Doris 上除本项目库外还有几个不属于本项目的库：

| 库名 | 状态 | 处置 |
|---|---|---|
| `reroll_analysis` | 77 张表，有数据 | **绝对不要读写或修改**（goal.md 明令） |
| `rds_full_sync` | 275 张表 | **不属于本项目，不要碰** |
| `test_st_parse` / `mysql` | 系统/临时库 | 不要碰 |
| ~~`loom`~~ | **已不存在**（2026-09-22 实查确认） | 见下方说明 |
| `looom` | 本项目库（三个 o），65 张表 | 我们的工作区 |

### 关于 `loom` 库（已消失，但护栏保留）

侦察进入 P0 时发现这台 Doris 上曾存在一个 `loom` 库（比本项目名少一个 o），
包含 `dim_asin`（41218 行）、`ods_asin_traffic_daily`（806150 行）、
`ods_cbu_supplier` 等约 28 张表，且 `dim_asin` 在当天仍有更新。

已与用户确认：**该库与本项目无关，不要动它**。
本项目库名因此定为 **`looom`**（三个 o，与工作区目录同名）。

> ⚠️ **2026-09-22 实查**：该库**已不在** `SHOW DATABASES` 结果里
> （疑似被其所有者清理）。但**护栏要保留** ——
> `scripts/setup-doris.sh` 里仍拒绝 `DB_NAME` 为 `reroll_analysis` / `loom` / `mysql`
> 等值，理由有二：
> 1. 库可能被重新创建（它本来就在被活跃使用，只是此刻恰好不在）；
> 2. `loom` / `looom` 只差一个字母，**拼错的代价是写进别人的生产库**。
> 这类护栏的价值在于防手误，不在于目标是否现存。

> 另注：`rds_full_sync`（275 张表）是本次核查新发现的库，
> 同样不属于本项目，**不要碰**。它的表名与本项目无重叠，但同处一个 Doris 实例。

## 三、建库 SQL

```sql
CREATE DATABASE IF NOT EXISTS looom;
```

## 四、授权 SQL（已执行）

`etl_user` 原本对新库没有权限，用 root 补授权：

```sql
GRANT SELECT_PRIV, LOAD_PRIV, ALTER_PRIV, CREATE_PRIV, DROP_PRIV
  ON looom.* TO 'etl_user';
```

验证结果：

```
internal.looom: Select_priv,Load_priv,Alter_priv,Create_priv,Drop_priv
```

> 注意：Doris 的权限名与 MySQL 不同（`SELECT_PRIV` 而非 `SELECT`）。

## 五、从零跑通的验证步骤

### 1. 连通性

```bash
mysql -h 120.24.248.175 -P 9030 -u root -p -e "SELECT 1"
```

### 2. 一键初始化（幂等，可重复执行）

```bash
cp .env.example .env    # 然后填入真实密码
bash scripts/setup-doris.sh
```

预期输出结尾：

```
[3/4] 建表...
      执行 schema-01-system.sql
      执行 schema-02-business.sql
      完成，当前 X 张表。
```

> ⚠️ 脚本会打印实际表数，**不要照抄某个固定数字**。
> 2026-09-22 重核时是 **65 张物理表 = 61 张逻辑表 + 4 张分区迁移残留**，
> 但默认流程**不含** `schema-04/05/07`（见脚本顶部说明），
> 所以全新库跑默认流程建出的表数 **少于** 65 —— 差额是关键词域 16 张
> （schema-04 重建）+ 分区迁移 4 张 + M13 返工 2 张。
> 历次文档记的「55 张」是 schema-04 之前的口径，早已不准。
> 权威实况与完整清单见 [DORIS_SCHEMA_DESIGN.md §14](DORIS_SCHEMA_DESIGN.md)。

### 3. 用运行时账号验证

```bash
mysql -h 120.24.248.175 -P 9030 -u etl_user -p -D looom -e "SELECT 1 AS ok, DATABASE() AS db;"
```

预期：

```
ok	db
1	looom
```

### 4. 确认表数与关键属性

```bash
mysql -h 120.24.248.175 -P 9030 -u etl_user -p -N -e \
  "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='looom';"
# 预期 55

mysql -h 120.24.248.175 -P 9030 -u etl_user -p -e \
  "SHOW CREATE TABLE looom.users\G" | grep -E 'UNIQUE KEY|merge_on_write|INVERTED'
# 预期能看到 UNIQUE KEY(`id`) / enable_unique_key_merge_on_write = "true" / USING INVERTED
```

## 六、遇到过的坑

### 1. 本机 `127.0.0.1:9030` 不通，只能走外网地址

goal.md 说内网地址是 `127.0.0.1`，但实测：

```
doris-http (127.0.0.1:8030)  → 000（连不上）
doris-9030 (127.0.0.1)       → CLOSED
ext-http (120.24.248.175:8030) → 200
ext-9030 (120.24.248.175)      → OPEN
```

说明 Doris **不在本机**，在 `120.24.248.175` 那台机器上。
所以 `.env` 里 `DB_HOST` 用外网地址。
如果后面把后端部署到 Doris 同一台机器，再改回 `127.0.0.1`。

### 2. `roles` 是 Doris 保留字，建表必须加反引号

```sql
-- 报错：no viable alternative at input 'CREATE TABLE IF NOT EXISTS looom.roles'
CREATE TABLE looom.roles (...)

-- 正确
CREATE TABLE looom.`roles` (...)
```

### 3. Doris 要显式指定 `replication_num`

单 BE 节点的开发环境，若不指定副本数，建表可能因副本数不足而失败。
本项目所有表都带：

```sql
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true")
```

生产环境应改为 `3`。

### 4. Doris 权限名带 `_PRIV` 后缀

`GRANT SELECT ON ...` 会失败，要写 `GRANT SELECT_PRIV ON ...`。

### 5. 业务表 SQL 用生成器产出，不要手写

`db/schema-02-business.sql` 由 `db/gen-business-schema.mjs` 生成。

原因：业务表字段高度同构（渠道长表的 5 个指标列在多表复用），
手写容易出现列定义格式错误，且改一处口径要改多处。
**要改结构请改生成器再重新生成**，别直接编辑 SQL，否则下次生成会被覆盖。

```bash
node db/gen-business-schema.mjs
```

### 6. Doris 没有的东西（对应代码里的应用层方案）

| MySQL 有 | Doris 没有 | 我们怎么做 |
|---|---|---|
| 自增主键 | 无 | 应用层雪花算法，`BIGINT` |
| 外键 | 无 | 应用层维护关系，无级联删除 |
| 事务 | 无跨行/跨表事务 | Service 层补偿逻辑，注释标注非原子 |
| `SELECT FOR UPDATE` | 无 | **积分余额以 Redis 为权威值**（`INCRBY` 原子操作），本表作快照定时回写 |
| 唯一约束 | 无（Unique Key 是合并语义不是约束） | 应用层先查后插；并发场景加分布式锁 |
| 深分页 | 支持但性能差 | 游标分页（基于 id 或 created_at） |

### 7. ⚠️ Unique Key 的 upsert 必须写全 NOT NULL 列（很容易踩）

**错误做法**（照 MySQL 的 UPDATE 习惯写）：

```sql
-- 报错：Column has no default value, column=created_at
INSERT INTO users (id, email, password_hash, last_login_at, updated_at)
VALUES (?, ?, ?, ?, ?)
```

**正确做法**：先读整行，再整行写回。

```sql
INSERT INTO users
  (id, email, password_hash, nickname, avatar_url, status, default_country,
   last_login_at, last_login_ip, is_deleted, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

原因：Doris 的 Unique Key 模型下 `INSERT` 是**整行替换**语义，
不是 MySQL 那种「只更新指定列」。凡是 `NOT NULL` 且无默认值的列，
只要没写进 INSERT 就会报错。

代码里的应对：`AuthService.touchLastLogin()` 先 `SELECT *` 再整行写回，
是唯一可靠的模式。

### 8. ⚠️ BIGINT 精度陷阱（最隐蔽的一个）

雪花 ID 是 19 位数字，**超过 JS 安全整数上限 2^53**。
mysql2 默认行为有两个问题：

1. 读取时把 BIGINT 转成 JS `Number` → 丢低位
2. 写入时不接受 JS `bigint` 类型参数

实测后果：

```js
Number(376317047212085248n)  // → 376317047212085250  差了 2！
```

危险之处在于 **不报错、静默写错数据**：
按 id 更新任务状态时，实际写到了另一个 id 上，
导致 ① 同一任务出现两行（一行 `running` 一行 `success`）
② 缓存 JOIN 查不到 `success` 行，每次都重新调模型（白花钱）。

**解决**（已在 `DorisService` 里配好）：

```ts
supportBigNumbers: true,   // 读取时识别 BIGINT
bigNumberStrings: true,    // 读成字符串而非 Number
decimalNumbers: false,     // DECIMAL 同样按字符串返回（积分金额不能丢精度）
```

外加 `normalizeParams()`：写入前把 `bigint` 参数转成十进制字符串。

> 推论：所有 BIGINT 字段（尤其是 ID）在应用层一律按**字符串**处理，
> 不要用 `parseInt` / `Number()` 转换。传给前端也必须是字符串。

