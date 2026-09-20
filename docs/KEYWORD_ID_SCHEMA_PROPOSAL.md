# `keyword_id` 主键方案：影响面评估与改造建议

> **要解决什么**：Doris 里 **19 张表**用 `keyword_id` 作 UNIQUE KEY 成员，但 PG 侧只有
> `sif_asin_keyword` 一张表带这个 ID。其余关键词数据只有文本，反查命中率最低只有 **5.0%**，
> 导致 **297,543 行已抓到的数据灌不进 Doris**。
>
> 本文档给出三个方案的实测对比与推荐。**所有数字均为 2026-09-20 实查得出。**

---

## 一、问题的量化

### 1.1 当前阻塞的数据量

| PG 源表 | 总行数 | 能反查到 ID | 命中率 | **被阻塞行数** |
|---|---:|---:|---:|---:|
| `sif_asin_keyword` | 18,503 | 18,503 | **100%** | 0（自带 ID） |
| `sif_keyword_aba_trend` | 128,116 | 54,332 | 42.4% | **73,784** |
| `sif_asin_keyword_diagnose` | 205,086 | 10,282 | **5.0%** | **194,804** |
| `sif_keyword_overview` | 21,294 | 3,248 | 15.3% | **18,046** |
| `sif_asin_traffic_change` | 12,597 | 1,688 | 13.4% | **10,909** |
| **合计被阻塞** | | | | **297,543 行** |

反查方式：`JOIN sif_asin_keyword ON (site, keyword)`——这是全库唯一的 ID 来源。

### 1.2 已被实际验证的后果

上一步建的两张补缺表就是活例子，同一批 ETL 逻辑、同一个限制：

| 表 | 源行数 | 实际灌入 | 命中率 |
|---|---:|---:|---:|
| `dim_festival`（**不依赖 keyword_id**） | 156 | **156** | **100%** |
| `fact_keyword_competition_snapshot` | 21,276 | 3,244 | 15.2% |
| `fact_keyword_conversion_funnel` | 9,038 | 854 | 9.4% |

对比很清楚：唯一不依赖 `keyword_id` 的表完整落地，另两张各丢掉 85% 和 91%。

### 1.3 受影响的 19 张 Doris 表

全部把 `keyword_id` 作为 UNIQUE KEY 成员（`column_key=UNI`）：

`dim_keyword`、`fact_asin_keyword_snapshot`、`fact_asin_keyword_score`、`fact_asin_keyword_inout`、
`fact_keyword_metric_snapshot`、`fact_keyword_search_trend`、`fact_keyword_rank_history`、
`fact_asin_multinf_keyword`、`fact_asin_multinf_keyword_variant`、`fact_ad_search_term_exposure`、
`fact_keyword_competition_snapshot`、`fact_keyword_conversion_funnel`、
`rel_keyword_group`、`rel_keyword_top_asin`、`rel_rec_column_campaign_keyword`、
`rel_asin_keyword_variant_exposure`、`user_favorites`（非主键，普通列）

---

## 二、现状方案（不改）的致命问题

`dim_keyword` 现在是 `UNIQUE KEY(keyword_id)`，**不带 country**，注释写着「实测 keywordId 全局唯一」。

**这个前提不成立**，已抓到确凿反例：

```
keyword_id = 1120764
  FR 站 → "pastille lave glace"（玻璃水泡腾片）
  US 站 → "halloween trays for food"
```

两个完全不同的词共用一个 ID。按现有主键灌数，**这两条会互相覆盖，静默丢数据**。

各站 ID 段也大面积重叠，不存在"按段隔离"的可能：

| site | ID 最小 | ID 最大 |
|---|---:|---:|
| US | 161 | 19,163,538 |
| DE | 3,645 | 6,823,750 |
| UK | 2,627 | 2,647,554 |
| FR | 36,190 | 1,136,593 |

---

## 三、三个方案对比

### 方案 A：主键改用 `(keyword, country)`，`keyword_id` 降级为普通列 ⭐ 推荐

**可行性已实测验证**：

| 验证项 | 结果 |
|---|---|
| `(site, keyword, aba_date)` 在 `sif_keyword_overview` 唯一？ | ✅ 21,293/21,293 |
| `(site, keyword, granularity, period)` 在 `sif_keyword_aba_trend` 唯一？ | ✅ 128,116/128,116 |
| `(site, asin, data_date, kind, keyword)` 在 `sif_asin_traffic_change` 唯一？ | ✅ 12,596/12,596 |
| keyword 文本最大长度 | **128 字符**（平均 23，无一条 >128） |
| 文本是否已归一？ | ✅ 全库**已统一小写**，**零首尾空格**（三张表各查均为 0） |

**收益**：297,543 行立刻可灌，命中率从 5~42% 提到 **100%**。

**已在 Doris 上做过实机验证**（建临时表灌入真实冲突数据，验完已删）：

```sql
CREATE TABLE _t_kwkey_probe (
  keyword VARCHAR(128) NOT NULL, country VARCHAR(8) NOT NULL, val BIGINT
) UNIQUE KEY(keyword, country) DISTRIBUTED BY HASH(keyword) BUCKETS 2;

INSERT INTO _t_kwkey_probe VALUES
 ('halloween trays for food','US',1),   -- 与下一行共用 keyword_id=1120764
 ('pastille lave glace','FR',2),        -- 现状下这两行会互相覆盖
 ('戰鬥陀螺','JP',3),                    -- 验证 CJK
 ('christmas tree toppers','US',4),
 ('christmas tree toppers','US',99);    -- 验证 upsert
```

结果 **4 行**，三点都验证通过：
1. FR/US 那对 ID 冲突的词**各自独立存在**（现状主键下会丢一条）
2. 重复主键正确 upsert（`val` 从 4 覆盖为 99），merge-on-write 行为符合预期
3. CJK 关键词可正常作主键

**代价**：
- 19 张表的 UNIQUE KEY 要改，`keyword_id` 从主键降为普通列
- 主键变宽：`BIGINT`(8字节) → `VARCHAR(128)`，但实测平均只有 23 字符
- **两处语义合并**（需确认可接受）：实测有 2 个词在同站点下有两个 ID
  （`christmas tree toppers` → 3846971 / 14844774；`teacher valentine gifts` → 635708 / 14844099），
  改文本键后会合并成一行。考虑到上游 ID 本身不稳定（疑似新旧两套），合并**反而更合理**

### 方案 B：补抓缺失的 ID

对缺 ID 的词逐个调关键词接口补 ID。

**成本已实测**：缺 ID 的 distinct `(site, keyword)` 共 **109,185 个**。
按爬虫现有限速（`min_interval=1.2s` + 抖动）串行补抓：

```
109,185 × 1.2s ≈ 36.4 小时
```

**问题**：
- 36 小时只是下限，且不保证每个词都能拿到 ID（上游本身可能不返回）
- 补完之后仍然没解决方案 A 的核心问题——`keyword_id` 跨站点不唯一，`dim_keyword` 照样会覆盖
- 新增关键词会持续产生新的缺 ID 数据，这是个**永久性的运维负担**

### 方案 C：ETL 层生成代理 ID

对 `(keyword, country)` 做 hash 生成代理 `keyword_id`。

**问题**：
- 与原站 ID 割裂，日后若要接原站数据或做对账会冲突
- hash 有碰撞风险，需额外处理
- 本质上是"用 BIGINT 存一个文本的指纹"，不如方案 A 直接存文本清晰
- **不解决跨站点冲突**：如果 hash 只基于 keyword 不带 country，问题原样保留

---

## 四、推荐方案 A 的理由

### 4.1 改造时机现在最好

实测 Doris 侧这 19 张表**全部是种子数据，合计约 2.4 万行**：

| 表 | 现有行数 | 数据性质 |
|---|---:|---|
| `fact_keyword_rank_history` | 15,300 | 种子（ASIN 前缀 `B0SEED`） |
| `fact_keyword_competition_snapshot` | 3,244 | ✅ 真实（我刚灌的） |
| `fact_asin_keyword_score` | 2,625 | 种子 |
| `fact_keyword_conversion_funnel` | 854 | ✅ 真实（我刚灌的） |
| `fact_asin_keyword_snapshot` | 565 | 种子 |
| `rel_keyword_top_asin` | 548 | 种子 |
| 其余 13 张 | 0~200 | 种子或空 |

**没有生产数据要迁移**，现在改就是改 DDL + 重灌，成本接近于零。
等真实数据灌进去几百万行之后再改，代价会大得多。

### 4.2 与数据现状一致

方案 A 不是"将就"，而是**让 schema 匹配数据的真实形态**：
- 上游的稳定标识符事实上是**文本 + 站点**，不是 ID
- ID 只在 `asin-keyword-list` 这一个接口返回，其余 5 个关键词接口都不给
- ID 本身不稳定（跨站冲突 1 例、一词多 ID 2 例）

### 4.3 保留 `keyword_id` 作为普通列

不删除该列，继续存已知的 ID。这样：
- 需要与原站对账时仍可用
- 日后若上游补齐 ID，可无损升级回 ID 主键
- `user_favorites.keyword_id` 本来就是普通列，不受影响

---

## 五、实施步骤

| 步骤 | 内容 | 风险 |
|---|---|---|
| 1 | 改 `db/schema-02-business.sql`：18 张表的 `UNIQUE KEY` 把 `keyword_id` 换成 `keyword`，并确保 `country` 在键内 | 低 |
| 2 | `keyword` 列统一 `VARCHAR(128)`（实测最大值），加 `INVERTED` 索引供模糊搜索 | 低 |
| 3 | `keyword_id` 保留为普通 `BIGINT` 列，可为 NULL | 低 |
| 4 | Doris 侧 `DROP TABLE` 后重建（种子数据无需保留），或新建 `_v2` 表灰度 | 低（无生产数据） |
| 5 | 重跑 ETL，验证 297,543 行是否全部落地 | — |
| 6 | 补缺表 `fact_keyword_competition_snapshot` / `fact_keyword_conversion_funnel` 一并改造并重灌 | — |

**ETL 侧的 keyword 归一规则**（实测已无需处理，但建议在代码里显式做，防上游变化）：

```sql
keyword_norm = btrim(lower(keyword))
```

实测三张源表**当前均已是小写且无首尾空格**，此规则为防御性措施。

---

## 六、需要裁决的一件事

方案 A 会把「同站点同文本但有两个 ID」的词合并成一行，实测只影响 **2 个词**：

| site | keyword | 两个 ID |
|---|---|---|
| US | `christmas tree toppers` | 3846971 / 14844774 |
| US | `teacher valentine gifts` | 635708 / 14844099 |

我的判断是**应该合并**——同一站点同一个搜索词在业务上就是一个词，两个 ID 更像是上游新旧数据并存。
但这属于业务语义，需要你确认。

---

## 附：本文档所有数字的验证方式

| 数字 | 验证 SQL 思路 |
|---|---|
| 各表命中率 | `LEFT JOIN sif_asin_keyword ON (site,keyword)` 后 `count(keyword_id)/count(*)` |
| 主键唯一性 | `count(*) vs count(DISTINCT (键列组合))` |
| keyword 长度 | 三张源表 `UNION ALL` 后取 `max(length(keyword))` |
| 大小写/空格 | `count(*) FILTER (WHERE keyword <> lower(keyword))` 与 `<> btrim(keyword)` |
| 补抓成本 | 缺 ID 的 distinct `(site,keyword)` 数 × 1.2s（`crawl_config.min_interval` 默认值） |
| Doris 现有行数 | `information_schema.tables.table_rows` |
