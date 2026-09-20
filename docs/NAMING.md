# 表名与字段命名规范（主 Agent 合并阶段裁定）

各子 Agent 独立命名导致同一实体出现多种叫法。合并时按本规范统一，原名映射记入
`DATA_DICTIONARY.md` 的「合并日志」。

## 一、表名前缀

各域用了 `dim_` / `fact_` / `dict_` / `enum_` / `sif_` / 无前缀 六种风格，统一为三种：

| 前缀 | 含义 | 例 |
|---|---|---|
| `dim_` | **基础实体**（维度表）。相对稳定的主体档案 | `dim_asin`、`dim_keyword` |
| `fact_` | **时序快照 / 事实表**。带时间维度、会持续追加 | `fact_asin_traffic_snapshot` |
| `rel_` | **关系表**。实体间多对多关联 | `rel_asin_variant` |
| `dict_` | **枚举字典表**。取值有限、变更极少 | `dict_traffic_channel` |
| 无前缀 | **系统表**（平台自身运行）。沿用通用 SaaS 命名 | `users`、`credit_accounts` |

废弃：`enum_`（统一用 `dict_`）、`sif_`（库名已是 `sif_replica`，无需再冠名）。

## 二、已识别的同实体异名（合并映射）

| 统一表名 | 各域原名 | 出处 |
|---|---|---|
| `dim_asin` | `dim_asin`（sales/traffic）、`sif_asin`（timemachine）、`asin_product`（keywords） | 4 域共用 |
| `dim_keyword` | `sif_keyword`（timemachine）、keywords 域的关键词主体 | 2 域 |
| `rel_asin_variant` | `dim_asin_variant_group`（sales）、`dim_asin_variant`（traffic） | 2 域 |
| `dim_asin_feature` | `dim_asin_feature`（sales）、`asin_feature`（sales 内文） | 1 域 |
| `dict_traffic_channel` | `dict_traffic_channel`（traffic）、`dict_traffic_type`（timemachine） | 2 域 |
| `dict_time_piece` | `enum_time_piece`（sales）、`dict_time_piece_type`（traffic）、`dict_time_piece`（keywords）、`dict_granularity`+`dict_time_piece`（timemachine） | 4 域 |
| `dict_recommend_column` | `dict_recommend_column`+`dim_recommend_column`（traffic）、`dict_rec_column`（keywords） | 2 域 |

> ⚠️ `traffic` 域同时给了 `dict_recommend_column` 和 `dim_recommend_column` —— 需判断
> 推荐专栏是「固定枚举」还是「动态实体」（专栏标题看起来是后端下发的字符串，可能会新增）。
> 待 recommendations 域产出后裁定。

## 三、字段命名

1. **统一 snake_case**。接口返回的驼峰（`scoreRatio`）在建表时转 `score_ratio`，
   在字段表的「来源」列保留原始驼峰名，便于对照接口
2. **纠正原站拼写错误**：原站 `vedio` 是 video 的错拼（实测确认，见 traffic.dict.md）。
   建表统一用 `sbv`，不沿用 `vedio`
3. **时间字段**：
   - `stat_date` — 日粒度统计日期（DATE）
   - `time_piece_type` + `time_piece_value` — 周/月粒度（VARCHAR）
   - `created_at` / `updated_at` — 记录自身的时间戳（DATETIME）
   - 原站的毫秒时间戳字段（如 `updateTime: 1789467685000`）转为 DATETIME 存储，
     字段名加 `_at` 后缀（`data_updated_at`）
4. **布尔字段**：Doris 用 `BOOLEAN`；原站返回 `true/false/null`，
   三态语义需保留的用 `TINYINT`（0/1/NULL）并在说明里标注 NULL 的含义
5. **占比字段**：原站返回 0-1 小数（如 `0.0000364`），**保持 0-1 存储不要乘 100**，
   前端负责格式化。字段名以 `_ratio` 结尾

## 四、主键规范（Doris Unique Key）

按实测结论（见 `docs/raw/LIVE_PROBE.md`），三种时间粒度并存，主键分两类：

| 场景 | 主键组合 |
|---|---|
| 基础实体（ASIN） | `(asin, country)` |
| 基础实体（关键词） | `(keyword_id)` 或 `(keyword, country)` ⚠️ 待定，见下 |
| 日粒度快照 | `(asin, country, stat_date, ...)` |
| 周/月粒度快照 | `(asin, country, time_piece_type, time_piece_value, ...)` |
| 分渠道长表 | 上述 + `channel` |
| 枚举字典 | `(code)` |

### 关键词主键：已实测裁定为 `(keyword_id)`

同一 ASIN（`B01N5IB20Q`）跨三站点实测 `asinKeywordList`：

| 站点 | 关键词总数 | 样本（keyword#keywordId） |
|---|---|---|
| US | 123 | `hdd hard drive#4293091`、`ssd wd black#11666565`、`kingston nvme#7924082` |
| UK | 15 | `laptop ssd#185899`、`ssd 2.5#344122`、`ssd internal hard drive#63240` |
| DE | 20 | `ssd 128#615708`、`ssd 120gb#2240895`、`ssd 2,5#2240898` |

结论：
1. **`keyword_id` 全局唯一**，各站点 ID 段完全不重叠 → 主键用 `(keyword_id)`，**不需要 country**
2. 关键词本身**带语言/地区特征**（DE 站是德语习惯的 `ssd 2,5` 逗号写法），
   说明一个 keyword_id 天然属于某个站点，不会跨站复用
3. **但 `dim_keyword` 仍建议保留 `country` 字段**（非主键，仅作标记），便于按站点筛词
4. 同一 ASIN 在各站点的关键词数量差异巨大（123 vs 15 vs 20），
   印证「ASIN×关键词」关系表必须带 `country` 进主键

## 五、`country` 强制约定

所有 `dim_` / `fact_` / `rel_` 表**必须**带 `country VARCHAR(8)` 且进主键。
依据：原站 axios 拦截器对所有业务请求强制追加 `country`，支持 13 个站点。
遗漏会导致不同站点的同一 ASIN 被 Unique Key 合并覆盖。

例外：`dict_` 枚举表不需要（枚举与站点无关）。
