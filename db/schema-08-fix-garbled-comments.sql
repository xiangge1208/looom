-- =====================================================================
-- 修复 6 个列 COMMENT 的编码损坏（2026-09-22）
--
-- ## 现象
--
-- 这 6 个列的 COMMENT 在 Doris 里存的是**损坏字节**，中文全部显示为乱码：
--
--   fact_keyword_bid_estimate.bid_strategy
--   fact_keyword_metric_snapshot.video_asin_num
--   rel_keyword_asin_traffic_share.ac_score_ratio / er_score_ratio / tr_score_ratio
--   user_favorites.library_id
--
-- 表 COMMENT 与其余 590+ 列的 COMMENT 都是好的，只有这 6 个坏。
--
-- ## 成因
--
-- 这 6 个列的共同点：都是 schema-07（M13 返工）之后**用 mysql 客户端单独
-- ALTER ... MODIFY COLUMN 改过 COMMENT 的**列 —— 当时命令行没带
-- `--default-character-set=utf8mb4`，Windows 下客户端默认按 GBK 发送，
-- UTF-8 中文被当 GBK 字节传给 Doris，存进去就成了乱码。
--
-- 证据：schema-0*.sql 文件里这些列的 COMMENT 原文是好的（文件本身是 UTF-8），
-- 说明不是建表时坏的，是后续单独 ALTER 时坏的。
--
-- ## ⚠️ 中文原文不可逆
--
-- 损坏是**有损**的：GBK 无法表示的字符在转换时被替换成了 `?`，
-- 原始中文字节已经丢失，无法从库里还原（试过 gbk/cp936/latin1 反解，
-- 中文全部变成 `?`）。
--
-- 所以本文件的 COMMENT 是**依据三处素材重建**的，不是还原：
--   1. `db/schema-07-m13-rework.sql` 的建表原文（英文骨架 + 部分中文）
--   2. `docs/DORIS_SCHEMA_DESIGN.md` §13.3 / §12.x 记录的实测结论
--   3. 乱码串里仍可读的英文与数字（源字段名、行数、值域）
--
-- ## 幂等性
--
-- `MODIFY COLUMN ... COMMENT` 可重复执行。
-- ⚠️ Doris 的坑（schema-07 §12.9 已记）：只改 COMMENT **不能带类型声明**，
--    写 `MODIFY COLUMN x INT NULL COMMENT '...'` 会报 `Nothing is changed`，
--    必须省略类型只写 `MODIFY COLUMN x COMMENT '...'`。
--
-- ## 执行方式（必须显式指定字符集，否则会再坏一次）
--
--   mysql -h<host> -P9030 -u<user> -p<pass> looom \
--         --default-character-set=utf8mb4 < db/schema-08-fix-garbled-comments.sql
--
-- 验证：
--   SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.columns
--    WHERE TABLE_SCHEMA='looom' AND COLUMN_COMMENT LIKE '%?%';   -- 应返回 0 行
-- =====================================================================

USE looom;

-- 1. fact_keyword_bid_estimate.bid_strategy
--    乱码残留里可读：「**源 JSON 键名** auto / legacy」「cpc/category」
--    「matchTypes.<match>.<strategy>」「ETL」「auto=」「legacy=」「页面说明第 3 条」
ALTER TABLE fact_keyword_bid_estimate MODIFY COLUMN bid_strategy
  COMMENT '投放策略。取值沿用**源 JSON 键名** auto / legacy（cpc/category 的 matchTypes.<match>.<strategy>），ETL 不做映射。对应页面 UI 的表述：auto=「提升与降低」/ legacy=「仅降低」与「固定」。⚠️ 原站已把「仅降低」与「固定」合并为一档（页面说明第 3 条），所以只有 2 个值；前端渲染时要按 UI 的表述映射';

-- 2. fact_keyword_metric_snapshot.video_asin_num
--    乱码残留里可读：「SBV」「videoAsinNum」「321」「1~32」
ALTER TABLE fact_keyword_metric_snapshot MODIFY COLUMN video_asin_num
  COMMENT 'SBV（视频广告）位竞品数。源 videoAsinNum，页面列名「SBV产品数」。落表 321 行，实测值域 1~32';

-- 3~5. rel_keyword_asin_traffic_share 的 ac / er / tr 三列
--      实测结论见 DORIS_SCHEMA_DESIGN.md §13.3
ALTER TABLE rel_keyword_asin_traffic_share MODIFY COLUMN ac_score_ratio
  COMMENT 'AC(Amazon Choice) 位份额。源 acScoreRatio。⚠️ 实测 26/1,351 行非零、最大值 1.0 —— 与 metric 表的 ac_asin_num（318 行恒 0）不同，本列有真实区分度，页面「AC推荐流量」列要展示';

ALTER TABLE rel_keyword_asin_traffic_share MODIFY COLUMN er_score_ratio
  COMMENT '源 erScoreRatio。⚠️ 实测 1,351 行全为 0（/amount 页的同族字段 erAsinNum 也是 0% 填充）。列保留观察，接口不返回、前端不展示 —— 原站页面表头也只有 6 个流量位列，不含 ER/TR';

ALTER TABLE rel_keyword_asin_traffic_share MODIFY COLUMN tr_score_ratio
  COMMENT '源 trScoreRatio。⚠️ 同 er_score_ratio，实测全为 0';

-- 6. user_favorites.library_id
--    乱码残留里可读：「ID」「user_library.id」「M15a」「group_name」「NULL」
ALTER TABLE user_favorites MODIFY COLUMN library_id
  COMMENT '归属库 ID，关联 user_library.id（M15a 建）。替代 group_name 的弱字符串关联 —— 改库名不必改这里每一行。⚠️ M15a 上线前恒为 NULL，届时把 group_name 的值迁成 library_id 并废弃 group_name';
