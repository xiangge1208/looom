-- =====================================================================
-- 日粒度事实表 + 流量归因 + 两张待源空表（2026-09-23）
--
-- ## 为什么需要
--
-- 用 B01NBNDC1T 逐页对照原站规格后，发现三个图表做不出来，根因都在数据层
-- **缺日粒度**，不是表设计错：
--
--   原站「查流量(词)」的 60 天价格/BSR/事件复合图（11 个系列）
--   原站「运营时光机」的 83 天因果图（16 个系列）
--   原站「查流量(词)」的流量变化归因表（关键词 / 流量变化 / 影响原因）
--
-- 现有表的粒度实测：
--   fact_asin_traffic_channel     只有 month（day 粒度 0 行）
--   fact_asin_listing_snapshot    stat_month VARCHAR(7)，且只有 price/score/rating_num/bsr 四列
--   fact_asin_subbsr_snapshot     有日粒度，但**只存小类**（实测该 ASIN 只有 Pillow Inserts）
--   fact_asin_keyword_inout       只有 in/out 两态，没有「为什么变」
--
-- 换源 sif-cli 后确认能拿到：
--   traffic-trend --granularity day   一次返回 83 天 × 37 字段（价格族/流量族/排名族/口碑族/事件族全覆盖）
--   rvs / diag                        归因，含 changeReasons[] 与 pchangeReason
--   keyword-aba-trend                 103 周 ABA 趋势（含词根综合搜索量）
--
-- ## 为什么 60 天图和 83 天图共用一张表
--
-- 两者要的是同一份日粒度序列，只是窗口长度不同（60 vs 83）。
-- 建两张表会让同一天的价格在两处各存一份，迟早对不上。
-- 前端按 days 裁剪即可。
--
-- ## 执行
--
--   mysql -h<host> -P9030 -u<user> -p<pass> looom \
--         --default-character-set=utf8mb4 < db/schema-10-daily-grain.sql
--
-- ⚠️ 必须带 --default-character-set=utf8mb4。schema-08 就是漏了这个，
--    中文 COMMENT 被当 GBK 发送，6 个列注释不可逆地损坏了。
-- ⚠️ 全文用 CREATE TABLE IF NOT EXISTS，可重复执行。
--    不要学 schema-09 的 DROP TABLE IF EXISTS —— 那个重跑会清掉已灌的数据。
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. fact_asin_daily_snapshot —— 日粒度全要素快照
--
-- 一行 = 一个 ASIN 的一天。承载 traffic-trend[granularity=day] 的全部日序列。
--
-- 读数约定（实测 B01NBNDC1T 356 天 = lastMonths 12，易错）：
--   · 源响应是「dates[] 时间轴 + 各指标等长数组」，按**下标对齐**，
--     不是 {date, value} 配对结构。ETL 按下标拆行。
--   · nfScore/adScore/spScore 等是**结构体数组**，每项 {score, scoreRatio,
--     scoreChange, scoreChangeRatio, contriChangeRatio}，这里只落 score + ratio。
--   · bsr 是**大类**（实测 Home & Kitchen，9~122），subBsr 是小类
--     （{"Pillow Inserts": [...]}，恒 1~2）。原站因果图的 BSR 双倒置轴要两条线，
--     所以两个都存。subBsr 的键是**动态类目名**，ETL 要遍历取不能硬编码。
--   · **ldPrice 不是数字，是复合串**：实测 "14.99_0_当日19:35-次日07:35"
--     （价格_标志_时段）。直接按数值解析会全部变 NULL —— 第一次灌数就踩了这个坑，
--     356 行 ld_price 全空而源里有 36 天有值。所以拆成 ld_price + ld_raw 两列。
--   · **titleImg 是整数标志位不是文本**（实测值 2），不要当字符串存。
--   · 稀疏字段一律 NULL 不写 0：实测 356 天里 ld 36 天、title_img 14 天、
--     promotion 9 天、prime_price 10 天有值，coupon_info 一天都没有。
--     写 0 会被前端读成「当天促销价是 0 元」。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS looom.fact_asin_daily_snapshot (
  asin                 VARCHAR(16)  NOT NULL COMMENT 'ASIN（该变体自身，非父体）',
  country              VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  stat_date            DATE         NOT NULL COMMENT '统计日期。⚠️ 分区列，AUTO PARTITION 按月',

  -- 价格族（源 buyboxPrice / dealPrice / ldPrice / primePrice）
  buybox_price         DECIMAL(12,2) NULL    COMMENT '购物车价。源 buyboxPrice，实测 356/356 天有值，12.50~28.50',
  deal_price           DECIMAL(12,2) NULL    COMMENT '成交价。源 dealPrice，实测 356/356 天有值，12.50~28.50。与 buybox 多数日相同，促销日低于它',
  ld_price             DECIMAL(12,2) NULL    COMMENT '秒杀价（从 ldPrice 复合串里拆出的价格部分）。⚠️ 实测 356 天仅 36 天有值，NULL=当天无秒杀不是 0',
  ld_raw               VARCHAR(255)  NULL    COMMENT '秒杀原始串。源 ldPrice 是**复合字符串**不是数字，实测形如 "14.99_0_当日19:35-次日07:35"（价格_标志_时段）。价格已拆到 ld_price，时段信息只在这里，原样保留',
  prime_price          DECIMAL(12,2) NULL    COMMENT 'Prime 专享价。源 primePrice，实测仅 10/356 天有值（14.72），其余 NULL=当天无 Prime 专享价',

  -- 流量族（源 totalScore/nfScore/adScore/spScore/recSpScore/sbScore/sbvScore 的 .score 与 .scoreRatio）
  total_score          DOUBLE       NULL     COMMENT '当日总流量得分。源 totalScore.score，实测 351/356 天有值，10,390~144,509',
  nf_score             DOUBLE       NULL     COMMENT '自然流量得分。源 nfScore.score，实测 351/356 天，7,369~126,076',
  nf_ratio             DOUBLE       NULL     COMMENT '自然占当日总流量比例（0-1）。源 nfScore.scoreRatio',
  ad_score             DOUBLE       NULL     COMMENT '广告流量合计得分。源 adScore.score，实测 351/356 天，387~27,727',
  ad_ratio             DOUBLE       NULL     COMMENT '广告占当日总流量比例（0-1）。源 adScore.scoreRatio',
  sp_score             DOUBLE       NULL     COMMENT 'SP 常规广告得分。源 spScore.score，实测 348/356 天，2.4~16,206',
  rec_sp_score         DOUBLE       NULL     COMMENT 'SP 推荐位得分。源 recSpScore.score，实测 318/356 天，2.6~4,857',
  sb_score             DOUBLE       NULL     COMMENT 'SB 品牌广告得分。源 sbScore.score。⚠️ 实测 293/356 天有值，NULL=当天无 SB 曝光',
  sbv_score            DOUBLE       NULL     COMMENT 'SBV 品牌视频得分。源 sbvScore.score。⚠️ 实测 279/356 天有值，0.2~20,550',

  -- 排名族
  bsr                  BIGINT       NULL     COMMENT '**大类** BSR。源 bsr[]（实测类目 Home & Kitchen），356/356 天有值，实测 9~122。⚠️ 不是小类，小类看 sub_bsr。此前 fact_asin_subbsr_snapshot 只存小类，大类整个丢了',
  sub_bsr              BIGINT       NULL     COMMENT '**小类** BSR。源 subBsr 字典的值（键即类目名，实测 Pillow Inserts），356/356 天有值，实测 1~2',
  sub_bsr_cat          VARCHAR(255) NULL     COMMENT '小类类目名。源 subBsr 的键。⚠️ 是动态键不是固定枚举，ETL 要遍历取而非硬编码',
  cat_name             VARCHAR(255) NULL     COMMENT '大类类目名。源 catName，实测 Home & Kitchen',

  -- 口碑族
  star                 DOUBLE       NULL     COMMENT '评分。源 star，实测 356/356 天恒为 4.6',
  review_num           BIGINT       NULL     COMMENT '累计评论数。源 review，实测 178,445→219,078 单调增',
  seller_num           INT          NULL     COMMENT '当日卖家数。源 seller，实测 1~3',

  -- 事件族（原站因果图上的散点标注）
  woot                 TINYINT      NULL     COMMENT '是否 Woot 活动 0/1。源 woot，实测 356 天全 0',
  title_img            INT          NULL     COMMENT '标题/主图变更标记。源 titleImg 是**整数标志位**不是文本（实测值 2），实测仅 14/356 天有值，NULL=当天无变更',
  coupon_info          VARCHAR(255) NULL     COMMENT '优惠券信息。源 couponInfo。⚠️ 实测 0/356 天有值，整列 NULL 属正常（该窗口无券）',
  promotion            VARCHAR(255) NULL     COMMENT '促销类型文案。源 promotion，实测 9/356 天有值，如 "Exclusive Prime price"',
  buybox_seller        VARCHAR(255) NULL     COMMENT '购物车卖家名。源 buyboxSeller，实测 "Utopia Deals##"（含源侧的 ## 后缀，原样存）',

  bought_in_past_month BIGINT       NULL     COMMENT '近30天销量**分档下界**。源 boughtInPastMonth，实测 352/356 天有值，值 30000。⚠️ 不是精确销量，原站以 "30,000+" 展示',

  created_at           DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, stat_date)
COMMENT '日粒度全要素快照。源 sif-cli traffic-trend[granularity=day]（一次返回 83 天 × 37 字段）。同时支撑「查流量」60天复合图与「运营时光机」83天因果图 —— 两者同一份数据，不同窗口。稀疏列 NULL≠0'
AUTO PARTITION BY RANGE (date_trunc(stat_date, 'month')) ()
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");


-- ---------------------------------------------------------------------
-- 2. fact_asin_keyword_attribution —— 流量变化归因
--
-- 一行 = 某 ASIN 某期某个词的「变了多少 + 为什么变」。
-- 对应原站「查流量(词)」页右侧的归因面板：关键词 / 流量变化 / 影响原因。
--
-- ## 为什么不并进 fact_asin_keyword_inout
--
-- 语义不同，不是粒度不同：
--   fact_asin_keyword_inout   记「这个词进来了/出去了」（change_type = in/out），是状态
--   本表                       记「这个词的流量变了多少、因为什么」，是量 + 原因
-- inout 表保留不动（8,912 行既有数据）。
--
-- ## change_reasons 为什么存 JSON 而不拆列
--
-- 源 changeReasons[] 是**变长结构体数组**，实测一个词可以同时有
--   {type:"DEFAULT", reason:"SP(常规)位：- → 1", positive:1}
--   {type:"REC", recTitle:"Trending now", positive:1}
-- 两条，且 type 决定哪些字段存在（DEFAULT 有 reason，REC 有 recTitle）。
-- 拆列要么列爆炸要么丢信息，所以原文存 JSON，另出一个预格式化的
-- reason_summary 供表格直接渲染 —— 前端不必解析 JSON 就能显示。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS looom.fact_asin_keyword_attribution (
  asin                 VARCHAR(16)  NOT NULL COMMENT 'ASIN（该变体自身，非父体）',
  country              VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  keyword              VARCHAR(128) NOT NULL COMMENT '流量词。⚠️ 文本主键（schema-04 起的全库约定），keyword_id 不可靠',
  stat_date            DATE         NOT NULL COMMENT '归因所属期的日期。月粒度期存该月首日，日粒度存当日。⚠️ 分区列',
  granularity          VARCHAR(16)  NOT NULL COMMENT '期粒度：month（源 diag --granularity month）/ day（源 rvs --date）',

  keyword_id           BIGINT       NULL     COMMENT '源侧词 ID，仅对账用。⚠️ 实测跨站不唯一，不可做主键',
  translate_keyword    VARCHAR(255) NULL     COMMENT '词的中文翻译。源 translateKeyword',

  contri_change        DOUBLE       NULL     COMMENT '该词本期流量变化量（可负）。源 contriChange / diffScore，实测 +4,608.58 / -37,247.58',
  contri_change_ratio  DOUBLE       NULL     COMMENT '变化占整体变化的比例（0-1）。源 contriChangeRatio，实测 0.236',
  contri_change_total  DOUBLE       NULL     COMMENT '本期整体变化总量（该词变化的分母）。源 contriChangeTotal，实测 19,528.02',
  score                DOUBLE       NULL     COMMENT '该词本期流量得分。源 score，实测 165,837.49',
  score_before         DOUBLE       NULL     COMMENT '该词上期流量得分。源 scoreBefore，实测 203,085.08。⚠️ 新进词该列为 NULL 不是 0',
  score_ratio          DOUBLE       NULL     COMMENT '该词占本期该 ASIN 总流量比例（0-1）。源 scoreRatio，实测 0.1227',

  search_volume        BIGINT       NULL     COMMENT '该词周搜索量。源 searchVolume，实测 83,490',
  search_rank          BIGINT       NULL     COMMENT '该词 ABA 搜索排名（越小越靠前）。源 searchRank / searchesRank，实测 1,009~1,613',

  reason_summary       VARCHAR(512) NULL     COMMENT '预格式化的中文原因摘要，供表格直接渲染。由 changeReasons[] 拼成，如「SP(常规)位：- → 1；获得推荐专栏：Trending now」。⚠️ NULL=源未给原因（词有变化但系统未归因）',
  change_reasons       TEXT         NULL     COMMENT 'changeReasons[] 原文 JSON。变长结构体数组，type=DEFAULT 带 reason、type=REC 带 recTitle，拆列会爆所以原样存',
  positive             TINYINT      NULL     COMMENT '变化方向：1=正向 / -1=负向。源 changeReasons[].positive（多条时取主因）。⚠️ 与 contri_change 的符号可能不一致（原因是正向但总量仍跌），以 contri_change 为准',

  created_at           DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, keyword, stat_date, granularity)
COMMENT '流量变化归因。源 sif-cli rvs（日，mainChangeKeywords[]）+ diag（月，details[].pchangeReason，实测该 ASIN 3,079 词）。回答「这个词变了多少、为什么」。与 fact_asin_keyword_inout 语义不同（那张记进出状态），两表并存'
AUTO PARTITION BY RANGE (date_trunc(stat_date, 'month')) ()
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");


-- ---------------------------------------------------------------------
-- 3. 扩 fact_keyword_search_trend —— 补词根综合搜索量与 ABA 排名
--
-- 现表只有 searches_num（该词自身搜索量）。原站「产品时光机」的双轴图
-- 还要「以该词为词根的综合搜索量」和「ABA 排名」两条线，源 keyword-aba-trend
-- 一次就给了（实测 pillow inserts 返回 103 周 × 4 个等长数组）。
--
-- ⚠️ ALTER 不幂等：列已存在时 Doris 直接报错、脚本中断。
--    所以下面两条**默认注释掉**，由执行者按需放开；判断是否需要执行：
--
--      SELECT COLUMN_NAME FROM information_schema.columns
--       WHERE TABLE_SCHEMA='looom' AND TABLE_NAME='fact_keyword_search_trend'
--         AND COLUMN_NAME IN ('ext_searches_num','searches_rank');
--
--    返回 0 行 → 放开下面两条执行；返回 2 行 → 已应用，跳过。
--    （这与 setup-doris.sh:118-147 的「探测目标是否存在再执行」范式一致）
-- ---------------------------------------------------------------------
-- ALTER TABLE looom.fact_keyword_search_trend
--   ADD COLUMN ext_searches_num BIGINT NULL COMMENT '以该词为词根的综合搜索量。源 keyword-aba-trend.extSearchVolumes，实测 380,565~473,316（约为该词自身量的 25 倍）';
-- ALTER TABLE looom.fact_keyword_search_trend
--   ADD COLUMN searches_rank BIGINT NULL COMMENT 'ABA 搜索排名，越小越靠前。源 keyword-aba-trend.keywordRanks，实测 16,508~19,274';


-- =====================================================================
-- 以下两张表：**本期只建表，不灌数**
--
-- 建表而不灌数是有意的 —— DDL 是确定的（页面规格已知），
-- 缺的只是数据源。先把表结构定下来，下一期拿到源后只需写 ETL。
-- 各表 COMMENT 里写明了「为什么本期没有数据」，避免下一个人以为是 ETL 漏了。
-- =====================================================================


-- ---------------------------------------------------------------------
-- 4. fact_keyword_nf_share —— 自然位占位率（⚠️ 本期无数据）
--
-- 对应原站「拓词&筛查」(/asin-relatedness) 的核心 5 列：
--   自然位前 4 / 8 / 16 / 32 / 48 占位率
-- 语义：该 ASIN 在该词自然搜索结果的前 N 名里占了几席 ÷ N。
-- 运营用它判断「这个词我到底吃到了多少自然位」。
--
-- ⚠️ 本期无数据，原因：**sif-cli 接口清单里没有占位率接口**。
--    已核 `sif-cli list` 全部 41 个 endpoint（meta/keyword/asin/compete/monitor/webapp
--    六组），没有返回 topN 占位率的接口。asin-keyword-detail 给的是
--    该 ASIN 自己的逐日排名，不是「前 N 名里的占位数」，算不出分子。
--    下一步条件：找到能返回某词自然位 Top48 完整 ASIN 列表的源，
--    则可自行聚合出占位率（分子 = 列表里属于本 Listing 的变体数）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS looom.fact_keyword_nf_share (
  keyword              VARCHAR(128) NOT NULL COMMENT '关键词。⚠️ 文本主键（schema-04 起的全库约定）',
  country              VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  asin                 VARCHAR(16)  NOT NULL COMMENT '被统计的 ASIN（通常是父体，占位率按整组算）',
  stat_date            DATE         NOT NULL COMMENT '快照日期。⚠️ 分区列',

  top4_share           DOUBLE       NULL     COMMENT '自然位前 4 名的占位率（0-1）= 前4名里属于本组的席数 ÷ 4',
  top8_share           DOUBLE       NULL     COMMENT '自然位前 8 名占位率（0-1）',
  top16_share          DOUBLE       NULL     COMMENT '自然位前 16 名占位率（0-1）',
  top32_share          DOUBLE       NULL     COMMENT '自然位前 32 名占位率（0-1）',
  top48_share          DOUBLE       NULL     COMMENT '自然位前 48 名占位率（0-1）。原站最深档位',
  relatedness          VARCHAR(16)  NULL     COMMENT '相关性档位：high/medium/low/none。原站用色彩 Tag 展示，供「帮我过滤」一键剔除低相关词',

  created_at           DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(keyword, country, asin, stat_date)
COMMENT '自然位 Top4/8/16/32/48 占位率，支撑「拓词&筛查」页。⚠️⚠️ 本期只建表未灌数：sif-cli 全部 41 个 endpoint 均不返回占位率，缺能给出某词自然位 Top48 完整 ASIN 列表的源（有了就能自行聚合）。空表属预期，不是 ETL 漏了'
AUTO PARTITION BY RANGE (date_trunc(stat_date, 'month')) ()
DISTRIBUTED BY HASH(keyword) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");


-- ---------------------------------------------------------------------
-- 5. fact_keyword_slot_hourly —— 小时级坑位监控（⚠️ 本期无数据）
--
-- 对应原站「查坑位/推排名」(/snapshot) 的 24h × 7d 双时区监控网格：
--   行 = 坑位（P1-1 ... P3-16），列 = 连续小时点位，
--   单元格 = 当时占住该坑位的 ASIN 与广告活动短码（如「活动ID:NOYP」）。
--
-- ⚠️ 这是**全库第一张小时粒度表** —— 其余事实表最细是 DATE。
--    所以主键用 stat_hour DATETIME，且分区按月（按天会产生太多分区）。
--
-- ⚠️ 本期无数据，原因：**源要求先在 SIF 账号里开监控词**。
--    `monitor-keyword-query` 是只读接口，只返回「已开启监控的词」的快照；
--    当前账号没有开启任何监控词，返回空 list。
--    下一步条件：在 SIF 前台对目标词（如 lumbar pillow）开启坑位监控，
--    等它积累出小时级快照后再灌。这是**账号侧操作**，不是代码能绕过的。
--
-- 双时区：只存 UTC 基准的 stat_hour 一列，美西/北京两列由前端换算。
-- 存两列会在夏令时切换时打架（美西 DST 一年两次跳变）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS looom.fact_keyword_slot_hourly (
  keyword              VARCHAR(128) NOT NULL COMMENT '被监控的关键词。⚠️ 文本主键',
  country              VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  stat_hour            DATETIME     NOT NULL COMMENT '小时点位（整点，UTC 基准）。⚠️ 全库唯一的小时粒度列；美西/北京两个时区由前端换算，不存两列（夏令时会打架）。分区按月',
  slot                 VARCHAR(16)  NOT NULL COMMENT '坑位标识，原站形如 P1-1 / P1-2 ... P3-16（P=页码，后半为页内序号）',

  asin                 VARCHAR(16)  NULL     COMMENT '当时占住该坑位的 ASIN。NULL=该小时该坑位无抓取结果',
  mask_campaign_id     VARCHAR(16)  NULL     COMMENT '广告活动前台 4 位短码，原站显示为「活动ID:NOYP」。与 fact_keyword_rank_history.mask_campaign_id 同口径',
  encrypt_campaign_id  VARCHAR(64)  NULL     COMMENT '广告活动加密 ID，可关联 dim_ad_campaign',
  traffic_type         VARCHAR(16)  NULL     COMMENT '流量位类型：nf(自然)/sp/spRec/sb/sbv，取值对齐 dict_traffic_channel.code',
  page_no              INT          NULL     COMMENT '页码（slot 里 P 后面那个数，冗余存便于直接过滤）',
  asin_order           INT          NULL     COMMENT '页内序号（slot 里连字符后那个数）',
  is_target            TINYINT      NULL     COMMENT '该坑位是否被监控目标 ASIN 占住 0/1。原站用它做高亮色块',

  created_at           DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(keyword, country, stat_hour, slot)
COMMENT '小时级坑位监控，支撑「查坑位/推排名」页 24h×7d 网格。⚠️⚠️ 本期只建表未灌数：monitor-keyword-query 只读「已开启监控的词」，当前 SIF 账号未开任何监控词，返回空。需先在前台开启监控并等其积累小时快照（账号侧操作）。空表属预期'
AUTO PARTITION BY RANGE (date_trunc(stat_hour, 'month')) ()
DISTRIBUTED BY HASH(keyword) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");
