# Sif 后台复刻 —— 数据字典

> 状态：**侦察期产出，已被后续 schema 变更部分推翻**。
> A 部分（系统表）大体仍准；B 部分（业务表）**主键描述已过期** ——
> 本文写的是 `keyword_id` 作主键，而 `db/schema-04-keyword-text-key.sql`
> 已把 16 张关键词表改成 `(keyword, country)` 文本键。
>
> **当前实况请以 [DORIS_SCHEMA_DESIGN.md §15](DORIS_SCHEMA_DESIGN.md) 为准**
> （实况 **70 张**物理表；§15 的字段清单本身也还停在 65 张，
> 未含 schema-09 的 1 张与 schema-10 的 4 张，补进去要重跑生成流程）。
> 本文保留价值在于**字段的中文语义与实测依据**（每张表的 COMMENT 来源），
> 看字段含义可以，抄主键/表数不行。
>
> ⚠️ **本文已停止维护**（2026-09-23 确认）：schema-07 起新建的表一张都没进来
> （`fact_keyword_acos_estimate` / `fact_rec_column_trend` /
> `fact_asin_daily_snapshot` / `fact_asin_keyword_attribution` /
> `fact_keyword_nf_share` / `fact_keyword_slot_hourly` …）。
> 新增表**不必**回写本文，请写进 `DORIS_SCHEMA_DESIGN.md`。
>
> 目标库：**`looom`**（Apache Doris）—— 本文原写 `sif_replica`，那是设计阶段的暂定名，
> 实际库名定为 `looom`（三个 o）。**绝不触碰 `reroll_analysis`。**

## 通用约定（Doris 适配，全表适用）

| 约定 | 说明 |
|---|---|
| 表模型 | 全部 **Unique Key + `enable_unique_key_merge_on_write=true`**，支持按主键更新单行 |
| 主键 | 无自增。所有 ID **应用层雪花算法生成**，`BIGINT` |
| 外键 | Doris 无外键。关系只在应用层维护，**无级联删除** |
| 事务 | Doris 无跨行/跨表事务。多表写入用 Service 方法 + 补偿逻辑，代码注释标注非原子 |
| 分桶 | 每表 `DISTRIBUTED BY HASH(<主键>) BUCKETS 2`（开发环境） |
| 分页 | 游标分页（基于 `id` 或 `created_at`），禁用深 OFFSET |
| 搜索 | 优先 `INDEX ... USING INVERTED`，退而求其次 LIKE |
| 时间字段 | 统一 `DATETIME`，UTC 存储，前端按用户时区展示 |
| 软删除 | 统一 `is_deleted TINYINT DEFAULT 0`，不做物理删除（Doris 删除代价高） |
| **站点维度** | **业务表必带 `country VARCHAR(8)` 并进主键组合**（见下方说明） |

### 关于 `country` 的强制约定（来自实测）

`docs/fragments/_common.spec.md` 第 1.2 节实测：原站 axios 拦截器对**所有**业务请求
强制追加 `country` 参数，支持 13 个亚马逊站点（US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR）。

**因此所有业务数据表的主键必须包含 `country`**，否则不同站点的同一 ASIN 会被 Unique Key 合并覆盖。
例：ASIN 主表主键为 `(asin, country)`，而非仅 `asin`。系统表（用户、积分等）不需要此字段。

---

# A. 系统表（平台自身运行所需，按通用 SaaS 最佳实践设计）

> 这部分 goal.md 允许按经验设计。原站对应功能的实测字段由系统域子 Agent 补充，
> 若原站有额外字段值得吸收，会在合并阶段并入并标注来源。

## A1. `users` —— 用户主表

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | BIGINT NOT NULL | 雪花 ID，主键 |
| `email` | VARCHAR(190) NOT NULL | 登录邮箱，唯一（应用层保证唯一，Doris 无唯一约束） |
| `password_hash` | VARCHAR(100) NOT NULL | bcrypt 哈希，cost=10 |
| `nickname` | VARCHAR(64) | 昵称 |
| `avatar_url` | VARCHAR(512) | 头像地址，默认占位图 |
| `status` | TINYINT DEFAULT 1 | 1=正常 0=停用 2=封禁（封禁对应原站 `/blacklist` 页） |
| `default_country` | VARCHAR(8) DEFAULT 'US' | 默认站点，对应原站 Vuex `countryCode` |
| `last_login_at` | DATETIME | 最后登录时间 |
| `last_login_ip` | VARCHAR(64) | 最后登录 IP |
| `is_deleted` | TINYINT DEFAULT 0 | 软删除 |
| `created_at` | DATETIME NOT NULL | 创建时间 |
| `updated_at` | DATETIME | 更新时间 |

- 主键 `UNIQUE KEY(id)`，`DISTRIBUTED BY HASH(id) BUCKETS 2`
- 索引：`INDEX idx_email (email) USING INVERTED`（登录查询用）
- **Doris 注意**：邮箱唯一性无法靠数据库约束，注册时应用层先查后插；
  并发注册同一邮箱有极小概率重复，需在注册 Service 加分布式锁或后置去重任务

## A2. `refresh_tokens` —— 刷新令牌

> 说明：**原站无 refresh token 机制**（实测为单 token + 401 登出）。此表是 goal.md 要求的新增设计。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | BIGINT NOT NULL | 雪花 ID，主键 |
| `user_id` | BIGINT NOT NULL | 所属用户 |
| `token_hash` | VARCHAR(128) NOT NULL | refresh token 的 SHA-256，**不存明文** |
| `expires_at` | DATETIME NOT NULL | 过期时间（建议 30 天） |
| `revoked_at` | DATETIME | 主动吊销时间，NULL=有效 |
| `user_agent` | VARCHAR(512) | 签发时的 UA，用于「登录设备管理」 |
| `ip` | VARCHAR(64) | 签发时 IP |
| `created_at` | DATETIME NOT NULL | 签发时间 |

- 主键 `UNIQUE KEY(id)`，索引 `INDEX idx_user (user_id) USING INVERTED`
- **Doris 注意**：过期 token 清理用定时任务批量 `DELETE`，不要逐条删

## A3. `roles` / `user_roles` —— 角色权限

> 原站存在 `/api/team/**`（13 个端点，团队/子账号），说明有角色概念。
> 具体角色枚举待系统域子 Agent 确认后修正。当前按最小可用设计。

`roles`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | BIGINT NOT NULL | 主键 |
| `code` | VARCHAR(32) NOT NULL | 角色码：`admin` / `user` |
| `name` | VARCHAR(64) NOT NULL | 中文名 |
| `permissions` | TEXT | JSON 数组，权限点列表 |
| `created_at` | DATETIME | |

`user_roles`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | BIGINT NOT NULL | 主键 |
| `user_id` | BIGINT NOT NULL | |
| `role_id` | BIGINT NOT NULL | |
| `created_at` | DATETIME | |

- 索引：`user_roles` 上 `INDEX idx_user (user_id) USING INVERTED`
- ⚠️ 待确认：原站团队功能是「主子账号」还是「多人协作」，会影响是否需要 `teams` 表

## A4. `credit_accounts` —— 积分账户

| 字段 | 类型 | 说明 |
|---|---|---|
| `user_id` | BIGINT NOT NULL | **主键即 user_id**（一人一账户） |
| `balance` | **DECIMAL(16,4)** NOT NULL DEFAULT 0 | 当前余额。**实测原站积分是浮点数**（`balanceIntegral: 100.0`），非整数 |
| `total_recharged` | DECIMAL(16,4) DEFAULT 0 | 累计充值 |
| `total_consumed` | DECIMAL(16,4) DEFAULT 0 | 累计消耗 |
| `frozen` | DECIMAL(16,4) DEFAULT 0 | 冻结中（AI 任务预扣，失败退还） |
| `channel` | VARCHAR(16) DEFAULT 'personal' | 账号渠道。实测原站返回 `channel:"personal"`，疑与团队账号区分 |
| `integral_limit` | DECIMAL(16,4) | 积分上限。实测原站有此字段（当前为 null） |
| `version` | BIGINT DEFAULT 0 | 乐观锁版本号 |
| `updated_at` | DATETIME | |

- `UNIQUE KEY(user_id)`，`DISTRIBUTED BY HASH(user_id) BUCKETS 2`
- **Doris 注意（关键）**：Doris **无事务、无 `SELECT ... FOR UPDATE`**，
  扣费不能用「读余额→改余额」的读改写模式，并发下会丢更新。
  设计方案：**余额以 Redis 为权威值**（`INCRBY`/`DECRBY` 原子操作），
  Doris 表作为持久化快照，由定时任务批量回写。
  goal.md 第 8 条约束已指明此方案，实现可后置（P2）

## A5. `credit_transactions` —— 积分流水

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | BIGINT NOT NULL | 雪花 ID，主键 |
| `user_id` | BIGINT NOT NULL | |
| `type` | VARCHAR(32) NOT NULL | `recharge` 充值 / `consume` 消耗 / `refund` 退还 / `gift` 赠送 / `expire` 过期 |
| `amount` | **DECIMAL(16,4)** NOT NULL | 变动值，正=增 负=减。**实测原站为浮点** |
| `balance_after` | **DECIMAL(16,4)** NOT NULL | 变动后余额（冗余，便于对账） |
| `biz_type` | VARCHAR(32) | 业务场景：`query_asin` / `query_keyword` / `ai_analysis` / `export` 等 |
| `biz_id` | VARCHAR(64) | 关联业务 ID（如 query_log.id / ai_task.id） |
| `remark` | VARCHAR(255) | 备注 |
| `created_at` | DATETIME NOT NULL | |

- `UNIQUE KEY(id)`，索引 `INDEX idx_user (user_id) USING INVERTED`
- 流水表**只追加不更新**，是对账的唯一依据
- ⚠️ 扣费单价（每种查询扣多少分）待系统域子 Agent 从原站挖出，落到 `system_configs`

## A6. `query_logs` —— 查询审计

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | BIGINT NOT NULL | 雪花 ID，主键 |
| `user_id` | BIGINT NOT NULL | |
| `query_type` | VARCHAR(32) NOT NULL | `asin` / `keyword` / `supplier` |
| `query_value` | VARCHAR(255) NOT NULL | 查询的 ASIN 或关键词原文 |
| `country` | VARCHAR(8) NOT NULL | 站点 |
| `page_route` | VARCHAR(64) | 从哪个页面发起（`/sales` / `/traffic` ...） |
| `credits_cost` | INT DEFAULT 0 | 本次扣分 |
| `result_count` | INT | 返回结果数 |
| `duration_ms` | INT | 耗时 |
| `status` | TINYINT DEFAULT 1 | 1=成功 0=失败 |
| `error_msg` | VARCHAR(512) | 失败原因 |
| `ip` | VARCHAR(64) | |
| `created_at` | DATETIME NOT NULL | |

- `UNIQUE KEY(id)`，索引：`INDEX idx_user (user_id) USING INVERTED`、`INDEX idx_value (query_value) USING INVERTED`
- 支撑 goal.md 的「我的查询历史」（P3）和 `/dashboard` 的最近查询记录
- **Doris 注意**：这是**高频写入**表。Doris 不适合单条高频 INSERT，
  应用 **Stream Load 批量写入**或 Redis 缓冲 + 定时批量刷盘

## A7. `ai_tasks` —— AI 任务

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | BIGINT NOT NULL | 雪花 ID，主键 |
| `user_id` | BIGINT NOT NULL | |
| `insert_point` | VARCHAR(64) NOT NULL | 插入点：`sales-trend` / `keyword-recommend` / `traffic-insight` / `supplier-evaluate` / `ad-optimize` / `diagnosis` |
| `prompt_version` | VARCHAR(16) NOT NULL | prompt 版本，如 `v1`，对应 `prompts/*.v1.ts` |
| `input_hash` | VARCHAR(64) NOT NULL | 输入的 SHA-256，**命中缓存直接返回不重复扣费** |
| `input_payload` | TEXT | 输入快照 JSON（便于复现） |
| `status` | VARCHAR(16) NOT NULL | `pending` / `running` / `success` / `failed` / `cancelled` |
| `provider` | VARCHAR(32) | `openai-compatible` / `mock` |
| `model` | VARCHAR(64) | 实际使用的模型名 |
| `retry_count` | TINYINT DEFAULT 0 | 重试次数，**上限 2**（goal.md 要求） |
| `credits_frozen` | INT DEFAULT 0 | 预扣积分，失败时退还 |
| `error_msg` | VARCHAR(1024) | |
| `started_at` | DATETIME | |
| `finished_at` | DATETIME | |
| `created_at` | DATETIME NOT NULL | |

- `UNIQUE KEY(id)`，索引：`INDEX idx_hash (input_hash) USING INVERTED`、`INDEX idx_user (user_id) USING INVERTED`
- 缓存命中逻辑：查 `(insert_point, prompt_version, input_hash)` 且 `status='success'`，
  命中则直接取对应 `ai_analyses`。**prompt 版本变更自动使旧缓存失效**
- **Doris 注意**：任务状态需频繁更新（pending→running→success）。
  Unique Key MoW 模型支持按主键更新，但**高频更新性能不佳**。
  运行中的状态建议放 Redis，仅在**终态**（success/failed）落 Doris

## A8. `ai_analyses` —— AI 分析结果

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | BIGINT NOT NULL | 雪花 ID，主键 |
| `task_id` | BIGINT NOT NULL | 关联 `ai_tasks.id` |
| `user_id` | BIGINT NOT NULL | 冗余，便于按用户查 |
| `insert_point` | VARCHAR(64) NOT NULL | 冗余 |
| `content_md` | TEXT NOT NULL | **Markdown 格式结论**（goal.md 要求统一 Markdown，前端 markdown-it 渲染） |
| `prompt_tokens` | INT | |
| `completion_tokens` | INT | |
| `total_tokens` | INT | 计费依据 |
| `created_at` | DATETIME NOT NULL | |

- `UNIQUE KEY(id)`，索引 `INDEX idx_task (task_id) USING INVERTED`
- 与 `ai_tasks` 是 1:1（一个成功任务一条结果）。拆表原因：结果 TEXT 体积大，
  任务表需高频查询状态，分开避免宽表扫描

## A9. `api_keys` —— API Key 管理

> ⚠️ 原站是否有此功能待系统域子 Agent 确认。goal.md 要求做，故先设计。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | BIGINT NOT NULL | 雪花 ID，主键 |
| `user_id` | BIGINT NOT NULL | |
| `name` | VARCHAR(64) NOT NULL | 用户自定义名称 |
| `key_prefix` | VARCHAR(16) NOT NULL | 明文前缀（如 `sk_live_a1b2`），**列表页只展示这个** |
| `key_hash` | VARCHAR(128) NOT NULL | 完整 key 的 SHA-256，**明文只在创建时返回一次** |
| `scopes` | VARCHAR(255) | 权限范围，逗号分隔 |
| `last_used_at` | DATETIME | 最后使用时间 |
| `expires_at` | DATETIME | 过期时间，NULL=永不过期 |
| `revoked_at` | DATETIME | 吊销时间，NULL=有效 |
| `created_at` | DATETIME NOT NULL | |

- `UNIQUE KEY(id)`，索引 `INDEX idx_prefix (key_prefix) USING INVERTED`
- 安全要求：**明文 key 绝不落库、不进日志**

## A10. `system_configs` —— 系统配置

| 字段 | 类型 | 说明 |
|---|---|---|
| `config_key` | VARCHAR(128) NOT NULL | **主键**，如 `credit.cost.query_asin` |
| `config_value` | TEXT NOT NULL | 值（标量或 JSON） |
| `value_type` | VARCHAR(16) DEFAULT 'string' | `string` / `int` / `bool` / `json` |
| `group_name` | VARCHAR(32) | 分组：`credit` / `ai` / `feature_flag` / `limit` |
| `description` | VARCHAR(255) | 中文说明 |
| `updated_at` | DATETIME | |

- `UNIQUE KEY(config_key)`，`DISTRIBUTED BY HASH(config_key) BUCKETS 1`
- 用途举例：各类查询的积分单价、功能开关、免费额度上限
- 应用启动时全量加载进内存缓存，配置变更走管理端并主动刷新

## A11. `user_favorites` —— 用户关注/监控/订阅

> **实测已解答原先的疑问**：`asinKeywordList` 单行响应里
> **`isFocus` / `isMonitor` / `isSubscribe` 三个标志同时并存且独立**，
> 证实这是**三种不同功能**，不是同一个。
> 印证接口侧证据：`/api/focus/**`（9 个端点）、`/api/search/focusAsins`、
> `/api/search/focusKeywords`、`/api/search/user/subsAsin`（订阅）、
> keywords 域的 `rel_keyword_monitor`（监控）。
>
> 设计决策：**一张表 + `favorite_type` 区分**，而非拆三张。
> 理由：三者字段高度重合（都是 用户×目标×站点），拆表会产生三份近乎相同的结构。
> 差异部分（订阅的通知配置）用可空字段承载。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | BIGINT NOT NULL | 主键 |
| `user_id` | BIGINT NOT NULL | |
| `favorite_type` | VARCHAR(16) NOT NULL | **`focus` 关注 / `monitor` 监控 / `subscribe` 订阅**（实测三态） |
| `target_type` | VARCHAR(16) NOT NULL | `asin` / `keyword` |
| `target_value` | VARCHAR(255) NOT NULL | ASIN 或关键词文本 |
| `keyword_id` | BIGINT | 关键词时填，便于关联 `dim_keyword`（实测 keywordId 全局唯一） |
| `country` | VARCHAR(8) NOT NULL | 站点 |
| `group_name` | VARCHAR(64) | 用户自建分组（实测响应有 `groups` 字段） |
| `note` | VARCHAR(512) | 备注 |
| `notify_enabled` | TINYINT DEFAULT 0 | 仅 `subscribe` 用：排名变动是否通知 |
| `created_at` | DATETIME NOT NULL | |

- `UNIQUE KEY(id)`，索引 `INDEX idx_user (user_id) USING INVERTED`
- 应用层保证 `(user_id, favorite_type, target_type, target_value, country)` 唯一

- `UNIQUE KEY(id)`，索引 `INDEX idx_user (user_id) USING INVERTED`

## A12. 系统表小结

共 12 张：`users`、`refresh_tokens`、`roles`、`user_roles`、`credit_accounts`、
`credit_transactions`、`query_logs`、`ai_tasks`、`ai_analyses`、`api_keys`、
`system_configs`、`user_favorites`。

需要你裁决的点：
1. `roles`/`user_roles` 是否够用，还是需要完整的 `teams` + `team_members`（取决于原站团队功能形态）
2. `user_favorites` 是否拆成「收藏」和「订阅」两张（订阅可能需要通知配置字段）
3. 积分余额走 Redis 权威值 + Doris 快照，是否接受（Doris 无事务，这是必要妥协）

---

# B. 业务数据表（探查后产出）

> 来源：7 个域的 15 份片段（`docs/fragments/*.md`，共 7433 行），
> 合并映射见 `docs/MERGE_MAP.md`，实测依据见 `docs/raw/LIVE_PROBE.md`。
>
> **字段级明细在各域片段里，本节给合并后的表清单、主键、关系与关键字段。**
> 逐字段核对请配合片段阅读。

## B0. 合并前提：三条实测约束 + 用户已裁决事项

### 用户裁决（2026-09-18，已确认，实现阶段按此执行）

| 裁决项 | 决定 |
|---|---|
| **时间粒度** | ✅ **按原站**：广告域 `granularity`（含 week）、其余域 `timePieceType`+`timePieceValue`（month）、多变体自然位 day。**不采用 goal.md 的「30 天日快照」** |
| **渠道表结构** | ✅ **长表**（`channel` 进主键），不用 45 列宽表 |
| **ASIN 流量快照冲突** | 授权我自行判断 → **裁定见下方 B0.1** |
| 父体 ASIN 测试样本 | 用户提供 **`B0FVQKYGTT`** |

### B0.1 我对「ASIN 流量快照」冲突的裁定

冲突：traffic 域主张按渠道拆长表；timemachine 域主张宽表且内含运营事件字段。

**裁定：拆成两张表，不合并。**

| 表 | 承载 | 粒度 | 理由 |
|---|---|---|---|
| `fact_asin_traffic_channel` | 纯流量数据（9 渠道 × 5 指标） | month | 渠道同构 → 长表。与用户裁决 2 一致 |
| `fact_asin_op_event` | 运营动作事件（改标题/图片、新增广告活动、价格活动） | day（事件发生日） | **事件是稀疏的、按天发生的，与流量的月度聚合不是同一粒度** |

三条理由：

1. **粒度不同不能硬合并**（goal.md 明确要求）。运营事件是某一天发生的离散事件，
   流量是月度聚合值。塞进一张表会导致大量 NULL 或重复行
2. **基数差异巨大**。timemachine 域实测 `flows` 数组前 60 个全为 `null`（稀疏），
   事件更稀疏；而流量数据每月每渠道都有值（稠密）。稠密与稀疏混表浪费存储且扫描低效
3. **语义不同**。流量是「观测指标」，事件是「变更记录」。
   前者可覆盖更新（Unique Key 按主键合并），后者应只追加 —— 混表后无法区分

> 代价：查「某月流量变化的原因」需 JOIN 两表（按 asin + country + 月份范围）。
> 这是可接受的 —— Doris 擅长这种宽表扫描 + 时间范围过滤。

## B0.2 三条实测约束

建表前必须理解这三点，否则表结构会错（依据 `LIVE_PROBE.md`）：

| # | 约束 | 影响 |
|---|---|---|
| 1 | **时间粒度按域不同，参数名也不同**：广告域用 `granularity`（**week 可用**），其余域用 `timePieceType`+`timePieceValue`（month 可用、week 报「服务异常」）；多变体自然位是 day | 快照表按粒度拆表，不混存。**不要假设全站参数统一** |
| 2 | **所有业务数据按站点隔离**（13 个站点，请求强制带 `country`） | 除 `dict_` 外所有表必带 `country` 且进主键 |
| 3 | **流量渠道是 9 个同构对象**，不是扁平字段 | 渠道数据用长表（`channel` 进主键），不用 45 列宽表 |

## B1. 基础实体表（dim_）

| 表名 | 用途 | 主键 | 关键字段 | 来源域 |
|---|---|---|---|---|
| `dim_asin` | ASIN 商品主档 | `(asin, country)` | title, img, price, brand, brand_href, score(评分), star(半星展示值), rating_num, first_available_day, is_best_seller | 4 域共用 |
| `dim_keyword` | 关键词主档 | `(keyword_id)` | keyword, translate_keyword(中文翻译), est_searches_num, country(标记非主键) | keywords, timemachine |
| `dim_word` | 单词/词根主档 | `(word, country)` | ⚠️ 无 ID 字段，只能用文本作键 | keywords |
| `dim_asin_feature` | 变体属性（名+值） | `(asin, country, feature_name)` | feature_name(如 Size/Color), feature_value(如 Large/Dark Moss) | sales |
| `dim_recommend_column` | 推荐专栏 | `(rec_title, country)` | rec_title(英文原文), short_code, first_seen_at | recommendations |
| `dim_ad_campaign` | 广告活动 | `(encrypt_campaign_id, country)` | ⚠️ **三套 ID**：fake_campaign_id / encrypt_campaign_id / campaign_id_a0 | ads |
| `dim_ad_product_ad` | 投放小组(Product Ad) | `(encrypt_ad_id, country)` | ⚠️ **不是 AdGroup**，见 MERGE_MAP 纠正 1 | ads |
| `dim_supplier` | 供应商（1688） | `(id)` | 本期仅占位 UI + 表结构，不做采集 | system-suppliers |

### 关键说明

- **`dim_asin.score` 与 `star`**：实测 40 行验证 `star === round(score*2)/2` 100% 成立。
  `score` 是真实评分（4.8），`star` 是半星展示值（5.0）。列显示 `score`、排序传 `star` 是有意设计
- **`dim_asin_feature` 必须拆表**：实测 `features` 有两个层级 —— 父体顶层是**维度名**（`["Size","Color"]`），
  子体行内是**对应下标的取值**（`["Large","Dark Moss"]`）。
  ⚠️ **入库要按下标 zip 对齐**，维度数量随商品变化（SSD 1 个，服装 2 个），不能硬编码两列。
  ⚠️ 两个接口的 `features` 结构不同：`pageAsinVariants` 给扁平字符串数组、
  `bought/asin` 给对象数组 `{code,feature,value}`（自带维度名）。ETL 需兼容两种形态
- **父体不存销量**：实测父体 `isParentAsin:true` 时 `asins:[]` 为空，销量只存在于子体层。
  `fact_asin_bought_monthly` 只存子体行，父体销量由应用层聚合，**不落库**
- **`dim_recommend_column` 是动态实体**（非固定枚举），新标题运行时 upsert 入库
- **不建 `ad_group` 表**：Sif 前端对 AdGroup 层零字段（MERGE_MAP 纠正 1）
- **不建投放词表**：查广告词页存的是买家搜索词（MERGE_MAP 纠正 2）

## B2. 时序快照表（fact_）—— 按粒度分组

### B2.1 月粒度（`timePieceType=month`）

主键统一含 `(time_piece_type, time_piece_value)`，为将来支持 week 预留。

| 表名 | 用途 | 主键 | 来源域 |
|---|---|---|---|
| `fact_asin_bought_monthly` | ASIN 月度销量 | `(asin, country, stat_month)` | sales |
| `fact_asin_listing_snapshot` | Listing 指标快照 | `(asin, country, stat_month)` | sales |
| `fact_asin_traffic_channel` | **ASIN 分渠道流量（长表）** | `(asin, country, time_piece_type, time_piece_value, channel)` | traffic, keywords |
| `fact_asin_keyword_snapshot` | ASIN×关键词 流量排名 | `(asin, keyword_id, country, time_piece_type, time_piece_value, is_listing_search)` | keywords, timemachine |
| `fact_asin_keyword_score` | ASIN×关键词×渠道 得分（长表） | 上一行 + `traffic_type` | keywords |
| `fact_asin_keyword_overview` | 关键词概览聚合 | `(asin, country, time_piece_type, time_piece_value, is_listing_search, traffic_type)` | keywords |
| `fact_word_frequency` | 词频聚合 | `(scope_type, scope_key, country, time_piece_type, time_piece_value, word_model, word)` | keywords |
| `fact_asin_rec_column_period` | ASIN×推荐专栏 曝光 | `(asin, country, rec_title, time_piece_type, time_piece_value)` | recommendations |
| `fact_ad_search_term_exposure` | 搜索词曝光（最细事实） | `(encrypt_ad_id, keyword_id, variant_asin, country, stat_date)` | ads |
| `rel_ad_campaign_product_ad` | 广告活动→投放小组（**时序**关系） | `(encrypt_campaign_id, encrypt_ad_id, country, stat_date)` | ads |

**`fact_asin_bought_monthly` 特别说明**（实测）：
- 月序列固定 **40 个月**，起点 `2023-05`（**不是** `timeRanges` 声明的 2020-07）
- 销量是**字符串分档**（`"200+"`、`"<50"`、`"6,000+"`），不是整数
- → 双列并存：`bought_lower_bound INT`（排序/计算）+ `bought_label VARCHAR(16)`（展示）

**渠道长表的 9 个 channel 取值**（实测确认）：
`total` / `nf` / `ad` / `allSp` / `sp` / **`spRec`** / `allSb` / `sb` / `sbv`
> ⚠️ 入库归一：响应里的 `recSp` 必须转成 `spRec`，否则同一渠道产生两行脏数据

### B2.2 日粒度（无 timePiece 参数）

| 表名 | 用途 | 主键 | 来源域 |
|---|---|---|---|
| `fact_asin_multinf_daily` | 多变体自然位日快照 | `(asin, country, stat_date)` | timemachine |
| `fact_keyword_rank_history` | 关键词排名历史 | `(asin, keyword_id, country, rank_type, stat_date)` | keywords |
| `fact_keyword_metric_snapshot` | 关键词指标（搜索量/CPC/转化率） | `(keyword_id, country, granularity, stat_date)` | keywords |
| `fact_keyword_search_trend` | 搜索量趋势 | `(keyword_id, country, granularity, stat_date, is_prev_period)` | keywords |
| `fact_asin_subbsr_snapshot` | BSR 排名快照 | `(asin, country, stat_date)` | timemachine |

### B2.3 区间聚合（非标准粒度）

| 表名 | 用途 | 来源域 |
|---|---|---|
| `fact_asin_multinf_keyword` | ASIN×关键词 区间聚合 | timemachine |
| `fact_asin_multinf_keyword_variant` | 关键词×变体 排名明细 | timemachine |
| `fact_asin_keyword_inout` | 前 3 页进出快照 | timemachine |
| `fact_asin_op_event` | 运营动作事件（**系统识别的变化点**，非用户标注） | timemachine |

### B2.4 混合粒度（特殊，需注意）

**`fact_asin_rec_column_period`**：实测传 `month` 但返回**逐日 `dates`**，
且趋势数组**极度稀疏**（31 天仅 1 天有值）。
→ 建表**只存非 null 的天**，不要预填满月，否则空行占绝大多数。

## B3. 关系表（rel_）

| 表名 | 用途 | 主键 | 来源域 |
|---|---|---|---|
| `rel_asin_variant` | 父子体变体组 | `(parent_asin, child_asin, country)` | sales, traffic |
| `rel_ad_campaign_product_ad` | 广告活动→投放小组 | `(encrypt_campaign_id, encrypt_ad_id, country)` | ads |
| `rel_rec_column_campaign_keyword` | 推荐专栏→广告活动→关键词 | `(asin, country, rec_title, keyword, encrypt_campaign_id)` | recommendations |
| `rel_keyword_group` | 关键词分组 | `(group_id, keyword_id, country)` | keywords |
| `rel_keyword_monitor` | 关键词监控 | `(asin, keyword_id, country)` | keywords |
| `rel_keyword_top_asin` | 关键词头部 ASIN | `(keyword_id, country, asin)` | keywords |
| `rel_asin_keyword_variant_exposure` | 变体曝光 | `(parent_asin, variant_asin, keyword_id, country, time_piece_type, time_piece_value)` | keywords |

> Doris 无外键，以上关系全部由应用层维护，**无级联删除**。

## B4. 枚举字典表（dict_）

30+ 个各域提案去重后保留 10 张（`dict_` 表**不带 `country`**）：

| 表名 | 取值 | 来源 |
|---|---|---|
| `dict_traffic_channel` | 13 值（含 Deal / BS）。以 traffic 域 5 套映射对齐版为准 | traffic |
| `dict_time_piece` | `day` / `month` / `week`(⚠️实测不可用) | 4 域 6 表合并 |
| `dict_ad_type` | `1`=SP / `2`=SB / `3`=SBV / `4`=SBBV | ads |
| `dict_sort_field` | 排序白名单（sales 域实测穷举验证） | sales |
| `dict_bought_bucket` | 销量分档（14 个观测值） | sales |
| `dict_dimension` | 变体 / Color / Size 维度切换 | traffic, sales |
| `dict_keyword_tag` | isCore / isTarget / isAC 等 | keywords |
| `dict_match_type` | 广告匹配类型（Exact / Phrase / Broad） | keywords, ads |
| `dict_op_event_type` | 运营动作类型 | timemachine |
| `dict_variant_role` | 变体角色（父体 / 子体 / 兄弟） | timemachine |

**14 个降级为前端常量、不建表**：`dict_show_type`、`dict_view_mode`、`dict_search_type`、
`enum_search_granularity`、`dict_count_dimension`、`dict_change_compared_type`、
`dict_flow_change_filter`、`dict_relevance`、`dict_cpc_strategy`、`dict_word_model`、
`enum_bought_source`、`dict_biz_code`、`dict_keyword_change_type`、`dict_multinf_change_type`

> 理由：这些是前端筛选器/视图开关的取值，不参与数据关系，建表只会引入无意义 JOIN。
> 若需可配置，放入 `system_configs`。

## B5. 本期不建的表（范围裁定）

| 项 | 原因 |
|---|---|
| `ad_group` | Sif 前端对 AdGroup 层零字段，建了永远是空表 |
| 投放词表 | 查广告词页存买家搜索词，投放词只能靠气泡图推测 |
| cpc 竞价表（10 端点） | 独立异步子功能，与三广告页无数据关联，goal.md 未要求 |
| `fact_keyword_conversion_funnel` | 属 `/conversion-rate` 页，goal.md 页面清单未包含。**保留结构待用** |
| `ad_type_daily_count` | 区间聚合计数，查询时算即可（采纳 ads 域建议） |
| 竞品对比独有表 | 实测无独有指标，`*Best` 是 `MAX() OVER (组)` 结果不可持久化 |
| `/adxray-variation` 相关 | 实测是 375 字节空壳，未实现 |

## B6. 业务表统计

> ⚠️ **以下为侦察期的设计口径，与当前库不符，勿引用。**
> 实测当前库为 **65 张物理表 = 61 张逻辑表 + 4 张分区迁移残留**，
> 完整清单与行数见 [DORIS_SCHEMA_DESIGN.md §14.1](DORIS_SCHEMA_DESIGN.md)。
> 差异来源：schema-03 补 3 张 gap 表、schema-04 重建 16 张关键词表、
> schema-06/07 M13 又增删若干。下文数字保留作历史对照。

- **基础实体** 8 张
- **时序快照** 18 张（月 9 / 日 5 / 区间 4）
- **关系表** 7 张
- **枚举字典** 10 张
- **合计 43 张业务表**（撰写时口径）+ 12 张系统表 = **55 张**

（各域原始提案 90+ 张，去重合并后 43 张）

---

# C. 合并日志

## C1. 并行执行情况

| 域 | 状态 | 产出 |
|---|---|---|
| sales | ✅ 完成 + **实测修订一轮** | 57 ⚠️ → 23 ⚠️，新增 142 处实测引用 |
| traffic | ✅ 完成（dict 需追问一次才产出） | 渠道枚举 5 套映射对齐，全站最关键的表 |
| keywords | ✅ 完成 + **实测修订一轮** | 主键全部改用 `keyword_id` |
| ads | ✅ 完成 | 质量最高，推翻 3 条常识假设 |
| timemachine+variations | ✅ 完成 | 主动给出 3 条结论而非罗列字段 |
| system+suppliers | ✅ 完成（dict 需追问一次才产出） | 会员三档确证、API Key 结论 |
| recommendations+compare | ⚠️ **首次静默失败（零产出），重派后成功** | 推翻主 Agent 一处裁定 |

3 个域需要追问或重派才产出完整文件。全部最终完成，无「未并行处理」的页面。

## C2. 表名统一（原名 → 统一名）

| 统一名 | 被合并的原名 | 域数 |
|---|---|---|
| `dim_asin` | `dim_asin`、`sif_asin`、`asin_product` | 4 |
| `dim_keyword` | `dim_keyword`、`sif_keyword` | 2 |
| `rel_asin_variant` | `dim_asin_variant_group`、`dim_asin_variant`、`rel_listing_variant` | 3 |
| `fact_asin_traffic_channel` | `fact_asin_traffic_agg`、`fact_asin_flow_overview`、`fact_listing_score_chart` + keywords 长表 | 2 |
| `dict_time_piece` | `enum_time_piece`、`dict_time_piece_type`、`dict_granularity`、`dict_last_months`、`dict_time_piece`×2 | 4 |
| `dict_traffic_channel` | `dict_traffic_channel`、`dict_traffic_type`×2、`dict_traffic_scope` | 3 |
| `dim_recommend_column` | `dim_recommend_column`、`dict_recommend_column`、`dict_rec_column` | 3 |

前缀风格统一：废弃 `enum_`（并入 `dict_`）、废弃 `sif_`（库名已能区分，无需再冠名）。

## C3. 归入系统表的原「业务表」提案

| 原提案 | 归入 | 理由 |
|---|---|---|
| `rel_user_asin_focus`（sales） | A11 `user_favorites` | 用户行为数据 |
| `rel_user_search_record`（sales） | A6 `query_logs` | 用户行为数据 |
| `sys_user_ad_note`（ads） | 系统表新增 | ads 域给出 5 条证据：路径在 `/api/user/`、UI 写「仅自己可见」、用户手工录入、完整 CRUD、独立管理页 |
| `dict_vip_level`（traffic） | 会员等级枚举 | 由 system 域定义 |

## C4. 主 Agent 自己被推翻的判断（诚实记录）

| # | 我的原判断 | 纠正来源 | 实际情况 |
|---|---|---|---|
| 1 | 无法获取真实响应，字段类型只能推断 | 用户要求修复 preview → 我搭本地反代 | **可以拿真实数据**，7 域全部改为实测 |
| 2 | 响应信封是 `{code,message,data}`，HTTP 200 = 成功 | 实测 | 实为 `{code,data,commonMsg}`，**`code:1` 才是成功** |
| 3 | token 存 cookie | 实测 | 存 **localStorage**，JWT HS256 |
| 4 | `/compare-structure` 是「查流量结构」页 | route meta.title | **`/search`** 才是，`compare-*` 是独立的多产品对比族 |
| 5 | month + week 双粒度全站可用 | sales 域实测 + 我复核 + **广告域抓包** | **按域不同**：sales/keywords 的 `timePieceType:week` 报「服务异常」；**广告域用 `granularity:week` 正常可用** |
| 11 | 广告域也用 `timePieceType` | 我盲试 6 轮失败后**代理层抓包** | 广告域用 **`granularity`** + `isAsinSearch` + 嵌套 `conditions`，完全另一套 |
| 12 | `rel_ad_campaign_product_ad` 是静态关系表 | 抓包看到 `ads` 是按日期分组的对象 | **时序关系表**，主键必须带 `stat_date` |
| 6 | 分页参数是 `page` | keywords 域质疑 + 我实测 | **`pageNum`**，`page` 被静默忽略（永远返回第一页） |
| 7 | SP常规/SP推荐 属同一枚举 | ads 域 | `adType` 与 `trafficType` 是**两套正交枚举** |
| 8 | 推荐专栏是固定枚举（`dict_`） | recommendations 域 4 条证据 | **动态实体**（`dim_`），标题未收敛 |
| 9 | 积分是整数 `BIGINT` | 实测 `balanceIntegral: 100.0` | **浮点**，已改 `DECIMAL(16,4)` |
| 10 | `/api/compare/*` 全线失效（子 Agent 报告） | 我复核 | **部分可用**：`bought/multiAsin` 正常，另两个失效 |
| 13 | Doris 条件 UPDATE 可做 CAS，余额可直接存 `credit_accounts.balance` | P2 并发实测（20 并发扣费） | **错，会静默丢失更新**。20 个并发 `UPDATE ... WHERE version = ?` **全部返回 `affectedRows=1`**，但余额只减了一次。去掉 version 改自减也一样（10 并发只生效 2 次）。`affectedRows` 只表示「读快照里匹配到行」，不代表写入被串行化 —— Doris 无行级锁，任何「读-改-写」在并发下都不可靠。已改为**流水 append-only 为权威、余额为派生缓存** |
| 14 | 写完流水后「聚合余额若为负则回滚」可防超扣 | 同上实测 | **会惊群误判**：20 条扣费几乎同时落库，每个请求都看到另外 19 条的扣减，于是**全部 20 个都回滚**（正确结果应是 10 成功）。已改为按**雪花 ID 前缀**判定：只统计 `id <= 自己的 id` 的有效流水，给并发请求一个确定顺序 |
| 15 | `dim_supplier.supplier_name` 上有 `INDEX ... USING INVERTED`，可以用 `MATCH_ANY` 做中文关键词搜索 | P3 实测 | **返回 0 行**。建表时没加 `PROPERTIES("parser"="chinese")`，倒排索引对中文按整串处理，`MATCH_ANY '深圳'` 命中 0，而 `LIKE '%深圳%'` 正确命中 5。已改用 LIKE（seed 仅 50 行，全表扫足够）；真接入大量货源需重建索引并指定中文分词器 |
| 16 | mock provider 按 prompt 文本里的关键词挑假结果就够用 | P3 实测插入点 6 | **会误路由**。综合诊断的提示词里含「销量」二字（数据口径提醒），命中了 `input.includes('销量')` 分支，返回了**销量趋势**的假结果。这种 bug 极难发现 —— 输出看起来「像个正常分析」。已改为 `ChatOptions.insertPoint` 精确匹配 |
| 17 | 诊断汇总用 `Promise.allSettled` 的 fulfilled 判断各域是否有数据 | P3 浏览器实测 | **把「0」当成了「有数据」**。关键词/广告接口对无数据 ASIN 返回空数组而非抛错，页面显示「关键词：Top 0 词」「广告：0 个活动」并当成有效维度。已改为按**实际行数**判断 `available` |
| 18 | 循环里的 `if (signal?.aborted)` 足以处理取消 | P4 边界实测 | **漏判**。provider 收到 abort 会直接 `return`，流自然结束，`for await` 正常退出，**根本不会再进循环体**。结果：取消的任务被标成 `success`，还把**空内容**写进 `ai_analyses` 并进了缓存 —— 之后同样输入永远返回空白分析。实测「外部 300ms abort → delta 0 块 / 状态 success / 结果行 1」。已在流结束后补判取消 + 空结果，并对取消也退款 |
| 19 | Vue 里声明 `chart?: boolean` 的 prop，父组件不传时是 `undefined` | P4 骨架组件实测 | **是 `false`**。Vue 对 boolean prop 做 Boolean casting，导致 `v-if="chart !== false"` 恒为 false，四个页面的骨架只渲染出概要卡，图表和表格块全不见。源码看着完全正常，只有在浏览器里数 DOM 才发现。已改用 `withDefaults` 显式给 `true` |

## C5. 子 Agent 之间的矛盾（已仲裁）

| 冲突 | 仲裁结果 | 依据 |
|---|---|---|
| keywords 域称「无 keywordId，用字符串主键」 vs 主 Agent 实测有 `keywordId` | **以实测为准**，用 `keyword_id` | 子 Agent 分析的是**已 404 下线的旧接口**素材 |
| 流量渠道枚举：traffic 13 值 vs keywords 9 值 vs timemachine 版 | **以 traffic 域为准**（做了 5 套映射对齐）；keywords 9 值是其子集，交叉验证一致 | 两域独立得出的 9 值完全吻合 |
| 推荐专栏 `dim_` vs `dict_` | **`dim_`（动态实体）** | recommendations 域 4 条实测证据 |

---

# D. 待确认（需你逐条裁决）

## D1. 阻塞项（影响建表，必须先定）

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | **`country` 进所有业务表主键**（13 站点）—— 认可吗？ | 认可。否则不同站点同一 ASIN 会被 Unique Key 覆盖 |
| 2 | **seed 只做 US 还是全 13 站点？** | 只做 US + 少量 DE/UK 样本，否则 seed 体积×13 |
| 3 | **时间粒度：按原站 day+month，还是坚持 goal.md 的「30 天日快照」？** | 按原站。销量域实测是 **40 个月月序列**（起点 2023-05），日粒度只用于多变体自然位 |
| 4 | **week 粒度要不要实现？** | **不实现**，留字段位。原站自己都报「服务异常」 |
| 5 | **渠道用长表还是宽表？** | 长表（`channel` 进主键）。宽表要 45 列且新增渠道就改表 |
| 6 | **积分改 `DECIMAL(16,4)`** —— 认可吗？ | 认可，实测原站是浮点 |
| 7 | **ASIN 流量快照：traffic 长表版 vs timemachine 宽表版**（两域冲突，按 goal.md 未自行合并） | 长表为主，timemachine 的运营事件字段单独成 `fact_asin_op_event` |

## D2. 系统表设计裁决

| # | 问题 | 我的建议 |
|---|---|---|
| 8 | `user_favorites` 是否拆分？实测发现 `isMonitor` / `isSubscribe` / `isFocus` **三个独立标志** | 一张表 + `favorite_type` 字段（focus/monitor/subscribe） |
| 9 | 团队功能形态（主子账号 vs 多人协作）→ 决定 `roles/user_roles` 是否够用 | 待 system 域片段确认后定 |
| 10 | 积分余额走 Redis 权威值 + Doris 快照 | 接受。Doris 无事务、无 `SELECT FOR UPDATE`，读改写会丢更新 |
| 11 | 响应信封：照抄原站 `code:1` 成功，还是按 goal.md `{code,message,data}` | **按 goal.md**（`code:0` 成功更符合惯例），不照抄 |
| 12 | 分页：原站页码分页 vs goal.md 游标分页 | **按 goal.md 游标分页**（Doris 深 OFFSET 性能差） |

## D3. 范围裁决（goal.md 与原站的差异）

| # | 问题 |
|---|---|
| 13 | **goal.md 的 `/keywords` 与原站同名路由功能完全不同**：原站 `/keywords` 是「以词拓词」，「反查流量词」在 `/reverse`。命名冲突怎么处理？ |
| 14 | **`/keywords/source` 原站无对位路由**。建议实现为反查页的下钻抽屉，不单独建路由 |
| 15 | **原站有两个完整功能族 goal.md 完全未提**：「拓词&筛查相关性」7 个页面、「关键词竞争分析」3 个页面。本期做吗？ |
| 16 | **goal.md 提到的 3 个推荐专栏未能证实存在**：Amazon Choice、Editorial Recommendation、Top Rated。硬编码表和所有实测响应里都没有 |
| 17 | `/compare-structure` `/compare-traffic` 依赖接口失效，只有 `/compare-sales` 能复刻。竞品对比页怎么做？ |
| 18 | 建议补 goal.md 未列但错误处理需要的页面：`/maintain`（500/502/503）、`/blacklist`（403 封禁）、`/404` |

## D4. 各域遗留的 ⚠️（无法实测确认）

以下需你提供信息或接受推断，**按域列出，明细见各片段的「不确定清单」**：

| 域 | 主要 ⚠️ |
|---|---|
| sales | ✅ **父体分支已验证**（用户提供 `B0FVQKYGTT`）：父体自身无销量数据（`asins:[]`），销量只存子体层；`features` 是位置数组按下标对齐维度名。⚠️ 剩余：`pasinBoughtHistory` 无法构造有值样本（暂不建列）；销量量纲（件数 vs 订单数）无法反推 |
| ads | 10 项。最关键：`adShowId` vs `encryptAdId` 是否同物（已退回让子 Agent 实测）；投放小组→变体 1:1 还是 1:N |
| keywords | `conditions` 参数语义混杂（既承载计数维度筛选又承载词特征筛选），后端解析规则不明 |
| traffic | 「流量得分」算法未知（只知是 double，UI 标「流量(分)」） |
| timemachine | 「运营动作」是系统识别的变化点，但识别算法未知 |
| recommendations | `dict_festival` 是否破例带 `country`（母亲节各国日期不同） |
| system | 积分扣费单价（我**拒绝为测扣费而消耗你的账号积分**，余额 100） |

## D5. 素材勘误（供你了解可信度）

1. `docs/raw/domains/recommendations.txt` 里 11 个端点**全是 sales 域的 bought 接口**，
   与推荐专栏无关 —— 我的域切分正则有误。recommendations 域子 Agent 自行在 chunk 39 里
   找到了真正端点，未受影响
2. 从 bundle 提取的 335 个端点**含已下线项**（实测确认 404 的有
   `/api/search/asinKeywords`、`/api/search/keyword/months`、`/api/search/rec/getVariantsInfoApi`）。
   接口契约表里已标注实测状态
3. 原站存在拼写错误，复刻时已纠正：`vedio`→`sbv`、`affter`→`after`、`vaiantsNum`→`variantsNum`
