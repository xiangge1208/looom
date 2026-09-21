-- =====================================================================
-- 大表分区改造（ROADMAP_UNBUILT_MODULES.md §1.4）
--
-- 背景：schema-01~04 里 PARTITION BY 出现 0 次，所有表都是单分区。
--   两张追加型大表已到量级：
--     fact_asin_subbsr_snapshot   1,654,767 行，日粒度，2023-01-01 ~ 2026-09-18
--     fact_keyword_rank_history     117,740 行，日粒度，2026-07-29 ~ 2026-09-19
--   M11（产品时光机）和 M14（每日排名）都是日粒度历史范围查询，
--   无分区会全表扫描。Doris 加分区必须重建表，数据越多代价越大。
--
-- 方案：AUTO PARTITION BY RANGE (date_trunc(stat_date, 'month'))
--   Doris 4.1.3 支持，写入时按月自动建分区，无需预先枚举也无需定期维护。
--   已在本实例实测通过（2023-01 与 2026-09 两条数据各自落到独立分区）。
--
-- ⚠️ 本文件是破坏性的：CREATE ... AS SELECT 到新表 → DROP 旧表 → RENAME。
--   不放进 setup-doris.sh 的默认 glob（文件名 schema-05 会被 0[!4] 匹配到，
--   所以脚本里对它做了显式排除，见 setup-doris.sh 的 SKIP_PARTITION 守卫）。
--   执行方式：
--     RUN_PARTITION_MIGRATION=1 bash scripts/setup-doris.sh
--   或手动：mysql ... < db/schema-05-partitions.sql
--
-- 幂等性：靠 `_new` 中间表名 + DROP IF EXISTS 实现「可重复执行」，
--   但重复执行会重走一遍搬数据（大表耗时），正常只需跑一次。
--   判断是否已迁移：SHOW PARTITIONS FROM xxx 返回多行即已完成。
--
-- 为什么不动 stat_month 型的两张表（fact_asin_bought_monthly 809,553 行、
--   fact_asin_traffic_channel 149,460 行）：它们的 stat_month 是 VARCHAR，
--   Doris RANGE 分区要求分区列是 DATE/DATETIME/INT。改造需要加派生列或改类型，
--   改动面大且会牵动前端格式化。留到 M13/M14 动这两张表时一并处理。
-- =====================================================================

USE looom;

-- =====================================================================
-- 1. fact_asin_subbsr_snapshot —— 全库最大表（165 万行）
-- 原 DDL：db/schema-02-business.sql:403
-- BUCKETS 从 2 提到 8：单分区 2 桶在 165 万行下每桶过大
-- =====================================================================
DROP TABLE IF EXISTS looom.fact_asin_subbsr_snapshot_new;
CREATE TABLE looom.fact_asin_subbsr_snapshot_new (
  asin        VARCHAR(16)   NOT NULL COMMENT 'ASIN 编号',
  country     VARCHAR(8)    NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  cat_name    VARCHAR(255)  NOT NULL COMMENT '子类目名称（原为动态 key）',
  stat_date   DATE          NOT NULL COMMENT '统计日期。⚠️ 分区列，AUTO PARTITION 按月',
  bsr         BIGINT        COMMENT 'BSR 排名',
  created_at  DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, cat_name, stat_date)
COMMENT 'ASIN 子类目 BSR 排名快照。⚠️ 原响应是动态 key 对象 {类目名:值}，入库须拆成行。按月自动分区'
AUTO PARTITION BY RANGE (date_trunc(stat_date, 'month')) ()
DISTRIBUTED BY HASH(asin) BUCKETS 8
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

INSERT INTO looom.fact_asin_subbsr_snapshot_new
SELECT asin, country, cat_name, stat_date, bsr, created_at
  FROM looom.fact_asin_subbsr_snapshot;

-- =====================================================================
-- 2. fact_keyword_rank_history —— 排名历史（117,740 行）
-- 原 DDL：db/schema-04-keyword-text-key.sql:172（文本键版本）
-- ⚠️ 列定义必须与 schema-04 保持一致，否则 schema-04 重跑会退回无分区版本。
--   schema-04 里该表的 DDL 也已同步加上 AUTO PARTITION（见该文件）。
-- =====================================================================
DROP TABLE IF EXISTS looom.fact_keyword_rank_history_new;
CREATE TABLE looom.fact_keyword_rank_history_new (
  asin              VARCHAR(16)   NOT NULL COMMENT 'ASIN 编号',
  country           VARCHAR(8)    NOT NULL COMMENT '站点',
  keyword           VARCHAR(128)  NOT NULL COMMENT '关键词原文（主键）',
  rank_type         VARCHAR(16)   NOT NULL COMMENT '排名类型：nf/sp/sb/sbv/recSp（原设计只有 nf/sp，漏 3 种）',
  stat_date         DATE          NOT NULL COMMENT '统计日期（按 allRankHistory.date[] 下标对齐）。⚠️ 分区列',
  keyword_id        BIGINT        NULL     COMMENT '原站关键词 ID（普通列）',
  rank_position     DOUBLE        NULL     COMMENT '全局排名。⚠️ 改 DOUBLE：sb/sbv 的 rank 100% 带小数编码版位',
  page_no           INT           NULL     COMMENT '页码，从 rankStr 的 ^p(\\d+) 解析。sb/sbv/recSp 无页码概念',
  page_size         INT           NULL     COMMENT '页容量，从 rankStr 的 /(\\d+)$ 解析。实测非固定 48（还有 16/49/47/46/40）',
  slot              VARCHAR(16)   NULL     COMMENT '版位：top/middle/bottom/tail。仅 sb/sbv 有，来自 rankStr 第 3 段',
  asin_order        INT           NULL     COMMENT '同位次内序号。实测 sb/sbv 100% 非空，nf/sp 100% NULL',
  campaign_id       VARCHAR(64)   NULL     COMMENT '广告活动 ID。实测 sp/sb/sbv 有值，nf 恒 NULL',
  mask_campaign_id  VARCHAR(16)   NULL     COMMENT '前台 4 位短码（源 maskCampaignId）',
  created_at        DATETIME      NOT NULL COMMENT '入库时间',
  INDEX idx_rank_kw (keyword) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(asin, country, keyword, rank_type, stat_date)
COMMENT 'ASIN×关键词 排名历史（日粒度）。主源 sif_asin_keyword.raw->allRankHistory。按月自动分区'
AUTO PARTITION BY RANGE (date_trunc(stat_date, 'month')) ()
DISTRIBUTED BY HASH(asin) BUCKETS 4
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

INSERT INTO looom.fact_keyword_rank_history_new
SELECT asin, country, keyword, rank_type, stat_date, keyword_id,
       rank_position, page_no, page_size, slot, asin_order,
       campaign_id, mask_campaign_id, created_at
  FROM looom.fact_keyword_rank_history;

-- =====================================================================
-- 3. 切换（旧表先留成 _old，人工核对行数后再手动 DROP）
--
-- 不直接 DROP 旧表：搬数据是 INSERT ... SELECT，若中途失败就无从恢复。
-- 留 _old 一轮，确认新表行数对得上再删。
-- 清理命令（核对后手动执行）：
--   DROP TABLE looom.fact_asin_subbsr_snapshot_old;
--   DROP TABLE looom.fact_keyword_rank_history_old;
-- =====================================================================
ALTER TABLE looom.fact_asin_subbsr_snapshot RENAME fact_asin_subbsr_snapshot_old;
ALTER TABLE looom.fact_asin_subbsr_snapshot_new RENAME fact_asin_subbsr_snapshot;

ALTER TABLE looom.fact_keyword_rank_history RENAME fact_keyword_rank_history_old;
ALTER TABLE looom.fact_keyword_rank_history_new RENAME fact_keyword_rank_history;
