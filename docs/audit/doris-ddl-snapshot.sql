-- ===== ai_analyses (1 rows) =====
CREATE TABLE `ai_analyses` (
  `id` bigint NOT NULL COMMENT "雪花 ID",
  `task_id` bigint NOT NULL COMMENT "关联 ai_tasks.id",
  `user_id` bigint NOT NULL COMMENT "冗余，便于按用户查",
  `insert_point` varchar(64) NOT NULL COMMENT "冗余",
  `content_md` text NOT NULL COMMENT "Markdown 结论，前端 markdown-it 渲染",
  `prompt_tokens` int NULL COMMENT "输入 token 数",
  `completion_tokens` int NULL COMMENT "输出 token 数",
  `total_tokens` int NULL COMMENT "计费依据",
  `created_at` datetime NOT NULL COMMENT "创建时间",
  INDEX idx_aa_task (`task_id`) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(`id`)
COMMENT 'AI 分析结果'
DISTRIBUTED BY HASH(`id`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== ai_tasks (1 rows) =====
CREATE TABLE `ai_tasks` (
  `id` bigint NOT NULL COMMENT "雪花 ID",
  `user_id` bigint NOT NULL COMMENT "用户 ID",
  `insert_point` varchar(64) NOT NULL COMMENT "插入点：sales-trend/keyword-recommend/traffic-insight/supplier-evaluate/ad-optimize/diagnosis",
  `prompt_version` varchar(16) NOT NULL COMMENT "prompt 版本，如 v1",
  `input_hash` varchar(64) NOT NULL COMMENT "输入 SHA-256，命中缓存不重复扣费",
  `input_payload` text NULL COMMENT "输入快照 JSON，便于复现",
  `status` varchar(16) NOT NULL COMMENT "pending/running/success/failed/cancelled",
  `provider` varchar(32) NULL COMMENT "openai-compatible / mock",
  `model` varchar(64) NULL COMMENT "实际使用的模型名",
  `retry_count` tinyint NULL DEFAULT "0" COMMENT "重试次数，上限 2",
  `credits_frozen` decimal(16,4) NULL DEFAULT "0" COMMENT "预扣积分，失败时退还",
  `error_msg` varchar(1024) NULL COMMENT "错误信息",
  `started_at` datetime NULL COMMENT "开始时间",
  `finished_at` datetime NULL COMMENT "结束时间",
  `created_at` datetime NOT NULL COMMENT "创建时间",
  INDEX idx_at_hash (`input_hash`) USING INVERTED,
  INDEX idx_at_user (`user_id`) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(`id`)
COMMENT 'AI 任务。缓存命中查 (insert_point, prompt_version, input_hash) 且 status=success'
DISTRIBUTED BY HASH(`id`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== api_keys (0 rows) =====
CREATE TABLE `api_keys` (
  `id` bigint NOT NULL COMMENT "雪花 ID",
  `user_id` bigint NOT NULL COMMENT "用户 ID",
  `name` varchar(64) NOT NULL COMMENT "用户自定义名称",
  `key_prefix` varchar(16) NOT NULL COMMENT "明文前缀，列表页只展示这个",
  `key_hash` varchar(128) NOT NULL COMMENT "完整 key 的 SHA-256，明文只在创建时返回一次",
  `scopes` varchar(255) NULL COMMENT "权限范围，逗号分隔",
  `last_used_at` datetime NULL COMMENT "最后使用时间",
  `expires_at` datetime NULL COMMENT "过期时间，NULL=永不过期",
  `revoked_at` datetime NULL COMMENT "吊销时间，NULL=有效",
  `created_at` datetime NOT NULL COMMENT "创建时间",
  INDEX idx_ak_prefix (`key_prefix`) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(`id`)
COMMENT 'API Key。明文 key 绝不落库、不进日志'
DISTRIBUTED BY HASH(`id`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== credit_accounts (6 rows) =====
CREATE TABLE `credit_accounts` (
  `user_id` bigint NOT NULL COMMENT "主键即 user_id，一人一账户",
  `balance` decimal(16,4) NOT NULL DEFAULT "0" COMMENT "当前余额（实测原站为浮点）",
  `total_recharged` decimal(16,4) NULL DEFAULT "0" COMMENT "累计充值",
  `total_consumed` decimal(16,4) NULL DEFAULT "0" COMMENT "累计消耗",
  `frozen` decimal(16,4) NULL DEFAULT "0" COMMENT "冻结中（AI 任务预扣，失败退还）",
  `channel` varchar(16) NULL DEFAULT "personal" COMMENT "账号渠道，实测原站返回 personal",
  `integral_limit` decimal(16,4) NULL COMMENT "积分上限，实测原站有此字段",
  `version` bigint NULL DEFAULT "0" COMMENT "乐观锁版本号",
  `updated_at` datetime NULL COMMENT "更新时间"
) ENGINE=OLAP
UNIQUE KEY(`user_id`)
COMMENT '积分账户。余额权威值在 Redis，本表为快照'
DISTRIBUTED BY HASH(`user_id`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== credit_transactions (3 rows) =====
CREATE TABLE `credit_transactions` (
  `id` bigint NOT NULL COMMENT "雪花 ID",
  `user_id` bigint NOT NULL COMMENT "用户 ID",
  `type` varchar(32) NOT NULL COMMENT "recharge/consume/refund/gift/expire",
  `amount` decimal(16,4) NOT NULL COMMENT "变动值，正=增 负=减",
  `balance_after` decimal(16,4) NOT NULL COMMENT "变动后余额（冗余，便于对账）",
  `biz_type` varchar(32) NULL COMMENT "query_asin/query_keyword/ai_analysis/export",
  `biz_id` varchar(64) NULL COMMENT "关联业务 ID",
  `remark` varchar(255) NULL COMMENT "备注",
  `created_at` datetime NOT NULL COMMENT "创建时间",
  INDEX idx_ct_user (`user_id`) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(`id`)
COMMENT '积分流水'
DISTRIBUTED BY HASH(`id`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dict_ad_type (4 rows) =====
CREATE TABLE `dict_ad_type` (
  `code` varchar(32) NOT NULL COMMENT "枚举内部值",
  `name_cn` varchar(64) NULL COMMENT "中文展示名",
  `name_en` varchar(64) NULL COMMENT "英文名/原始值",
  `sort_order` int NULL COMMENT "展示顺序",
  `extra` varchar(255) NULL COMMENT "附加信息（颜色、别名等）"
) ENGINE=OLAP
UNIQUE KEY(`code`)
COMMENT '广告产品类型：1=SP 2=SB 3=SBV 4=SBBV'
DISTRIBUTED BY HASH(`code`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dict_bought_bucket (9 rows) =====
CREATE TABLE `dict_bought_bucket` (
  `code` varchar(32) NOT NULL COMMENT "枚举内部值",
  `name_cn` varchar(64) NULL COMMENT "中文展示名",
  `name_en` varchar(64) NULL COMMENT "英文名/原始值",
  `sort_order` int NULL COMMENT "展示顺序",
  `extra` varchar(255) NULL COMMENT "附加信息（颜色、别名等）"
) ENGINE=OLAP
UNIQUE KEY(`code`)
COMMENT '销量分档枚举'
DISTRIBUTED BY HASH(`code`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dict_dimension (3 rows) =====
CREATE TABLE `dict_dimension` (
  `code` varchar(32) NOT NULL COMMENT "枚举内部值",
  `name_cn` varchar(64) NULL COMMENT "中文展示名",
  `name_en` varchar(64) NULL COMMENT "英文名/原始值",
  `sort_order` int NULL COMMENT "展示顺序",
  `extra` varchar(255) NULL COMMENT "附加信息（颜色、别名等）"
) ENGINE=OLAP
UNIQUE KEY(`code`)
COMMENT '变体维度切换：变体/Color/Size'
DISTRIBUTED BY HASH(`code`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dict_keyword_tag (3 rows) =====
CREATE TABLE `dict_keyword_tag` (
  `code` varchar(32) NOT NULL COMMENT "枚举内部值",
  `name_cn` varchar(64) NULL COMMENT "中文展示名",
  `name_en` varchar(64) NULL COMMENT "英文名/原始值",
  `sort_order` int NULL COMMENT "展示顺序",
  `extra` varchar(255) NULL COMMENT "附加信息（颜色、别名等）"
) ENGINE=OLAP
UNIQUE KEY(`code`)
COMMENT '关键词标签：isCore/isTarget/isAC 等'
DISTRIBUTED BY HASH(`code`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dict_match_type (3 rows) =====
CREATE TABLE `dict_match_type` (
  `code` varchar(32) NOT NULL COMMENT "枚举内部值",
  `name_cn` varchar(64) NULL COMMENT "中文展示名",
  `name_en` varchar(64) NULL COMMENT "英文名/原始值",
  `sort_order` int NULL COMMENT "展示顺序",
  `extra` varchar(255) NULL COMMENT "附加信息（颜色、别名等）"
) ENGINE=OLAP
UNIQUE KEY(`code`)
COMMENT '广告匹配类型：Exact/Phrase/Broad'
DISTRIBUTED BY HASH(`code`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dict_op_event_type (6 rows) =====
CREATE TABLE `dict_op_event_type` (
  `code` varchar(32) NOT NULL COMMENT "枚举内部值",
  `name_cn` varchar(64) NULL COMMENT "中文展示名",
  `name_en` varchar(64) NULL COMMENT "英文名/原始值",
  `sort_order` int NULL COMMENT "展示顺序",
  `extra` varchar(255) NULL COMMENT "附加信息（颜色、别名等）"
) ENGINE=OLAP
UNIQUE KEY(`code`)
COMMENT '运营动作类型'
DISTRIBUTED BY HASH(`code`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dict_sort_field (4 rows) =====
CREATE TABLE `dict_sort_field` (
  `code` varchar(32) NOT NULL COMMENT "枚举内部值",
  `name_cn` varchar(64) NULL COMMENT "中文展示名",
  `name_en` varchar(64) NULL COMMENT "英文名/原始值",
  `sort_order` int NULL COMMENT "展示顺序",
  `extra` varchar(255) NULL COMMENT "附加信息（颜色、别名等）"
) ENGINE=OLAP
UNIQUE KEY(`code`)
COMMENT '列表排序字段白名单'
DISTRIBUTED BY HASH(`code`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dict_time_piece (3 rows) =====
CREATE TABLE `dict_time_piece` (
  `code` varchar(32) NOT NULL COMMENT "枚举内部值",
  `name_cn` varchar(64) NULL COMMENT "中文展示名",
  `name_en` varchar(64) NULL COMMENT "英文名/原始值",
  `sort_order` int NULL COMMENT "展示顺序",
  `extra` varchar(255) NULL COMMENT "附加信息（颜色、别名等）"
) ENGINE=OLAP
UNIQUE KEY(`code`)
COMMENT '时间粒度：day/month 可用，week 仅广告域可用'
DISTRIBUTED BY HASH(`code`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dict_traffic_channel (12 rows) =====
CREATE TABLE `dict_traffic_channel` (
  `code` varchar(32) NOT NULL COMMENT "枚举内部值",
  `name_cn` varchar(64) NULL COMMENT "中文展示名",
  `name_en` varchar(64) NULL COMMENT "英文名/原始值",
  `sort_order` int NULL COMMENT "展示顺序",
  `extra` varchar(255) NULL COMMENT "附加信息（颜色、别名等）"
) ENGINE=OLAP
UNIQUE KEY(`code`)
COMMENT '流量渠道类型。⚠️ 原站同一渠道有 5 套字段名，本表是对齐后的规范值'
DISTRIBUTED BY HASH(`code`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dict_variant_role (3 rows) =====
CREATE TABLE `dict_variant_role` (
  `code` varchar(32) NOT NULL COMMENT "枚举内部值",
  `name_cn` varchar(64) NULL COMMENT "中文展示名",
  `name_en` varchar(64) NULL COMMENT "英文名/原始值",
  `sort_order` int NULL COMMENT "展示顺序",
  `extra` varchar(255) NULL COMMENT "附加信息（颜色、别名等）"
) ENGINE=OLAP
UNIQUE KEY(`code`)
COMMENT '变体角色：父体/子体/兄弟'
DISTRIBUTED BY HASH(`code`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dim_ad_campaign (5897 rows) =====
CREATE TABLE `dim_ad_campaign` (
  `encrypt_campaign_id` varchar(64) NOT NULL COMMENT "Sif 内部加密活动 ID（主键）",
  `country` varchar(8) NOT NULL COMMENT "站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR",
  `fake_campaign_id` varchar(16) NULL COMMENT "前台短码，实测 4 位如 IW9V",
  `ad_type` tinyint NULL COMMENT "广告类型：1=SP 2=SB 3=SBV 4=SBBV",
  `product_type` varchar(32) NULL COMMENT "产品类型",
  `strategy` varchar(255) NULL COMMENT "投放策略。实测是后端算好的中文串，如「多广告组，多变体」",
  `asin_num` int NULL COMMENT "涉及 ASIN 数",
  `ad_num` int NULL COMMENT "投放小组数",
  `campaign_created_at` date NULL COMMENT "活动创建日期",
  `last_ad_created_at` date NULL COMMENT "最近新增投放小组日期",
  `created_at` datetime NOT NULL COMMENT "入库时间",
  `updated_at` datetime NULL COMMENT "更新时间"
) ENGINE=OLAP
UNIQUE KEY(`encrypt_campaign_id`, `country`)
COMMENT '广告活动。⚠️ 三套 ID 并存：fake_campaign_id 前台 4 位短码 / encrypt_campaign_id 内部加密 / campaign_id_a0 用户录入的后台真实 ID'
DISTRIBUTED BY HASH(`encrypt_campaign_id`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dim_ad_product_ad (313 rows) =====
CREATE TABLE `dim_ad_product_ad` (
  `encrypt_ad_id` varchar(64) NOT NULL COMMENT "Sif 内部加密投放小组 ID（主键）",
  `country` varchar(8) NOT NULL COMMENT "站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR",
  `fake_ad_id` varchar(16) NULL COMMENT "前台短码，实测 4 位如 FLDB",
  `ad_created_at` date NULL COMMENT "投放小组创建日期",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`encrypt_ad_id`, `country`)
COMMENT '投放小组(Product Ad)。⚠️ 不是 Amazon AdGroup —— 层级为 Campaign→AdGroup→ProductAd→变体→搜索词，而 AdGroup 层原站前端零字段故不建表'
DISTRIBUTED BY HASH(`encrypt_ad_id`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dim_asin (59912 rows) =====
CREATE TABLE `dim_asin` (
  `asin` varchar(16) NOT NULL COMMENT "ASIN 编号",
  `country` varchar(8) NOT NULL COMMENT "站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR",
  `title` varchar(1024) NULL COMMENT "商品标题",
  `img` varchar(512) NULL COMMENT "主图地址（亚马逊 CDN）",
  `price` decimal(12,2) NULL COMMENT "价格",
  `brand` varchar(255) NULL COMMENT "品牌名",
  `brand_href` varchar(512) NULL COMMENT "品牌链接",
  `score` double NULL COMMENT "评分（真实值，如 4.8）",
  `star` double NULL COMMENT "半星展示值。实测 star = round(score*2)/2，100% 成立",
  `rating_num` bigint NULL COMMENT "评价数",
  `is_best_seller` boolean NULL COMMENT "是否 BestSeller",
  `is_parent_asin` boolean NULL COMMENT "是否父体。实测父体自身无销量数据",
  `parent_asin` varchar(16) NULL COMMENT "父体 ASIN（子体填）",
  `first_available_day` date NULL COMMENT "上架日期",
  `seller` varchar(255) NULL COMMENT "卖家名",
  `data_updated_at` datetime NULL COMMENT "数据更新时间（原站毫秒时间戳转换而来）",
  `created_at` datetime NOT NULL COMMENT "入库时间",
  `updated_at` datetime NULL COMMENT "更新时间",
  INDEX idx_dim_asin_brand (`brand`) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(`asin`, `country`)
COMMENT 'ASIN 商品主档（4 个域共用）'
DISTRIBUTED BY HASH(`asin`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dim_asin_feature (43729 rows) =====
CREATE TABLE `dim_asin_feature` (
  `asin` varchar(16) NOT NULL COMMENT "ASIN 编号",
  `country` varchar(8) NOT NULL COMMENT "站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR",
  `feature_name` varchar(64) NOT NULL COMMENT "属性维度名，如 Size / Color（来自父体 features）",
  `feature_value` varchar(255) NULL COMMENT "属性取值，如 Large / Dark Moss（来自子体 features 同下标）",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`asin`, `country`, `feature_name`)
COMMENT '变体属性。实测：父体 features 是维度名 [\"Size\",\"Color\"]，子体是对应下标取值 [\"Large\",\"Dark Moss\"]，入库需按下标 zip 对齐'
DISTRIBUTED BY HASH(`asin`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dim_festival (156 rows) =====
CREATE TABLE `dim_festival` (
  `festival_name` varchar(64) NOT NULL COMMENT "节日名（中文）。实测 12 个闭合枚举，最大长度 12",
  `country` varchar(8) NOT NULL COMMENT "站点。⚠️ 必须进主键，同节日各站窗口不同",
  `start_date` date NOT NULL COMMENT "节日窗口起始日",
  `end_date` date NULL COMMENT "节日窗口结束日。实测 (name,country,start) 唯一确定 end，故不进主键",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`festival_name`, `country`, `start_date`)
COMMENT '节假日日历（12 节日 × 站点 × 年度窗口，实测 156 行）。源 sif_keyword_aba_trend.festivals'
DISTRIBUTED BY HASH(`festival_name`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dim_keyword (13070 rows) =====
CREATE TABLE `dim_keyword` (
  `keyword` varchar(128) NOT NULL COMMENT "关键词原文（主键，实测最大 128 字符）。ETL 需 btrim(lower()) 归一",
  `country` varchar(8) NOT NULL COMMENT "站点。⚠️ 必须进主键：实测 keyword_id 跨站点不唯一",
  `keyword_id` bigint NULL COMMENT "原站关键词 ID（降级为普通列）。实测仅 sif_asin_keyword 提供，覆盖率有限",
  `translate_keyword` varchar(512) NULL COMMENT "中文翻译（原站自带）",
  `est_searches_num` bigint NULL COMMENT "预估搜索量",
  `created_at` datetime NOT NULL COMMENT "入库时间",
  `updated_at` datetime NULL COMMENT "更新时间",
  INDEX idx_dim_kw_text (`keyword`) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(`keyword`, `country`)
COMMENT '关键词主档。主键 (keyword,country)——实测 keyword_id 跨站点不唯一，不可作单列主键'
DISTRIBUTED BY HASH(`keyword`) BUCKETS 4
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dim_recommend_column (143 rows) =====
CREATE TABLE `dim_recommend_column` (
  `rec_title` varchar(255) NOT NULL COMMENT "专栏英文原文（后端就用它做请求参数）",
  `country` varchar(8) NOT NULL COMMENT "站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR",
  `short_code` varchar(16) NULL COMMENT "前端硬编码短码：Media/4Star/fView/KOL/rBuy/Trend/New/tDeal/other",
  `display_name_cn` varchar(255) NULL COMMENT "中文展示名（原站无，需我们自造）",
  `first_seen_at` datetime NULL COMMENT "首次观测到的时间",
  `last_seen_at` datetime NULL COMMENT "最近观测到的时间"
) ENGINE=OLAP
UNIQUE KEY(`rec_title`, `country`)
COMMENT '推荐专栏。实测裁定为动态实体而非固定枚举：前端硬编码仅 8 个短码但实测出 17 个标题且未收敛，新标题运行时 upsert 入库'
DISTRIBUTED BY HASH(`rec_title`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dim_supplier (50 rows) =====
CREATE TABLE `dim_supplier` (
  `id` bigint NOT NULL COMMENT "雪花 ID",
  `supplier_name` varchar(255) NULL COMMENT "供应商名称",
  `offer_id` varchar(64) NULL COMMENT "1688 货源 ID",
  `title` varchar(1024) NULL COMMENT "货源标题",
  `img` varchar(512) NULL COMMENT "主图",
  `price` decimal(12,2) NULL COMMENT "价格",
  `min_order` int NULL COMMENT "起订量",
  `location` varchar(128) NULL COMMENT "地区",
  `created_at` datetime NOT NULL COMMENT "入库时间",
  INDEX idx_supplier_name (`supplier_name`) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(`id`)
COMMENT '供应商（1688 货源）。本期仅占位 UI + 表结构，不做任何采集/爬虫/对接'
DISTRIBUTED BY HASH(`id`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== dim_word (33 rows) =====
CREATE TABLE `dim_word` (
  `word` varchar(128) NOT NULL COMMENT "单词/词根",
  `country` varchar(8) NOT NULL COMMENT "站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR",
  `translate_word` varchar(255) NULL COMMENT "中文翻译",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`word`, `country`)
COMMENT '单词/词根主档。⚠️ 词频接口只返回 word 文本，无 ID 字段，只能用文本作键'
DISTRIBUTED BY HASH(`word`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_ad_search_term_exposure (0 rows) =====
CREATE TABLE `fact_ad_search_term_exposure` (
  `encrypt_ad_id` varchar(64) NOT NULL COMMENT "投放小组 ID",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `keyword` varchar(128) NOT NULL COMMENT "买家搜索词原文（主键）。改文本键后不再受 1.8% 反查率限制",
  `variant_asin` varchar(16) NOT NULL COMMENT "投放的变体 ASIN",
  `stat_date` date NOT NULL COMMENT "统计日期",
  `keyword_id` bigint NULL COMMENT "原站关键词 ID（普通列）。⚠️ 源 web-variant-ad-keywords 不返回此字段",
  `encrypt_campaign_id` varchar(64) NULL COMMENT "所属广告活动（冗余便于聚合）",
  `ad_type` tinyint NULL COMMENT "广告类型 1=SP 2=SB 3=SBV 4=SBBV。⚠️ 实测无源",
  `traffic_type` varchar(16) NULL COMMENT "流量位类型：sp/spRec/sb/sbv",
  `score` double NULL COMMENT "流量得分",
  `rank_position` int NULL COMMENT "广告位排名",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`encrypt_ad_id`, `country`, `keyword`, `variant_asin`, `stat_date`)
COMMENT '搜索词曝光快照。⚠️ 存的是买家搜索词不是投放词。源成功率仅 11.8%，数据量小'
DISTRIBUTED BY HASH(`encrypt_ad_id`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_asin_bought_monthly (809591 rows) =====
CREATE TABLE `fact_asin_bought_monthly` (
  `asin` varchar(16) NOT NULL COMMENT "ASIN 编号（只存子体，父体销量由应用层聚合）",
  `country` varchar(8) NOT NULL COMMENT "站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR",
  `stat_month` varchar(7) NOT NULL COMMENT "统计月份 YYYY-MM",
  `bought_lower_bound` bigint NULL COMMENT "分档下界整数，用于排序和计算",
  `bought_label` varchar(16) NULL COMMENT "原始分档串，用于展示。\"<50\" 无法用整数无损表达",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`asin`, `country`, `stat_month`)
COMMENT 'ASIN 月度销量。实测：序列固定 40 个月起点 2023-05；销量是字符串分档（\"200+\"/\"<50\"）故双列并存；父体无销量只存子体'
DISTRIBUTED BY HASH(`asin`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_asin_keyword_inout (8912 rows) =====
CREATE TABLE `fact_asin_keyword_inout` (
  `asin` varchar(16) NOT NULL COMMENT "ASIN 编号",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `keyword` varchar(128) NOT NULL COMMENT "关键词原文（主键）",
  `stat_date` date NOT NULL COMMENT "统计日期（源列名 data_date）",
  `change_type` varchar(16) NOT NULL COMMENT "in=进入前3页 / out=跌出前3页。⚠️ 已进主键，防同日同词既 in 又 out 被覆盖",
  `keyword_id` bigint NULL COMMENT "原站关键词 ID（普通列）",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`asin`, `country`, `keyword`, `stat_date`, `change_type`)
COMMENT 'ASIN 关键词进出前 3 页事件。change_type 已纳入主键（原设计遗漏，会静默覆盖）'
DISTRIBUTED BY HASH(`asin`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_asin_keyword_overview (3713 rows) =====
CREATE TABLE `fact_asin_keyword_overview` (
  `asin` varchar(16) NOT NULL COMMENT "ASIN 编号",
  `country` varchar(8) NOT NULL COMMENT "站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR",
  `time_piece_type` varchar(16) NOT NULL COMMENT "时间粒度：month 可用 / week 仅广告域可用",
  `time_piece_value` varchar(32) NOT NULL COMMENT "month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD",
  `is_listing_search` boolean NOT NULL COMMENT "Listing 维度还是单 ASIN 维度",
  `channel` varchar(16) NOT NULL COMMENT "渠道 code",
  `keyword_cnt` bigint NULL COMMENT "该渠道的关键词数",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`asin`, `country`, `time_piece_type`, `time_piece_value`, `is_listing_search`, `channel`)
COMMENT 'ASIN 关键词概览聚合（各渠道的关键词计数）'
DISTRIBUTED BY HASH(`asin`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_asin_keyword_score (19095 rows) =====
CREATE TABLE `fact_asin_keyword_score` (
  `asin` varchar(16) NOT NULL COMMENT "ASIN 编号",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `keyword` varchar(128) NOT NULL COMMENT "关键词原文（主键）",
  `time_piece_type` varchar(16) NOT NULL COMMENT "时间粒度",
  `time_piece_value` varchar(32) NOT NULL COMMENT "时间片值",
  `channel` varchar(16) NOT NULL COMMENT "渠道 code：nf/sp/spRec/sb/sbv 等，取值同 dict_traffic_channel",
  `keyword_id` bigint NULL COMMENT "原站关键词 ID（普通列）",
  `score` double NULL COMMENT "流量得分",
  `score_ratio` double NULL COMMENT "占比，0-1 小数存储",
  `score_change` double NULL COMMENT "得分变化量",
  `score_change_ratio` double NULL COMMENT "得分变化率",
  `contri_change_ratio` double NULL COMMENT "贡献度变化率",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`asin`, `country`, `keyword`, `time_piece_type`, `time_piece_value`, `channel`)
COMMENT 'ASIN×关键词×渠道 流量得分长表'
DISTRIBUTED BY HASH(`asin`) BUCKETS 4
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_asin_keyword_snapshot (19095 rows) =====
CREATE TABLE `fact_asin_keyword_snapshot` (
  `asin` varchar(16) NOT NULL COMMENT "ASIN 编号",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `keyword` varchar(128) NOT NULL COMMENT "关键词原文（主键）",
  `time_piece_type` varchar(16) NOT NULL COMMENT "时间粒度：month/week/day。⚠️ PG 源覆盖率仅 1.39%，ETL 需按抓取批次赋常量",
  `time_piece_value` varchar(32) NOT NULL COMMENT "month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD",
  `is_listing_search` boolean NOT NULL COMMENT "Listing 维度还是单 ASIN 维度。⚠️ PG 源覆盖率仅 0.76%",
  `keyword_id` bigint NULL COMMENT "原站关键词 ID（普通列）",
  `is_core` boolean NULL COMMENT "是否核心词。⚠️ 实测源值 100% 为 false，无区分度",
  `is_target` boolean NULL COMMENT "是否目标词。⚠️ 同上",
  `piece_max_time` date NULL COMMENT "该时间片的数据截止日",
  `nf_last_rank` int NULL COMMENT "自然位最新排名",
  `nf_last_rank_time` datetime NULL COMMENT "自然位排名时间。⚠️ 源是 epoch 毫秒，需转换",
  `nf_last_rank_asin` varchar(16) NULL COMMENT "自然位命中的变体 ASIN",
  `sp_last_rank` int NULL COMMENT "SP 广告位最新排名",
  `sp_last_rank_time` datetime NULL COMMENT "SP 排名时间（epoch 毫秒转换）",
  `sp_last_rank_asin` varchar(16) NULL COMMENT "SP 命中的变体 ASIN",
  `sp_campaign_id` varchar(64) NULL COMMENT "关联广告活动（跨域，应用层维护）",
  `listing_score_ratio` double NULL COMMENT "该词在整个 Listing 中的占比。⚠️ 实测无源",
  `exposure_positions` varchar(255) NULL COMMENT "曝光流量位，逗号分隔。⚠️ 源用 recSp，本库规范 spRec，ETL 需映射",
  `est_searches_num` bigint NULL COMMENT "预估搜索量",
  `created_at` datetime NOT NULL COMMENT "入库时间",
  INDEX idx_fakst_kw (`keyword`) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(`asin`, `country`, `keyword`, `time_piece_type`, `time_piece_value`, `is_listing_search`)
COMMENT 'ASIN×关键词 流量与排名快照（反查流量词主表）'
DISTRIBUTED BY HASH(`asin`) BUCKETS 4
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_asin_listing_snapshot (51880 rows) =====
CREATE TABLE `fact_asin_listing_snapshot` (
  `asin` varchar(16) NOT NULL COMMENT "ASIN 编号",
  `country` varchar(8) NOT NULL COMMENT "站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR",
  `stat_month` varchar(7) NOT NULL COMMENT "统计月份 YYYY-MM",
  `price` decimal(12,2) NULL COMMENT "当月价格",
  `score` double NULL COMMENT "当月评分",
  `rating_num` bigint NULL COMMENT "当月评价数",
  `bsr` bigint NULL COMMENT "当月 BSR 排名",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`asin`, `country`, `stat_month`)
COMMENT 'Listing 指标月度快照（价格、评分、评价数等随时间变化的指标）'
DISTRIBUTED BY HASH(`asin`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_asin_multinf_daily (10911 rows) =====
CREATE TABLE `fact_asin_multinf_daily` (
  `asin` varchar(16) NOT NULL COMMENT "ASIN 编号",
  `country` varchar(8) NOT NULL COMMENT "站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR",
  `stat_date` date NOT NULL COMMENT "统计日期",
  `asin_cnt` int NULL COMMENT "当日占位变体数",
  `keyword_cnt` int NULL COMMENT "当日关键词数",
  `score` double NULL COMMENT "自然位流量得分",
  `extra_score` double NULL COMMENT "多变体额外获得的自然流量得分",
  `listing_asin_cnt` int NULL COMMENT "Listing 变体总数",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`asin`, `country`, `stat_date`)
COMMENT '多变体自然位日快照。实测此接口无 timePiece 参数，直接返回逐日 dates 数组'
DISTRIBUTED BY HASH(`asin`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_asin_multinf_keyword (4453 rows) =====
CREATE TABLE `fact_asin_multinf_keyword` (
  `asin` varchar(16) NOT NULL COMMENT "ASIN 编号",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `keyword` varchar(128) NOT NULL COMMENT "关键词原文（主键）",
  `time_piece_type` varchar(16) NOT NULL COMMENT "时间粒度",
  `time_piece_value` varchar(32) NOT NULL COMMENT "时间片值",
  `keyword_id` bigint NULL COMMENT "原站关键词 ID（普通列）。本表源 multiNfInfo 自带 ID，填充率高",
  `avg_rank` double NULL COMMENT "区间平均自然位排名。⚠️ 源无此字段，需 ETL 聚合自算",
  `appear_days` int NULL COMMENT "区间内出现天数。⚠️ 同上需自算",
  `asin_cnt` int NULL COMMENT "同时占位的变体数。⚠️ 同上需自算",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`asin`, `country`, `keyword`, `time_piece_type`, `time_piece_value`)
COMMENT 'ASIN×关键词 多变体区间聚合。源 asin-keyword-list.multiNfInfo'
DISTRIBUTED BY HASH(`asin`) BUCKETS 4
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_asin_multinf_keyword_variant (14935 rows) =====
CREATE TABLE `fact_asin_multinf_keyword_variant` (
  `parent_asin` varchar(16) NOT NULL COMMENT "父体/主查 ASIN",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `keyword` varchar(128) NOT NULL COMMENT "关键词原文（主键）",
  `variant_asin` varchar(16) NOT NULL COMMENT "变体 ASIN",
  `time_piece_type` varchar(16) NOT NULL COMMENT "时间粒度",
  `time_piece_value` varchar(32) NOT NULL COMMENT "时间片值",
  `keyword_id` bigint NULL COMMENT "原站关键词 ID（普通列）",
  `rank_position` int NULL COMMENT "全局自然位排名（源 asins[].rank）",
  `page_num` int NULL COMMENT "页码（源 asins[].pageNum）。⚠️ 勿取上层 dateAsins[].pageNum，那层恒 NULL",
  `page_rank` int NULL COMMENT "页内位次（源 asins[].pageRank）",
  `page_size` int NULL COMMENT "页容量（源 asins[].pageSize）",
  `img` varchar(512) NULL COMMENT "变体主图（源 asins[].img）",
  `variant_role` varchar(16) NULL COMMENT "变体角色。⚠️ 实测无源，可按 rank 最小=主曝光变体推导",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`parent_asin`, `country`, `keyword`, `variant_asin`, `time_piece_type`, `time_piece_value`)
COMMENT '关键词×变体 自然排名明细。源 multiNfInfo.dateAsins[].asins[]，76,469 行明细'
DISTRIBUTED BY HASH(`parent_asin`) BUCKETS 4
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_asin_op_event (73607 rows) =====
CREATE TABLE `fact_asin_op_event` (
  `asin` varchar(16) NOT NULL COMMENT "ASIN 编号",
  `country` varchar(8) NOT NULL COMMENT "站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR",
  `stat_date` date NOT NULL COMMENT "事件发生日期",
  `event_type` varchar(32) NOT NULL COMMENT "事件类型：titleImg 改标题图片 / campaignId 新增广告活动 / 价格活动等",
  `event_detail` text NULL COMMENT "事件详情（如字符级 diff 区间、活动 ID）",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`asin`, `country`, `stat_date`, `event_type`)
COMMENT '运营动作事件。实测是系统识别的变化点（非用户标注）。与流量快照拆表：粒度不同（事件按天离散）、稀疏、且只追加不覆盖'
DISTRIBUTED BY HASH(`asin`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_asin_rec_column_period (64 rows) =====
CREATE TABLE `fact_asin_rec_column_period` (
  `asin` varchar(16) NOT NULL COMMENT "ASIN 编号",
  `country` varchar(8) NOT NULL COMMENT "站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR",
  `rec_title` varchar(255) NOT NULL COMMENT "推荐专栏英文原文",
  `stat_date` date NOT NULL COMMENT "统计日期（只存有值的天）",
  `ratio` double NULL COMMENT "流量贡献占比",
  `campaign_cnt` int NULL COMMENT "该专栏位的广告活动数",
  `keyword_cnt` int NULL COMMENT "该专栏位的关键词数",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`asin`, `country`, `rec_title`, `stat_date`)
COMMENT 'ASIN×推荐专栏 曝光。⚠️ 混合粒度：实测传 month 但返回逐日 dates，且极度稀疏（31 天仅 1 天有值）→ 只存非 null 的天'
DISTRIBUTED BY HASH(`asin`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_asin_subbsr_snapshot (1654767 rows) =====
CREATE TABLE `fact_asin_subbsr_snapshot` (
  `asin` varchar(16) NOT NULL COMMENT "ASIN 编号",
  `country` varchar(8) NOT NULL COMMENT "站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR",
  `cat_name` varchar(255) NOT NULL COMMENT "子类目名称（原为动态 key）",
  `stat_date` date NOT NULL COMMENT "统计日期。⚠️ 分区列，AUTO PARTITION 按月",
  `bsr` bigint NULL COMMENT "BSR 排名",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`asin`, `country`, `cat_name`, `stat_date`)
COMMENT 'ASIN 子类目 BSR 排名快照。⚠️ 原响应是动态 key 对象 {类目名:值}，入库须拆成行。按月自动分区'
AUTO PARTITION BY RANGE (date_trunc(`stat_date`, 'month'))
(PARTITION p20230101000000 VALUES [('2023-01-01'), ('2023-02-01')),
PARTITION p20230201000000 VALUES [('2023-02-01'), ('2023-03-01')),
PARTITION p20230301000000 VALUES [('2023-03-01'), ('2023-04-01')),
PARTITION p20230401000000 VALUES [('2023-04-01'), ('2023-05-01')),
PARTITION p20230501000000 VALUES [('2023-05-01'), ('2023-06-01')),
PARTITION p20230601000000 VALUES [('2023-06-01'), ('2023-07-01')),
PARTITION p20230701000000 VALUES [('2023-07-01'), ('2023-08-01')),
PARTITION p20230801000000 VALUES [('2023-08-01'), ('2023-09-01')),
PARTITION p20230901000000 VALUES [('2023-09-01'), ('2023-10-01')),
PARTITION p20231001000000 VALUES [('2023-10-01'), ('2023-11-01')),
PARTITION p20231101000000 VALUES [('2023-11-01'), ('2023-12-01')),
PARTITION p20231201000000 VALUES [('2023-12-01'), ('2024-01-01')),
PARTITION p20240101000000 VALUES [('2024-01-01'), ('2024-02-01')),
PARTITION p20240201000000 VALUES [('2024-02-01'), ('2024-03-01')),
PARTITION p20240301000000 VALUES [('2024-03-01'), ('2024-04-01')),
PARTITION p20240401000000 VALUES [('2024-04-01'), ('2024-05-01')),
PARTITION p20240501000000 VALUES [('2024-05-01'), ('2024-06-01')),
PARTITION p20240601000000 VALUES [('2024-06-01'), ('2024-07-01')),
PARTITION p20240701000000 VALUES [('2024-07-01'), ('2024-08-01')),
PARTITION p20240801000000 VALUES [('2024-08-01'), ('2024-09-01')),
PARTITION p20240901000000 VALUES [('2024-09-01'), ('2024-10-01')),
PARTITION p20241001000000 VALUES [('2024-10-01'), ('2024-11-01')),
PARTITION p20241101000000 VALUES [('2024-11-01'), ('2024-12-01')),
PARTITION p20241201000000 VALUES [('2024-12-01'), ('2025-01-01')),
PARTITION p20250101000000 VALUES [('2025-01-01'), ('2025-02-01')),
PARTITION p20250201000000 VALUES [('2025-02-01'), ('2025-03-01')),
PARTITION p20250301000000 VALUES [('2025-03-01'), ('2025-04-01')),
PARTITION p20250401000000 VALUES [('2025-04-01'), ('2025-05-01')),
PARTITION p20250501000000 VALUES [('2025-05-01'), ('2025-06-01')),
PARTITION p20250601000000 VALUES [('2025-06-01'), ('2025-07-01')),
PARTITION p20250701000000 VALUES [('2025-07-01'), ('2025-08-01')),
PARTITION p20250801000000 VALUES [('2025-08-01'), ('2025-09-01')),
PARTITION p20250901000000 VALUES [('2025-09-01'), ('2025-10-01')),
PARTITION p20251001000000 VALUES [('2025-10-01'), ('2025-11-01')),
PARTITION p20251101000000 VALUES [('2025-11-01'), ('2025-12-01')),
PARTITION p20251201000000 VALUES [('2025-12-01'), ('2026-01-01')),
PARTITION p20260101000000 VALUES [('2026-01-01'), ('2026-02-01')),
PARTITION p20260201000000 VALUES [('2026-02-01'), ('2026-03-01')),
PARTITION p20260301000000 VALUES [('2026-03-01'), ('2026-04-01')),
PARTITION p20260401000000 VALUES [('2026-04-01'), ('2026-05-01')),
PARTITION p20260501000000 VALUES [('2026-05-01'), ('2026-06-01')),
PARTITION p20260601000000 VALUES [('2026-06-01'), ('2026-07-01')),
PARTITION p20260701000000 VALUES [('2026-07-01'), ('2026-08-01')),
PARTITION p20260801000000 VALUES [('2026-08-01'), ('2026-09-01')),
PARTITION p20260901000000 VALUES [('2026-09-01'), ('2026-10-01')))
DISTRIBUTED BY HASH(`asin`) BUCKETS 8
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_asin_traffic_channel (149460 rows) =====
CREATE TABLE `fact_asin_traffic_channel` (
  `asin` varchar(16) NOT NULL COMMENT "ASIN 编号",
  `country` varchar(8) NOT NULL COMMENT "站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR",
  `time_piece_type` varchar(16) NOT NULL COMMENT "时间粒度：month 可用 / week 仅广告域可用",
  `time_piece_value` varchar(32) NOT NULL COMMENT "month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD",
  `channel` varchar(16) NOT NULL COMMENT "渠道：total/nf/ad/allSp/sp/spRec/allSb/sb/sbv。⚠️ 响应里的 recSp 须归一为 spRec",
  `score` double NULL COMMENT "流量得分（实测为浮点，如 2859.33）",
  `score_ratio` double NULL COMMENT "占比，0-1 小数存储（前端负责乘 100 展示）",
  `score_change` double NULL COMMENT "得分变化量",
  `score_change_ratio` double NULL COMMENT "得分变化率，可为 NULL",
  `contri_change_ratio` double NULL COMMENT "贡献度变化率",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`asin`, `country`, `time_piece_type`, `time_piece_value`, `channel`)
COMMENT 'ASIN 分渠道流量（长表）。用户已裁决用长表：渠道是 9 个同构对象，宽表需 45 列且新增渠道要改表结构'
DISTRIBUTED BY HASH(`asin`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_keyword_bid_estimate (33019 rows) =====
CREATE TABLE `fact_keyword_bid_estimate` (
  `keyword` varchar(128) NOT NULL COMMENT "关键词原文（主键）。ETL 需 btrim(lower()) 归一",
  `country` varchar(8) NOT NULL COMMENT "站点。⚠️ 必须进主键：keyword_id 跨站点不唯一",
  `stat_week` date NOT NULL COMMENT "ABA 周起始日。源 data.weekDate，实测 100% 填充",
  `match_type` varchar(32) NOT NULL COMMENT "投放类型：autoForSales_/legacyForSales_ × broad/phrase/exact 共 6 种",
  `keyword_id` bigint NULL COMMENT "原站关键词 ID（普通列，仅供对账）",
  `acos_start` double NULL COMMENT "ACOS 悲观档（值最大）。实测 91~92% 填充，0.0947~39.87",
  `acos_median` double NULL COMMENT "ACOS 中位档。实测 0.034~9.19",
  `acos_end` double NULL COMMENT "ACOS 乐观档（值最小）。实测 0.0017~4.17",
  `cpa_start` decimal(12,4) NULL COMMENT "CPA 悲观档。实测 0.846~220.0",
  `cpa_median` decimal(12,4) NULL COMMENT "CPA 中位档。实测 1.067~293.3",
  `cpa_end` decimal(12,4) NULL COMMENT "CPA 乐观档。实测 1.333~366.7（故用 12,4 不用 10,2）",
  `created_at` datetime NOT NULL COMMENT "入库时间",
  INDEX idx_bid_kw (`keyword`) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(`keyword`, `country`, `stat_week`, `match_type`)
COMMENT '关键词 ACOS/CPA 分档预估。源 web-keyword-conversion。start/median/end 是悲观/中位/乐观三档，非区间端点'
DISTRIBUTED BY HASH(`keyword`) BUCKETS 4
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_keyword_competition_snapshot (21328 rows) =====
CREATE TABLE `fact_keyword_competition_snapshot` (
  `keyword` varchar(128) NOT NULL COMMENT "关键词原文（主键）",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `stat_week` date NOT NULL COMMENT "ABA 周起始日（源 aba_date）",
  `stat_week_end` date NULL COMMENT "ABA 周结束日（源 abaDateEnd，100% 填充）",
  `keyword_id` bigint NULL COMMENT "原站关键词 ID（普通列）",
  `nf_asin_num` int NULL COMMENT "自然位 ASIN 数。实测 max 573，非零率 52.5%",
  `sp_ad_asin_num` int NULL COMMENT "SP 广告 ASIN 数。实测 max 205",
  `brand_ad_asin_num` int NULL COMMENT "品牌广告 ASIN 数。实测 max 213",
  `ppc_ad_asin_num` int NULL COMMENT "PPC 广告 ASIN 数。实测 max 402",
  `search_recommend_asin_num` int NULL COMMENT "搜索推荐 ASIN 数。实测 max 180",
  `video_ad_asin_num` int NULL COMMENT "视频广告 ASIN 数。实测 max 38（上游拼写 vedio）",
  `sale_num` bigint NULL COMMENT "销量。实测 max 435,865",
  `global_keyword_num` bigint NULL COMMENT "全局关键词数。实测 max 1,000,000，填充 100%",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`keyword`, `country`, `stat_week`)
COMMENT '关键词竞争格局快照。改文本键后可灌 21,276 行（原 3,244 行 = 15.2%）'
DISTRIBUTED BY HASH(`keyword`) BUCKETS 4
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_keyword_conversion_funnel (5875 rows) =====
CREATE TABLE `fact_keyword_conversion_funnel` (
  `keyword` varchar(128) NOT NULL COMMENT "关键词原文（主键）。实测最大长度 66",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `stat_week` date NOT NULL COMMENT "ABA 周起始日（源 period）",
  `keyword_id` bigint NULL COMMENT "原站关键词 ID（普通列）。⚠️ 源 web-keyword-conversion 不返回此字段",
  `search_volume` bigint NULL COMMENT "搜索量。实测 61 ~ 717,552",
  `click_volume` bigint NULL COMMENT "点击量。实测 45 ~ 182,920",
  `purchase_volume` bigint NULL COMMENT "购买量。实测 0 ~ 7,867",
  `search_click_ratio` double NULL COMMENT "搜索点击率。实测 0.0138 ~ 0.7979",
  `search_purchase_ratio` double NULL COMMENT "搜索购买率。实测 0.0 ~ 0.2838",
  `click_shared` double NULL COMMENT "点击份额。实测 0.0242 ~ 0.9194",
  `conversion_shared` double NULL COMMENT "转化份额。实测 0.0021 ~ 1.0，填充 79.9%",
  `avg_kw_price` decimal(12,2) NULL COMMENT "关键词平均价。实测 6.74 ~ 793.70",
  `max_kw_price` decimal(12,2) NULL COMMENT "关键词最高价。实测 max 35,690.36（故用 12,2）",
  `min_kw_price` decimal(12,2) NULL COMMENT "关键词最低价。实测 0.87 ~ 59.90",
  `source` varchar(16) NULL COMMENT "数据来源。实测恒为 mix",
  `created_at` datetime NOT NULL COMMENT "入库时间",
  `click_purchase_ratio` double NULL COMMENT "点击购买率（分母是点击数，区别于 search_purchase_ratio 的分母是搜索数）。源 clickPurchaseRatio，实测 100%，0~0.2877"
) ENGINE=OLAP
UNIQUE KEY(`keyword`, `country`, `stat_week`)
COMMENT '关键词 ABA 转化漏斗。改文本键后可灌 9,038 行（原 854 行 = 9.4%）'
DISTRIBUTED BY HASH(`keyword`) BUCKETS 4
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_keyword_metric_snapshot (22320 rows) =====
CREATE TABLE `fact_keyword_metric_snapshot` (
  `keyword` varchar(128) NOT NULL COMMENT "关键词原文（主键）",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `granularity` varchar(16) NOT NULL COMMENT "粒度：week/month。⚠️ 实测无 day 粒度数据",
  `stat_date` date NOT NULL COMMENT "统计日期（周月粒度取区间起始日）",
  `stat_date_end` date NULL COMMENT "ABA 周结束日（源 abaDateEnd，100% 填充）",
  `keyword_id` bigint NULL COMMENT "原站关键词 ID（普通列）",
  `est_searches_num` bigint NULL COMMENT "预估搜索量",
  `searches_rank` bigint NULL COMMENT "ABA 搜索排名",
  `cpc_bid` decimal(12,2) NULL COMMENT "建议竞价。⚠️ 源 cpc 是 6 种投放组合的对象，需选投影",
  `click_purchase_ratio` double NULL COMMENT "点击转化率（源 clickPurchaseRatio）",
  `created_at` datetime NOT NULL COMMENT "入库时间",
  `nf_asin_num` int NULL COMMENT "自然位竞品数。源 nfAsinNum，实测 100% 填充，47~440",
  `ppc_asin_num` int NULL COMMENT "广告位竞品数（SP+SB+SBV 合计）。源 ppcAsinNum，实测 100%，16~365",
  `sp_asin_num` int NULL COMMENT "SP 广告竞品数。源 spAsinNum，实测 100%，0~179",
  `sp_recommended_asin_num` int NULL COMMENT "SP 推荐位竞品数。源 spRecommendedAsinNum，实测 100%，0~270",
  `recommended_asin_num` int NULL COMMENT "推荐位竞品数。源 recommendedAsinNum，实测 100%，0~145",
  `brand_asin_num` int NULL COMMENT "品牌位竞品数。源 brandAsinNum，实测 100%，0~179",
  `ac_asin_num` int NULL COMMENT "AC（Amazon Choice）位竞品数。⚠️ 源 acAsinNum 实测恒 0，无区分度，建列仅供观察",
  `sale_num` bigint NULL COMMENT "关键词带来的总销量。源 saleNum，实测 100%，0~424,204",
  `click_shared` double NULL COMMENT "点击份额。源 clickShared，实测 81.3%，0~0.6396",
  `conversion_shared` double NULL COMMENT "转化份额。源 conversionShared，实测 81.3%，0~0.75"
) ENGINE=OLAP
UNIQUE KEY(`keyword`, `country`, `granularity`, `stat_date`)
COMMENT '关键词自身指标快照（搜索量、CPC、点击转化率等，与 ASIN 无关）'
DISTRIBUTED BY HASH(`keyword`) BUCKETS 4
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_keyword_rank_history (117740 rows) =====
CREATE TABLE `fact_keyword_rank_history` (
  `asin` varchar(16) NOT NULL COMMENT "ASIN 编号",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `keyword` varchar(128) NOT NULL COMMENT "关键词原文（主键）",
  `rank_type` varchar(16) NOT NULL COMMENT "排名类型：nf/sp/sb/sbv/recSp（原设计只有 nf/sp，漏 3 种）",
  `stat_date` date NOT NULL COMMENT "统计日期（按 allRankHistory.date[] 下标对齐）。⚠️ 分区列",
  `keyword_id` bigint NULL COMMENT "原站关键词 ID（普通列）",
  `rank_position` double NULL COMMENT "全局排名。⚠️ 改 DOUBLE：sb/sbv 的 rank 100% 带小数编码版位",
  `page_no` int NULL COMMENT "页码，从 rankStr 的 ^p(d+) 解析。sb/sbv/recSp 无页码概念",
  `page_size` int NULL COMMENT "页容量，从 rankStr 的 /(d+)$ 解析。实测非固定 48（还有 16/49/47/46/40）",
  `slot` varchar(16) NULL COMMENT "版位：top/middle/bottom/tail。仅 sb/sbv 有，来自 rankStr 第 3 段",
  `asin_order` int NULL COMMENT "同位次内序号。实测 sb/sbv 100% 非空，nf/sp 100% NULL",
  `campaign_id` varchar(64) NULL COMMENT "广告活动 ID。实测 sp/sb/sbv 有值，nf 恒 NULL",
  `mask_campaign_id` varchar(16) NULL COMMENT "前台 4 位短码（源 maskCampaignId）",
  `created_at` datetime NOT NULL COMMENT "入库时间",
  INDEX idx_rank_kw (`keyword`) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(`asin`, `country`, `keyword`, `rank_type`, `stat_date`)
COMMENT 'ASIN×关键词 排名历史（日粒度）。主源 sif_asin_keyword.raw->allRankHistory。按月自动分区'
AUTO PARTITION BY RANGE (date_trunc(`stat_date`, 'month'))
(PARTITION p20260701000000 VALUES [('2026-07-01'), ('2026-08-01')),
PARTITION p20260801000000 VALUES [('2026-08-01'), ('2026-09-01')),
PARTITION p20260901000000 VALUES [('2026-09-01'), ('2026-10-01')))
DISTRIBUTED BY HASH(`asin`) BUCKETS 4
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_keyword_search_trend (178046 rows) =====
CREATE TABLE `fact_keyword_search_trend` (
  `keyword` varchar(128) NOT NULL COMMENT "关键词原文（主键）",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `granularity` varchar(16) NOT NULL COMMENT "粒度：week/month",
  `stat_date` date NOT NULL COMMENT "统计日期。⚠️ month 源格式 YYYY-MM 需补 -01",
  `is_prev_period` boolean NOT NULL COMMENT "false=本期 true=上期对照（源 estSearchesNumHistoryPrev）",
  `keyword_id` bigint NULL COMMENT "原站关键词 ID（普通列）",
  `searches_num` bigint NULL COMMENT "搜索量。⚠️ ext_search_volume 与 keyword_search_vol 语义不同，勿混用",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`keyword`, `country`, `granularity`, `stat_date`, `is_prev_period`)
COMMENT '关键词搜索量趋势。is_prev_period 区分本期与上期（用于环比）'
DISTRIBUTED BY HASH(`keyword`) BUCKETS 4
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== fact_word_frequency (0 rows) =====
CREATE TABLE `fact_word_frequency` (
  `scope_type` varchar(16) NOT NULL COMMENT "范围类型：asin / keyword_group",
  `scope_key` varchar(64) NOT NULL COMMENT "范围键：ASIN 编号或分组 ID",
  `country` varchar(8) NOT NULL COMMENT "站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR",
  `time_piece_type` varchar(16) NOT NULL COMMENT "时间粒度：month 可用 / week 仅广告域可用",
  `time_piece_value` varchar(32) NOT NULL COMMENT "month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD",
  `word_model` varchar(16) NOT NULL COMMENT "词频模型：搜索量加权 / 出现次数",
  `word` varchar(128) NOT NULL COMMENT "单词",
  `frq` bigint NULL COMMENT "词频值",
  `search_weight` double NULL COMMENT "搜索量权重",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`scope_type`, `scope_key`, `country`, `time_piece_type`, `time_piece_value`, `word_model`, `word`)
COMMENT '词频聚合。scope_type/scope_key 区分 ASIN 维度还是词库分组维度（两接口共用一张表）'
DISTRIBUTED BY HASH(`scope_type`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== query_logs (82 rows) =====
CREATE TABLE `query_logs` (
  `id` bigint NOT NULL COMMENT "雪花 ID",
  `user_id` bigint NOT NULL COMMENT "用户 ID",
  `query_type` varchar(32) NOT NULL COMMENT "asin / keyword / supplier",
  `query_value` varchar(255) NOT NULL COMMENT "查询的 ASIN 或关键词原文",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `page_route` varchar(64) NULL COMMENT "从哪个页面发起",
  `credits_cost` int NULL DEFAULT "0" COMMENT "本次扣分",
  `result_count` int NULL COMMENT "返回结果数",
  `duration_ms` int NULL COMMENT "耗时",
  `status` tinyint NULL DEFAULT "1" COMMENT "1=成功 0=失败",
  `error_msg` varchar(512) NULL COMMENT "失败原因",
  `ip` varchar(64) NULL COMMENT "来源 IP",
  `created_at` datetime NOT NULL COMMENT "创建时间",
  INDEX idx_ql_user (`user_id`) USING INVERTED,
  INDEX idx_ql_value (`query_value`) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(`id`)
COMMENT '查询审计。高频写入表，建议批量写'
DISTRIBUTED BY HASH(`id`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== refresh_tokens (80 rows) =====
CREATE TABLE `refresh_tokens` (
  `id` bigint NOT NULL COMMENT "雪花 ID",
  `user_id` bigint NOT NULL COMMENT "所属用户",
  `token_hash` varchar(128) NOT NULL COMMENT "refresh token 的 SHA-256，不存明文",
  `expires_at` datetime NOT NULL COMMENT "过期时间（建议 30 天）",
  `revoked_at` datetime NULL COMMENT "主动吊销时间，NULL=有效",
  `user_agent` varchar(512) NULL COMMENT "签发时 UA，用于登录设备管理",
  `ip` varchar(64) NULL COMMENT "签发时 IP",
  `created_at` datetime NOT NULL COMMENT "签发时间",
  INDEX idx_rt_user (`user_id`) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(`id`)
COMMENT '刷新令牌。过期清理用定时任务批量 DELETE，不要逐条删'
DISTRIBUTED BY HASH(`id`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== rel_ad_campaign_product_ad (123 rows) =====
CREATE TABLE `rel_ad_campaign_product_ad` (
  `encrypt_campaign_id` varchar(64) NOT NULL COMMENT "广告活动 ID",
  `encrypt_ad_id` varchar(64) NOT NULL COMMENT "投放小组 ID",
  `country` varchar(8) NOT NULL COMMENT "站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR",
  `stat_date` date NOT NULL COMMENT "该关系成立的日期（周起始日）",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`encrypt_campaign_id`, `encrypt_ad_id`, `country`, `stat_date`)
COMMENT '广告活动→投放小组（时序关系表）。⚠️ 实测 campaigns[].ads 是按日期分组的对象，同一活动各周包含的投放小组会变，故主键必须带 stat_date'
DISTRIBUTED BY HASH(`encrypt_campaign_id`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== rel_asin_keyword_variant_exposure (0 rows) =====
CREATE TABLE `rel_asin_keyword_variant_exposure` (
  `parent_asin` varchar(16) NOT NULL COMMENT "父体/主查 ASIN",
  `variant_asin` varchar(16) NOT NULL COMMENT "变体 ASIN",
  `keyword` varchar(128) NOT NULL COMMENT "关键词原文（主键）",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `time_piece_type` varchar(16) NOT NULL COMMENT "时间粒度",
  `time_piece_value` varchar(32) NOT NULL COMMENT "时间片值",
  `keyword_id` bigint NULL COMMENT "原站关键词 ID（普通列）",
  `score` double NULL COMMENT "该变体在该词上的曝光得分",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`parent_asin`, `variant_asin`, `keyword`, `country`, `time_piece_type`, `time_piece_value`)
COMMENT 'ASIN×关键词×变体 曝光关系'
DISTRIBUTED BY HASH(`parent_asin`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== rel_asin_variant (12745 rows) =====
CREATE TABLE `rel_asin_variant` (
  `parent_asin` varchar(16) NOT NULL COMMENT "父体 ASIN",
  `child_asin` varchar(16) NOT NULL COMMENT "子体 ASIN",
  `country` varchar(8) NOT NULL COMMENT "站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR",
  `display_order` int NULL COMMENT "展示顺序（实测 order 字段，0=汇总行）",
  `ratio` double NULL COMMENT "该变体的流量占比",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`parent_asin`, `child_asin`, `country`)
COMMENT '父子体变体组关系'
DISTRIBUTED BY HASH(`parent_asin`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== rel_keyword_group (0 rows) =====
CREATE TABLE `rel_keyword_group` (
  `group_id` bigint NOT NULL COMMENT "分组 ID",
  `keyword` varchar(128) NOT NULL COMMENT "关键词原文（主键）",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `keyword_id` bigint NULL COMMENT "原站关键词 ID（普通列）",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`group_id`, `keyword`, `country`)
COMMENT '关键词分组（用户词库）'
DISTRIBUTED BY HASH(`group_id`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== rel_keyword_top_asin (56795 rows) =====
CREATE TABLE `rel_keyword_top_asin` (
  `keyword` varchar(128) NOT NULL COMMENT "关键词原文（主键）",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `asin` varchar(16) NOT NULL COMMENT "ASIN 编号",
  `keyword_id` bigint NULL COMMENT "原站关键词 ID（普通列）",
  `rank_position` int NULL COMMENT "排名位置",
  `img` varchar(512) NULL COMMENT "商品主图（源 topAsins[].img，100% 非空）",
  `title` varchar(1024) NULL COMMENT "商品标题（源 topAsins[].title，100% 非空）",
  `price` decimal(12,2) NULL COMMENT "价格（源 topAsins[].price，99.99% 非空）",
  `created_at` datetime NOT NULL COMMENT "入库时间",
  `asin_role` varchar(8) NULL COMMENT "ASIN 角色：top=头部商品（源 topAsins[]，每词 8~10 个）/ conv=有转化数据（源 asinsClickPurchaseRatio[]，每词 0~3 个）。历史行为 NULL，按 top 处理",
  `click_purchase_ratio` double NULL COMMENT "该 ASIN 在此关键词下的点击购买率。源 asinsClickPurchaseRatio[].clickPurchaseRatio，实测 0~1.3746。asin_role=top 的行为 NULL"
) ENGINE=OLAP
UNIQUE KEY(`keyword`, `country`, `asin`)
COMMENT '关键词头部 ASIN。源 web-keyword-conversion.topAsins[]，90,374 个元素'
DISTRIBUTED BY HASH(`keyword`) BUCKETS 4
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== rel_rec_column_campaign_keyword (9086 rows) =====
CREATE TABLE `rel_rec_column_campaign_keyword` (
  `asin` varchar(16) NOT NULL COMMENT "ASIN 编号",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `rec_title` varchar(255) NOT NULL COMMENT "推荐专栏英文原文",
  `keyword` varchar(128) NOT NULL COMMENT "关键词原文（主键）",
  `encrypt_campaign_id` varchar(64) NOT NULL COMMENT "广告活动 ID",
  `keyword_id` bigint NULL COMMENT "原站关键词 ID（普通列）。本表源自带 ID，填充率 100%",
  `mask_campaign_id` varchar(16) NULL COMMENT "前台 4 位短码（源同元素的 maskCampaignId）",
  `created_at` datetime NOT NULL COMMENT "入库时间"
) ENGINE=OLAP
UNIQUE KEY(`asin`, `country`, `rec_title`, `keyword`, `encrypt_campaign_id`)
COMMENT '推荐专栏→广告活动→关键词 三层钻取关系。源 recRanks[]，可落 1,002 行'
DISTRIBUTED BY HASH(`asin`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== roles (2 rows) =====
CREATE TABLE `roles` (
  `id` bigint NOT NULL COMMENT "雪花 ID",
  `code` varchar(32) NOT NULL COMMENT "角色码：admin / user",
  `name` varchar(64) NOT NULL COMMENT "中文名",
  `permissions` text NULL COMMENT "JSON 数组，权限点列表",
  `created_at` datetime NULL COMMENT "创建时间"
) ENGINE=OLAP
UNIQUE KEY(`id`)
COMMENT '角色表'
DISTRIBUTED BY HASH(`id`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== sys_user_ad_note (0 rows) =====
CREATE TABLE `sys_user_ad_note` (
  `id` bigint NOT NULL COMMENT "雪花 ID",
  `user_id` bigint NOT NULL COMMENT "用户 ID",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `encrypt_campaign_id` varchar(64) NOT NULL COMMENT "关联广告活动（Sif 内部加密 ID）",
  `campaign_id_a0` varchar(64) NULL COMMENT "用户录入的后台真实活动 ID",
  `campaign_name` varchar(255) NULL COMMENT "用户录入的活动名",
  `campaign_color` varchar(16) NULL COMMENT "用户设置的标记色",
  `note` varchar(1024) NULL COMMENT "备注内容",
  `created_at` datetime NOT NULL COMMENT "创建时间",
  `updated_at` datetime NULL COMMENT "更新时间",
  INDEX idx_uan_user (`user_id`) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(`id`)
COMMENT '用户广告备注（仅自己可见）'
DISTRIBUTED BY HASH(`id`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== system_configs (7 rows) =====
CREATE TABLE `system_configs` (
  `config_key` varchar(128) NOT NULL COMMENT "主键，如 credit.cost.query_asin",
  `config_value` text NOT NULL COMMENT "值（标量或 JSON）",
  `value_type` varchar(16) NULL DEFAULT "string" COMMENT "string/int/bool/json",
  `group_name` varchar(32) NULL COMMENT "分组：credit/ai/feature_flag/limit",
  `description` varchar(255) NULL COMMENT "中文说明",
  `updated_at` datetime NULL COMMENT "更新时间"
) ENGINE=OLAP
UNIQUE KEY(`config_key`)
COMMENT '系统配置键值对'
DISTRIBUTED BY HASH(`config_key`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== user_favorites (0 rows) =====
CREATE TABLE `user_favorites` (
  `id` bigint NOT NULL COMMENT "雪花 ID",
  `user_id` bigint NOT NULL COMMENT "用户 ID",
  `favorite_type` varchar(16) NOT NULL COMMENT "focus 关注 / monitor 监控 / subscribe 订阅",
  `target_type` varchar(16) NOT NULL COMMENT "asin / keyword",
  `target_value` varchar(255) NOT NULL COMMENT "ASIN 或关键词文本",
  `keyword_id` bigint NULL COMMENT "关键词时填，关联 dim_keyword",
  `country` varchar(8) NOT NULL COMMENT "站点",
  `group_name` varchar(64) NULL COMMENT "用户自建分组",
  `note` varchar(512) NULL COMMENT "备注",
  `notify_enabled` tinyint NULL DEFAULT "0" COMMENT "仅 subscribe 用：排名变动是否通知",
  `created_at` datetime NOT NULL COMMENT "创建时间",
  INDEX idx_uf_user (`user_id`) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(`id`)
COMMENT '用户关注/监控/订阅。应用层保证 (user_id,favorite_type,target_type,target_value,country) 唯一'
DISTRIBUTED BY HASH(`id`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== user_roles (2 rows) =====
CREATE TABLE `user_roles` (
  `id` bigint NOT NULL COMMENT "雪花 ID",
  `user_id` bigint NOT NULL COMMENT "用户 ID",
  `role_id` bigint NOT NULL COMMENT "角色 ID",
  `created_at` datetime NULL COMMENT "创建时间",
  INDEX idx_ur_user (`user_id`) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(`id`)
COMMENT '用户角色关联（应用层维护，无外键）'
DISTRIBUTED BY HASH(`id`) BUCKETS 1
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);

-- ===== users (6 rows) =====
CREATE TABLE `users` (
  `id` bigint NOT NULL COMMENT "雪花 ID（应用层生成）",
  `email` varchar(190) NOT NULL COMMENT "登录邮箱，应用层保证唯一",
  `password_hash` varchar(100) NOT NULL COMMENT "bcrypt 哈希，cost=10",
  `nickname` varchar(64) NULL COMMENT "昵称",
  `avatar_url` varchar(512) NULL COMMENT "头像地址，默认占位图",
  `status` tinyint NULL DEFAULT "1" COMMENT "1=正常 0=停用 2=封禁",
  `default_country` varchar(8) NULL DEFAULT "US" COMMENT "默认站点，对应原站 countryCode",
  `last_login_at` datetime NULL COMMENT "最后登录时间",
  `last_login_ip` varchar(64) NULL COMMENT "最后登录 IP",
  `is_deleted` tinyint NULL DEFAULT "0" COMMENT "软删除标记",
  `created_at` datetime NOT NULL COMMENT "创建时间",
  `updated_at` datetime NULL COMMENT "更新时间",
  INDEX idx_users_email (`email`) USING INVERTED COMMENT "登录查询用"
) ENGINE=OLAP
UNIQUE KEY(`id`)
COMMENT '用户主表'
DISTRIBUTED BY HASH(`id`) BUCKETS 2
PROPERTIES (
"replication_allocation" = "tag.location.default: 1",
"min_load_replica_num" = "-1",
"is_being_synced" = "false",
"storage_medium" = "hdd",
"storage_format" = "V2",
"inverted_index_storage_format" = "V3",
"enable_unique_key_merge_on_write" = "true",
"light_schema_change" = "true",
"disable_auto_compaction" = "false",
"group_commit_interval_ms" = "10000",
"group_commit_data_bytes" = "134217728",
"enable_mow_light_delete" = "false"
);
