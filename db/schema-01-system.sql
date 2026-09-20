-- =====================================================================
-- Sif 后台复刻 —— 建表 SQL（Apache Doris）
--
-- 来源：docs/DATA_DICTIONARY.md（已确认版本）
-- 目标库：looom
--
-- Doris 适配要点（与 MySQL 的差异，逐条对应 goal.md 的约束）：
--   1. 全部 Unique Key 模型 + enable_unique_key_merge_on_write=true，支持按主键更新单行
--   2. 无自增主键 —— 所有 ID 由应用层雪花算法生成，BIGINT
--   3. 无外键 —— 实体关系只在应用层维护，无级联删除
--   4. 无跨行/跨表事务 —— 需要多表写入的操作在 Service 层做补偿，注释标注非原子
--   5. 每表必须 DISTRIBUTED BY HASH(主键) BUCKETS N（开发环境用 1~2）
--   6. 关键词搜索用倒排索引 INDEX ... USING INVERTED
--
-- 幂等：全部 CREATE TABLE IF NOT EXISTS，可重复执行
-- =====================================================================

CREATE DATABASE IF NOT EXISTS looom;
USE looom;

-- =====================================================================
-- A. 系统表（平台自身运行所需）
-- =====================================================================

-- A1. 用户主表
CREATE TABLE IF NOT EXISTS looom.users (
  id              BIGINT       NOT NULL COMMENT '雪花 ID（应用层生成）',
  email VARCHAR(190) NOT NULL COMMENT '登录邮箱，应用层保证唯一',
  password_hash   VARCHAR(100) NOT NULL COMMENT 'bcrypt 哈希，cost=10',
  nickname        VARCHAR(64)   COMMENT '昵称',
  avatar_url   VARCHAR(512)          COMMENT '头像地址，默认占位图',
  status        TINYINT      DEFAULT 1 COMMENT '1=正常 0=停用 2=封禁',
  default_country VARCHAR(8)   DEFAULT 'US' COMMENT '默认站点，对应原站 countryCode',
  last_login_at   DATETIME              COMMENT '最后登录时间',
  last_login_ip   VARCHAR(64)           COMMENT '最后登录 IP',
  is_deleted    TINYINT      DEFAULT 0 COMMENT '软删除标记',
  created_at      DATETIME     NOT NULL COMMENT '创建时间',
  updated_at      DATETIME  COMMENT '更新时间',
  INDEX idx_users_email (email) USING INVERTED COMMENT '登录查询用'
) ENGINE=OLAP
UNIQUE KEY(id)
COMMENT '用户主表'
DISTRIBUTED BY HASH(id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- A2. 刷新令牌
-- 说明：原站无 refresh token 机制（实测为单 token + 401 登出），此表是 goal.md 要求的新增设计
CREATE TABLE IF NOT EXISTS looom.refresh_tokens (
  id         BIGINT       NOT NULL COMMENT '雪花 ID',
  user_id    BIGINT       NOT NULL COMMENT '所属用户',
  token_hash VARCHAR(128) NOT NULL COMMENT 'refresh token 的 SHA-256，不存明文',
  expires_at DATETIME     NOT NULL COMMENT '过期时间（建议 30 天）',
  revoked_at DATETIME       COMMENT '主动吊销时间，NULL=有效',
  user_agent VARCHAR(512) COMMENT '签发时 UA，用于登录设备管理',
  ip    VARCHAR(64)       COMMENT '签发时 IP',
  created_at DATETIME     NOT NULL COMMENT '签发时间',
  INDEX idx_rt_user (user_id) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(id)
COMMENT '刷新令牌。过期清理用定时任务批量 DELETE，不要逐条删'
DISTRIBUTED BY HASH(id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- A3. 角色
CREATE TABLE IF NOT EXISTS looom.`roles` (
  id          BIGINT NOT NULL COMMENT '雪花 ID',
  code        VARCHAR(32) NOT NULL COMMENT '角色码：admin / user',
  name        VARCHAR(64) NOT NULL COMMENT '中文名',
  permissions TEXT          COMMENT 'JSON 数组，权限点列表',
  created_at  DATETIME             COMMENT '创建时间'
) ENGINE=OLAP
UNIQUE KEY(id)
COMMENT '角色表'
DISTRIBUTED BY HASH(id) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- A3b. 用户角色关联
CREATE TABLE IF NOT EXISTS looom.user_roles (
  id         BIGINT   NOT NULL COMMENT '雪花 ID',
  user_id    BIGINT   NOT NULL COMMENT '用户 ID',
  role_id    BIGINT   NOT NULL COMMENT '角色 ID',
  created_at DATETIME          COMMENT '创建时间',
  INDEX idx_ur_user (user_id) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(id)
COMMENT '用户角色关联（应用层维护，无外键）'
DISTRIBUTED BY HASH(id) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- A4. 积分账户
-- 实测：原站积分是浮点数（balanceIntegral: 100.0），故用 DECIMAL 而非 BIGINT
-- Doris 无事务、无 SELECT FOR UPDATE：扣费不能用「读余额→改余额」，并发下会丢更新
--   → 余额以 Redis 为权威值（INCRBY/DECRBY 原子操作），本表作持久化快照，定时批量回写
CREATE TABLE IF NOT EXISTS looom.credit_accounts (
  user_id     BIGINT         NOT NULL COMMENT '主键即 user_id，一人一账户',
  balance         DECIMAL(16,4)  NOT NULL DEFAULT '0' COMMENT '当前余额（实测原站为浮点）',
  total_recharged DECIMAL(16,4)  DEFAULT '0' COMMENT '累计充值',
  total_consumed  DECIMAL(16,4)  DEFAULT '0' COMMENT '累计消耗',
  frozen       DECIMAL(16,4)  DEFAULT '0' COMMENT '冻结中（AI 任务预扣，失败退还）',
  channel VARCHAR(16)    DEFAULT 'personal' COMMENT '账号渠道，实测原站返回 personal',
  integral_limit  DECIMAL(16,4)   COMMENT '积分上限，实测原站有此字段',
  version       BIGINT         DEFAULT 0 COMMENT '变更计数（仅供观察，Doris 无行锁，不能用作乐观锁）',
  updated_at      DATETIME       COMMENT '更新时间'
) ENGINE=OLAP
UNIQUE KEY(user_id)
COMMENT '积分账户（展示缓存）。⚠️ 余额权威值是 credit_transactions 的 SUM(amount)，本表 balance 仅为派生快照：Doris 并发 UPDATE 会静默丢失更新，实测 20 并发 CAS 全部报成功但只生效一次，详见 DATA_DICTIONARY C4-13'
DISTRIBUTED BY HASH(user_id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- A5. 积分流水（只追加不更新，是对账的唯一依据）
CREATE TABLE IF NOT EXISTS looom.credit_transactions (
  id      BIGINT        NOT NULL COMMENT '雪花 ID',
  user_id       BIGINT   NOT NULL COMMENT '用户 ID',
  type          VARCHAR(32)   NOT NULL COMMENT 'recharge/consume/refund/gift/expire',
  amount        DECIMAL(16,4) NOT NULL COMMENT '变动值，正=增 负=减',
  balance_after DECIMAL(16,4) NOT NULL COMMENT '变动后余额（冗余，便于对账）',
  biz_type      VARCHAR(32)          COMMENT 'query_asin/query_keyword/ai_analysis/export',
  biz_id        VARCHAR(64)    COMMENT '关联业务 ID',
  remark        VARCHAR(255)   COMMENT '备注',
  created_at    DATETIME   NOT NULL COMMENT '创建时间',
  INDEX idx_ct_user (user_id) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(id)
COMMENT '积分流水（append-only，余额的唯一权威来源）。余额 = SUM(amount)：扣费记负数、入账记正数。实测并发 INSERT 零丢失，所以用它而非可变余额列保证正确性。biz_type=concurrent_rollback 的正数行是并发超扣的补偿回滚，对账时需与正常 refund 区分'
DISTRIBUTED BY HASH(id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- A6. 查询审计
-- Doris 不适合单条高频 INSERT → 用 Stream Load 批量写入或 Redis 缓冲 + 定时刷盘
CREATE TABLE IF NOT EXISTS looom.query_logs (
  id        BIGINT     NOT NULL COMMENT '雪花 ID',
  user_id      BIGINT NOT NULL COMMENT '用户 ID',
  query_type   VARCHAR(32)  NOT NULL COMMENT 'asin / keyword / supplier',
  query_value  VARCHAR(255) NOT NULL COMMENT '查询的 ASIN 或关键词原文',
  country   VARCHAR(8)   NOT NULL COMMENT '站点',
  page_route   VARCHAR(64)           COMMENT '从哪个页面发起',
  credits_cost INT    DEFAULT 0 COMMENT '本次扣分',
  result_count INT     COMMENT '返回结果数',
  duration_ms  INT     COMMENT '耗时',
  status       TINYINT      DEFAULT 1 COMMENT '1=成功 0=失败',
  error_msg    VARCHAR(512)    COMMENT '失败原因',
  ip           VARCHAR(64)           COMMENT '来源 IP',
  created_at   DATETIME     NOT NULL COMMENT '创建时间',
  INDEX idx_ql_user  (user_id)     USING INVERTED,
  INDEX idx_ql_value (query_value) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(id)
COMMENT '查询审计。高频写入表，建议批量写'
DISTRIBUTED BY HASH(id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- A7. AI 任务
-- 状态需频繁更新（pending→running→success），Unique Key MoW 支持按主键更新但高频更新性能不佳
--   → 运行中状态放 Redis，仅在终态（success/failed）落库
CREATE TABLE IF NOT EXISTS looom.ai_tasks (
  id           BIGINT        NOT NULL COMMENT '雪花 ID',
  user_id        BIGINT        NOT NULL COMMENT '用户 ID',
  insert_point   VARCHAR(64)   NOT NULL COMMENT '插入点：sales-trend/keyword-recommend/traffic-insight/supplier-evaluate/ad-optimize/diagnosis',
  prompt_version VARCHAR(16)   NOT NULL COMMENT 'prompt 版本，如 v1',
  input_hash     VARCHAR(64) NOT NULL COMMENT '输入 SHA-256，命中缓存不重复扣费',
  input_payload  TEXT          COMMENT '输入快照 JSON，便于复现',
  status      VARCHAR(16)   NOT NULL COMMENT 'pending/running/success/failed/cancelled',
  provider  VARCHAR(32)      COMMENT 'openai-compatible / mock',
  model          VARCHAR(64)         COMMENT '实际使用的模型名',
  retry_count    TINYINT       DEFAULT 0 COMMENT '重试次数，上限 2',
  credits_frozen DECIMAL(16,4) DEFAULT '0' COMMENT '预扣积分，失败时退还',
  error_msg  VARCHAR(1024)          COMMENT '错误信息',
  started_at DATETIME      COMMENT '开始时间',
  finished_at    DATETIME            COMMENT '结束时间',
  created_at     DATETIME      NOT NULL COMMENT '创建时间',
  INDEX idx_at_hash (input_hash) USING INVERTED,
  INDEX idx_at_user (user_id)    USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(id)
COMMENT 'AI 任务。缓存命中查 (insert_point, prompt_version, input_hash) 且 status=success'
DISTRIBUTED BY HASH(id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- A8. AI 分析结果（与 ai_tasks 1:1，拆表因结果 TEXT 体积大）
CREATE TABLE IF NOT EXISTS looom.ai_analyses (
  id       BIGINT      NOT NULL COMMENT '雪花 ID',
  task_id           BIGINT      NOT NULL COMMENT '关联 ai_tasks.id',
  user_id           BIGINT    NOT NULL COMMENT '冗余，便于按用户查',
  insert_point      VARCHAR(64) NOT NULL COMMENT '冗余',
  content_md   TEXT  NOT NULL COMMENT 'Markdown 结论，前端 markdown-it 渲染',
  prompt_tokens     INT        COMMENT '输入 token 数',
  completion_tokens INT        COMMENT '输出 token 数',
  total_tokens      INT       COMMENT '计费依据',
  created_at        DATETIME    NOT NULL COMMENT '创建时间',
  INDEX idx_aa_task (task_id) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(id)
COMMENT 'AI 分析结果'
DISTRIBUTED BY HASH(id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- A9. API Key
-- 注意：原站无面向普通用户的通用 API Key 自助管理功能（实测排查三处确认），此表为 goal.md 新增设计
CREATE TABLE IF NOT EXISTS looom.api_keys (
  id           BIGINT       NOT NULL COMMENT '雪花 ID',
  user_id      BIGINT NOT NULL COMMENT '用户 ID',
  name         VARCHAR(64)  NOT NULL COMMENT '用户自定义名称',
  key_prefix   VARCHAR(16)  NOT NULL COMMENT '明文前缀，列表页只展示这个',
  key_hash     VARCHAR(128) NOT NULL COMMENT '完整 key 的 SHA-256，明文只在创建时返回一次',
  scopes       VARCHAR(255)          COMMENT '权限范围，逗号分隔',
  last_used_at DATETIME      COMMENT '最后使用时间',
  expires_at   DATETIME  COMMENT '过期时间，NULL=永不过期',
  revoked_at   DATETIME        COMMENT '吊销时间，NULL=有效',
  created_at   DATETIME     NOT NULL COMMENT '创建时间',
  INDEX idx_ak_prefix (key_prefix) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(id)
COMMENT 'API Key。明文 key 绝不落库、不进日志'
DISTRIBUTED BY HASH(id) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- A10. 系统配置（启动时全量加载进内存缓存）
CREATE TABLE IF NOT EXISTS looom.system_configs (
  config_key VARCHAR(128) NOT NULL COMMENT '主键，如 credit.cost.query_asin',
  config_value TEXT         NOT NULL COMMENT '值（标量或 JSON）',
  value_type   VARCHAR(16)  DEFAULT 'string' COMMENT 'string/int/bool/json',
  group_name   VARCHAR(32)        COMMENT '分组：credit/ai/feature_flag/limit',
  description  VARCHAR(255)          COMMENT '中文说明',
  updated_at   DATETIME          COMMENT '更新时间'
) ENGINE=OLAP
UNIQUE KEY(config_key)
COMMENT '系统配置键值对'
DISTRIBUTED BY HASH(config_key) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- A11. 用户关注/监控/订阅
-- 实测依据：asinKeywordList 响应里 isFocus / isMonitor / isSubscribe 三个标志同时并存且独立
--   → 一张表 + favorite_type 区分，而非拆三张（三者字段高度重合）
CREATE TABLE IF NOT EXISTS looom.user_favorites (
  id     BIGINT       NOT NULL COMMENT '雪花 ID',
  user_id     BIGINT       NOT NULL COMMENT '用户 ID',
  favorite_type  VARCHAR(16)  NOT NULL COMMENT 'focus 关注 / monitor 监控 / subscribe 订阅',
  target_type    VARCHAR(16)  NOT NULL COMMENT 'asin / keyword',
  target_value   VARCHAR(255) NOT NULL COMMENT 'ASIN 或关键词文本',
  keyword_id BIGINT      COMMENT '关键词时填，关联 dim_keyword',
  country        VARCHAR(8)   NOT NULL COMMENT '站点',
  group_name     VARCHAR(64)           COMMENT '用户自建分组',
  note         VARCHAR(512)  COMMENT '备注',
  notify_enabled TINYINT      DEFAULT 0 COMMENT '仅 subscribe 用：排名变动是否通知',
  created_at     DATETIME     NOT NULL COMMENT '创建时间',
  INDEX idx_uf_user (user_id) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(id)
COMMENT '用户关注/监控/订阅。应用层保证 (user_id,favorite_type,target_type,target_value,country) 唯一'
DISTRIBUTED BY HASH(id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- A12. 用户广告备注
-- 归属裁定依据（ads 域五条证据）：路径在 /api/user/ 下、UI 写「仅自己可见」、
--   用户手工录入前后台 ID 对应、完整 CRUD、独立管理页 → 属系统表而非业务表
CREATE TABLE IF NOT EXISTS looom.sys_user_ad_note (
  id    BIGINT       NOT NULL COMMENT '雪花 ID',
  user_id      BIGINT       NOT NULL COMMENT '用户 ID',
  country      VARCHAR(8)   NOT NULL COMMENT '站点',
  encrypt_campaign_id  VARCHAR(64)  NOT NULL COMMENT '关联广告活动（Sif 内部加密 ID）',
  campaign_id_a0       VARCHAR(64)           COMMENT '用户录入的后台真实活动 ID',
  campaign_name        VARCHAR(255)   COMMENT '用户录入的活动名',
  campaign_color       VARCHAR(16)      COMMENT '用户设置的标记色',
  note      VARCHAR(1024)  COMMENT '备注内容',
  created_at  DATETIME     NOT NULL COMMENT '创建时间',
  updated_at   DATETIME   COMMENT '更新时间',
  INDEX idx_uan_user (user_id) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(id)
COMMENT '用户广告备注（仅自己可见）'
DISTRIBUTED BY HASH(id) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");
