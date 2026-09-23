-- =====================================================================
-- 推荐专栏：两列按天趋势的落库表（2026-09-22）
--
-- ## 为什么需要这张表
--
-- 原站「查推荐专栏」主表有两列带按天迷你趋势：
--
--   获得该推荐专栏的 广告活动数量及趋势   campaignCntTrends
--   获得该推荐专栏的 广告词数量及趋势     keywordCntTrends
--
-- 它们此前无法从 PG 侧算出，原因见 docs/AUDIT_REC_COLUMN_DATA.md：
-- PG 里 `allRankHistory.recRanks` 只记「某天该专栏出现了、由哪个活动带来」，
-- 拿不到「该专栏当天关联了多少活动/多少词」—— 那是跨该 ASIN 全部关键词
-- 去重后的计数，PG 的单关键词结构给不出。
--
-- 现在改为直接从原站 `rec/recView` 接口取（服务端已算好），落本表。
-- 采集方式与数据来源见 scripts/load_rec_column_trend.mjs 的说明。
--
-- ## 为什么不并进 fact_asin_rec_column_period
--
-- 粒度不同，且时间语义不同：
--   fact_asin_rec_column_period   stat_date 是**数据快照日**，每个专栏每天一行，
--                                 装的是 ratio（占比）
--   本表                           同样每个专栏每天一行，但装的是**计数**（活动数/词数）
-- 合并会让「一行代表什么」变得含糊，且 period 表已有 115 行既有数据
-- （64 行 seed + 51 行真实占比），不宜混入另一种口径。
--
-- ## 数据形态的两个要点（实测，易错）
--
-- 1. **趋势里的 null 不是 0，是「当天该专栏无曝光」**。
--    实测 B07N7GDB6Q / Seen on social media 得 [null,1,2,3,3,3,3] ——
--    首日该专栏没出现。画图必须断线；补 0 会画成贴底的线，
--    读起来像「有数据但为 0」。所以本表用 NULL 存，不用 0。
--
-- 2. **行尾当前数不等于数组末位**。原站在响应里另给 lastCampaignCnt /
--    lastKeywordCnt（最近有效值）；上面那个例子末位是 3、last 也是 3，
--    但 Picks from Amazon Influencers 的 ct 末位是 null 而 lastCampaignCnt=1。
--    所以两个都存，前端显示行尾数字时用 last_* 而不是取数组末位。

-- ⚠️ 2026-09-23：原先这里是 `DROP TABLE IF EXISTS` + 裸 CREATE，**重跑会清空已灌数据**。
--    当时这个文件不在任何自动执行流里，靠手工跑，风险被掩盖了；
--    但 schema-10 那轮把 setup-doris.sh 的通配符改成了显式数组 SCHEMA_FILES，
--    本文件从此被**无条件执行** —— 再跑一次 setup-doris.sh 就会把
--    load_rec_column_trend.mjs 灌的 357 行（真实采集，且采集要在已登录浏览器里
--    现签 _m 参数，重采成本高）全部删掉。
--    改成 CREATE TABLE IF NOT EXISTS，与全库约定（DORIS_SCHEMA_DESIGN §10）一致。
--    要重建表请手工先 DROP，不要让建库脚本替你决定。
CREATE TABLE IF NOT EXISTS looom.fact_rec_column_trend (
  asin                 VARCHAR(16)  NOT NULL COMMENT 'ASIN（该变体自身，非父体）',
  country              VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  rec_title            VARCHAR(255) NOT NULL COMMENT '推荐专栏英文原文',
  stat_date            DATE         NOT NULL COMMENT '该行对应的日期（趋势轴上的某一天）',
  campaign_cnt         INT          NULL     COMMENT '该日该专栏的去重广告活动数。⚠️ NULL=当天该专栏无曝光，不是 0',
  keyword_cnt          INT          NULL     COMMENT '该日该专栏的去重广告词数。⚠️ 同上，NULL≠0',
  last_campaign_cnt    INT          NULL     COMMENT '窗口内最近有效活动数（原站 lastCampaignCnt）。显示行尾数字用它，不要取趋势数组末位（末位可能为 NULL）',
  last_keyword_cnt     INT          NULL     COMMENT '窗口内最近有效词数（原站 lastKeywordCnt）',
  window_days          INT          NULL     COMMENT '该行所属窗口的总天数（原站 totalDays，实测 7）。用于展示「出现 6/7 天」这类分母',
  -- 窗口末列：趋势按天拆行后，窗口信息放在每行重复存，
  -- 便于单表查询时不必再关联另一张窗口表
  window_start         DATE         NULL     COMMENT '窗口起始日（含）',
  window_end           DATE         NULL     COMMENT '窗口结束日（含）',
  created_at           DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, rec_title, stat_date)
COMMENT '推荐专栏的按天活动数/词数。源：原站 rec/recView（服务端已按 ASIN 全部关键词去重聚合，PG 侧算不出）。NULL 表示当天无曝光，不可当 0'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");
