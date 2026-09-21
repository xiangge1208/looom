# SIF 接口返回结构全量分析

> **两个口径，分工明确：**
> **可用性**（§3）来自 **CLI 实测** —— 43 个 endpoint 逐个实调，拿不到数据才算不可用；
> **字段结构**（§7）来自 `sif_api_log` 历史响应采样 —— 单次调用只能看到一种形态，
> 要判断某字段是否稳定填充，必须看上百条样本。两者都由脚本生成，见 [§8 如何复现](#8-如何复现)。
>
> | 项 | 值 |
> |---|---|
> | 生成日期 | 2026-09-20 |
> | 探针 ASIN | `B0FVNPKGJ8`（2 Piece Sets for Women 1/2 Zip Sweatsuit，US） |
> | 探针关键词 | `pink sweatsuit`（该 ASIN 的 `isMainKw`） |
> | **CLI 实测结果** | **37 可用 / 2 通但空 / 4 失效**（共 43 个） |
> | 日志表 | `amazon_data.public.sif_api_log`（PG `120.76.216.136:15432`） |
> | 日志总量 | 59,398 行 / 43 个 distinct `endpoint`（本次扫描自身也写入日志，故此数持续增长） |
> | 字段结构采样 | 每 endpoint 取最近 ≤120 条成功响应，共打平 **1,862 个字段** |

---

## 1. 结论速览

**三个要点：**

1. **endpoint 覆盖是齐全的。** `sif list` 声明 42 个接口，日志里有 43 个 —— 多出来的 `asin-overview`
   是 CLI 端的**虚拟聚合接口**（`sif asin` 子命令用，把 basic+stats+listing 三个调用合并落一条日志）。
   **没有任何声明了但从未被调用过的 endpoint**，也没有日志里出现却不在声明清单里的野接口。
2. **CLI 实测 37 个可用、4 个真失效、2 个通但返回空。**
   那 4 个失效的加 `--fresh` 重试仍全 404，是上游路由已移除。
   **要强调的是：低成功率 ≠ 接口坏了** —— 历史上 3,547 条 `code=-1 参数错误` 全是漏传必填字段，
   其中 **5 个接口连项目现有文档的示例入参都是不完整的**，详见 [§3 可用性](#3-endpoint-可用性以-cli-实测为准)。
3. **11 个 endpoint 用「业务值作 JSON key」而不是数组**，这是 ETL 最容易踩的坑 ——
   `data` 下直接挂 ASIN / 关键词 / 日期，必须先 `jsonb_each` 展开才能入表，
   详见 [§5 动态 key 陷阱](#5-动态-key-陷阱etl-必读)。

---

## 2. 统一响应信封

**43 个 endpoint 的外层结构完全一致**，三个固定字段：

```jsonc
{
  "code": 1,          // 1 = 成功，其余为失败（见下表）
  "message": null,    // 成功时恒为 null，失败时是中文错误文案
  "data": { ... }     // 业务数据，形状因接口而异
}
```

`sif_api_log` 的 `code` 列 = `resp->>'code'`，二者全表一致（`ok=true` 与 `code=1` 实测零偏差），
`ok` 列就是 `code = 1` 的布尔化。**判定成功只看 `code=1` 即可。**

### 错误码含义（实测全表分布）

| code | 条数 | 典型 message | 含义与处理 |
|---:|---:|---|---|
| `1` | 55,178 | `null` | 成功（此数随每次调用增长，失败各码的计数则稳定） |
| `-1` | 3,547 | `参数错误`；`timePieceTypemust not be blank` | **入参不合法**，最常见。改参数后可重试，不消耗配额语义 |
| `-999` | 401 | `HTTP 404` | **上游路由不存在**，客户端侧 3 次重试全败。属接口下线，别重试 |
| `0` | 253 | `服务异常` | 上游内部错误，可稍后重试 |
| `-22` | 20 | `访问过于频繁，请稍后重试` | **限速**，退避后重试 |
| `-7` | 3 | `token 失效且重登失败` | 需重新登录 |
| `-998` | 2 | `请求失败: The read operation timed out` | 网络层超时，可重试 |

> `-999` 与 `-998` 是 **CLI 客户端合成的码**（上游没返回合法 JSON 时兜底），
> 其余为上游业务码。

### 部分 webapp 接口多带积分字段

`web-keyword-extend`、`web-compete-keyword`、`web-compete-pattern` 的信封多出 5 个字段：

| 字段 | 含义 |
|---|---|
| `channel` | 调用渠道标识 |
| `consumeIntegral` | 本次调用消耗积分 |
| `balanceIntegral` | 剩余积分 |
| `integralLimit` | 积分上限 |
| `balanceLimit` | 剩余额度 |

**这是唯一能在响应里读到配额消耗的地方**，做限速调度时值得采集。

---
## 3. endpoint 可用性（以 CLI 实测为准）

**判定口径：用 `sif` CLI 把 43 个 endpoint 实际调一遍，拿不到数据才算不可用。**
不看 `sif_api_log` 的历史成功率 —— 那反映的是**过去调用方传错参**，不是接口现在的状态。
例如 `asin-statistics` 历史成功率只有 54.7%，但实测一调就通；
`asin-keyword-detail` 历史有 14 次"成功"，但那些响应的 `data` 全是空壳。

本次对 `B0FVNPKGJ8`（US）的实测结果：

| 结论 | 个数 | 含义 |
|---|---:|---|
| ✅ **可用** | **37** | 返回了非空业务数据 |
| ⚠️ **通但空** | **2** | `code=1` 但 `data` 是空容器 —— 需再判断是接口问题还是该 ASIN 无此数据 |
| ❌ **失效** | **4** | `HTTP 404`，加 `--fresh` 重试 3 次仍失败 |

> 复现：`python scripts/sif_sweep.py B0FVNPKGJ8 --country US --retry-fresh`
> 脚本对每个非 OK 结果会自动再用 `--fresh` 打一次，排除"缓存里存的是旧失败"。

### ✅ 可用（37 个）

全部返回非空数据，可直接用于 ETL：

`user-info`｜`login-user-info`｜`ranking-update-time`｜`user-group-product`｜
`keyword-overview`｜`keyword-aba-trend`｜`asins-search-exposure`｜`asin-basic-info`｜
`asin-statistics`｜`listing-summary`｜`asin-keyword-list`｜`asin-keyword-rank-history`｜
`asin-keyword-type-history`｜`traffic-trend`｜`traffic-change-detail`｜`asin-sales-history`｜
`asin-focus-status`｜`asin-bs-exposure`｜`web-sales-asin`｜`web-sales-listing-history`｜
`web-asin-variants`｜`web-sales-keyword`｜`web-asin-detail`｜`web-keyword-extend`｜
`web-est-searches-history`｜`web-variant-ad-keywords`｜`web-keywords-basic-info`｜
`web-asin-head-keywords`｜`web-asin-core-keywords`｜`web-traffic-diagnose`｜
`web-asin-traffic-detail`｜`web-asin-keyword-overview`｜`web-asin-keyword-trend`｜
`web-asin-day-trend`｜`web-compete-keyword`｜`web-keyword-conversion`｜`asin-overview`

### ⚠️ 通但返回空（2 个）——**都不是接口故障**

| endpoint | 实测 | 是接口坏了吗 | 判定依据 |
|---|---|---|---|
| `web-compete-pattern` | `asins:[]`、`total:null` | **不是** | 换日志里成功过的 `B0CG6C9Y35` 仍空；但日志中 82 次成功里 **22 次返回过非空**，最近一次 **2026-09-15**。说明接口正常，是这两个 ASIN 没竞品数据 |
| `monitor-keyword-query` | `list:[]` | **不是** | 该接口设计上「未开监控就返回空」。日志 5 次成功**全部**为空 `list`，从无非空记录 —— 需先在 SIF 后台开启坑位监控才有数据 |

**对 ETL 的含义**：这两个不能靠单次调用判断有无数据，要么多 ASIN 探测（`web-compete-pattern`），
要么先确认监控已开启（`monitor-keyword-query`）。

### ❌ 失效（4 个）——**不要再调**

| endpoint | 实测 | 日志佐证 | 替代方案 |
|---|---|---|---|
| `asin-keyword-detail` | `HTTP 404` | 189 次调用仅 14 "成功"，最后 **2026-08-24**；且那 14 条的 `data` 全是 `{"keywords":[]}` | **`asin-keyword-list`**（实测可用，字段更全） |
| `web-asin-flow-overview` | `HTTP 404` | 241 次 88 成功，最后成功 **2026-09-08** | **`web-asin-keyword-overview` + `listing-summary`** |
| `asin-history-cache` | `HTTP 404` | 74 次调用，**0 次成功**（从未成功过） | `asin-sales-history`（历史销量部分） |
| `asin-history-repair-status` | `HTTP 404` | 2 次调用，**0 次成功** | 无（该功能已下线） |

这 4 个都做过 `--fresh` 强制重爬，3 次重试全部 404 —— 是上游路由已移除，不是限速或缓存问题。

### 📌 入参才是真正的坑

**43 个里没有一个是"接口坏了"导致的低成功率** —— 历史上的 `code=-1 参数错误`（全表 3,547 条）
全部来自漏传必填字段。**项目现有文档的入参示例对 5 个接口是不完整的**，
按文档示例调会直接失败：

| endpoint | 文档示例缺什么 | 实测可用入参 |
|---|---|---|
| `web-compete-pattern` | `pageNum`+`pageSize` | `{"asin":"…","pageNum":1,"pageSize":20}` |
| `web-keyword-extend` | `pageNum`+`pageSize` | `{"keyword":"…","pageNum":1,"pageSize":50}` |
| `web-variant-ad-keywords` | `pageNum`+`pageSize`+`timePiece*` | `{"asin":"…","pageNum":1,"pageSize":100,"timePieceType":"latelyDay","timePieceValue":"30"}` |
| `web-asin-head-keywords` | `timePieceType`+`timePieceValue` | `{"asin":"…","timePieceType":"latelyDay","timePieceValue":"7"}` |
| `web-asin-core-keywords` | 同上 | `{"asin":"…","timePieceType":"latelyDay","timePieceValue":"7"}` |

补齐这 5 个的入参后，实测从 34/43 提升到 **39/43**（另 4 个是上面的失效接口）。
**正确入参已写进 [`scripts/sif_sweep.py`](../scripts/sif_sweep.py) 的 `build_jobs()`，以那里为准。**

另有几个接口文档示例虽然能跑通，但漏了会明显影响结果的字段：

| endpoint | 必须显式给 | 不给的后果 |
|---|---|---|
| `asin-sales-history` | `variantInfo`+`dimension` | 拿不到逐月历史 |
| `web-sales-listing-history` | `dimension` | 同上 |
| `web-asin-keyword-trend` | `granularity`（`week`/`month`） | 报错 |
| `web-compete-keyword` | `trendType` | 报错 |
| `web-traffic-diagnose` | `endDay` 粒度要与 `granularity` 匹配 | `月` 维度传 `2026-08-26` 会失败，得传 `2026-08` |

---

## 4. 探针 ASIN 的业务画像

顺带验证取到的数据是可读的（`B0FVNPKGJ8`，US）：

- 标题 `2 Piece Sets for Women 1/2 Zip Sweatsuit 2026 Matching Outfit Fall`，价 `$39.94`，评分 `4.2`（146 评）
- 流量词仅 **24 个**，且 **`natural=0` / `ad=24`** —— 纯广告流量，无自然位，典型新品特征
- 同变体组内 `B0FDKBBN3K` 有 1,744 词（`natural=544`），是该组真正的流量主力
- 主推词 `pink sweatsuit`：`spLastRank=3`，`scoreRatio=0.42`（贡献 42% 流量）

这也解释了为什么 `web-compete-pattern` 对它返回空 —— 新品还没积累出竞品格局数据。

---

## 5. 动态 key 陷阱（ETL 必读）

**11 个 endpoint 把业务值当 JSON key**，而不是放进数组。直接按固定路径取字段会全部取空，
必须先 `jsonb_each` 展开。下表是完整清单：

| endpoint | 动态路径 | key 类型 | 展开方式 |
|---|---|---|---|
| `asin-bs-exposure` | `data` | ASIN | `jsonb_each(resp->'data')` |
| `asins-search-exposure` | `data` | ASIN | 同上 |
| `web-est-searches-history` | `data.estSearchesNumHistory` | 关键词 | `jsonb_each(resp->'data'->'estSearchesNumHistory')` |
| `asin-keyword-type-history` | `data.adLastRankHistory`、`data.brandAdHistory`、`data.lastRankHistory` | 日期 | 每个 History 字段各展开 |
| `traffic-trend` | `data.subBsr` | 类目名 | `jsonb_each` |
| `asin-keyword-rank-history` | `data.recSpRankHistories` | 推荐位名 | `jsonb_each` |
| `web-asin-flow-overview` | `data.recommend` | 推荐位名 | （接口已失效） |
| `web-variant-ad-keywords` | `data.keywords[].nfHistory` / `.spHistory` | ASIN | 先展数组再 `jsonb_each` |
| `asin-keyword-list` | `data.list[].allRankHistory.recRanks[]` | 推荐位名 | 先展数组再 `jsonb_each` |
| `web-asin-core-keywords` | `data.suggestList[].allRankHistory.recRanks[]` | 推荐位名 | 同上 |
| `web-asin-head-keywords` | `data.suggestList[].allRankHistory.recRanks[]` | 推荐位名 | 同上 |

**对照示例** —— `asin-bs-exposure` 的真实响应：

```jsonc
{
  "code": 1,
  "data": {
    "B0FVNPKGJ8": {            // ← key 是 ASIN，不是 data[0].asin
      "asin": "B0FVNPKGJ8",
      "boughtInPastMonth": "<50",
      "boughtHistoryDates": ["2023-05", "2023-06", …],   // 39~40 个月
      "boughtHistory":      [0, 100, 50, …]              // 与上一数组等长、同序
    },
    "B0FDKBBN3K": { … }
  }
}
```

取数 SQL：

```sql
SELECT l.params->>'asins' AS asked,
       kv.key             AS asin,
       kv.value->>'boughtInPastMonth' AS bought_past_month
FROM sif_api_log l
CROSS JOIN LATERAL jsonb_each(l.resp->'data') AS kv
WHERE l.endpoint = 'asin-bs-exposure' AND l.ok IS TRUE;
```

### 另一个陷阱：平行数组靠下标对齐

多个接口用**两个等长数组**表达时间序列，靠**下标**而非对象配对：

| endpoint | 日期数组 | 值数组 |
|---|---|---|
| `asin-bs-exposure` | `boughtHistoryDates` | `boughtHistory` / `pasinBoughtHistory` |
| `asin-sales-history` | `boughtHistoryDates` | `chars[].boughtList` |
| `keyword-aba-trend` | `granularities` | `extSearchVolumes` / `keywordSearchVolumes` / `keywordRanks` |
| `web-est-searches-history` | `…{keyword}.date` | `…{keyword}.estSearchesNum` |

ETL 必须 `unnest(dates) WITH ORDINALITY` 与 `unnest(values) WITH ORDINALITY` 按序号 join。
另外 **值数组里大量是 null**：`asin-bs-exposure` 的 `boughtHistory[]` 实测填充率仅 **50.8%**
（即 49.2% 的月份是 null），落库时要区分「该月无数据」和「该月销量为 0」。

> `asin-keyword-type-history` 的 7 个 `*History` 字段中，本次样本只有 3 个是日期 map
> （`adLastRankHistory` / `brandAdHistory` / `lastRankHistory`），另外 4 个
> （`acHistory` / `erHistory` / `trHistory` / `vedioAdHistory`）在样本里为空。
> 该接口成功率仅 6.5%（31 次调用 2 次成功），样本不足，**结论仅供参考**。

---

## 6. 字段填充率的读法

字段表里的**填充率 = 非 null 占比**，分母是「该路径本可以出现的次数」：

- 普通字段：分母 = 父容器出现次数
- 折叠的动态 key（`data.{asin}`）：分母 = 所有样本里该层 key 的**总个数**
- 数组元素（`…[]`）：分母 = 元素总数

类型列的约定：

| 写法 | 含义 |
|---|---|
| `int` | 恒为整数 |
| `str?` | 字符串，但**存在 null**（问号 = 可空） |
| `int\|str` | 同一字段在不同样本里类型不一致，**入表要统一转换** |
| `array` / `object` | 容器，其子字段在下方各自成行 |
| `null` | 采样范围内**恒为 null**，建表时可考虑不建列 |

> **恒 null 字段值得留意**：如 `login-user-info.data.username`、
> `asin-bs-exposure.data.{asin}.pasinBoughtInPastMonth` 在全部样本里都是 null，
> 这类字段建列前应先确认上游是否真的会填。
> 项目已有的 `docs/ETL_GAP_ANALYSIS.md` 也是按这个口径判断「不建列」的。

---

## 7. 逐 endpoint 字段表

按 CLI 的分组组织。每个 endpoint 给出：日志样本量与成功率、实测可用入参、
动态 key 标注（🔑），以及完整字段清单。

> 字段表最多列 45 行，超出部分见 `_schemas.json`（脚本产物，含全部 1,862 个字段）。

<!-- BEGIN GENERATED: 由 scripts/sif_gen_schema_doc.py 生成，勿手改 -->

### meta —— 会员与元信息

#### `login-user-info`

登录用户基础资料

- **可用性**：✅ CLI 实测可用（0.36s，311 B）
- **字段表样本**：1 条历史成功响应（日志共 1 条，2026-09-20 ~ 2026-09-20），打平 6 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.isSuccess` | bool | 100.0% | True |
| `data.phone` | str | 100.0% | 13971928487 |
| `data.userid` | str | 100.0% | 34P61LHHlQwyT16O642flqho |
| `data.username` | null | 0.0% |  |

#### `ranking-update-time`

排名数据最近更新时间，判断数据新鲜度

- **可用性**：✅ CLI 实测可用（0.35s，303 B）
- **字段表样本**：1 条历史成功响应（日志共 1 条，2026-09-14 ~ 2026-09-14），打平 6 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.date` | str | 100.0% | 2026-08-01 |
| `data.month` | str | 100.0% | 2026-08 |
| `data.week` | str | 100.0% | 2026/08/30-2026/09/05 |
| `message` | null | 0.0% |  |

#### `user-group-product`

该 ASIN 归属的自建商品分组

- **可用性**：✅ CLI 实测可用（0.38s，310 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8", "sortBy": ""}`
- **字段表样本**：5 条历史成功响应（日志共 5 条，2026-08-21 ~ 2026-09-20），打平 7 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | array | 100.0% | len 1~1 |
| `data[]` | object | 100.0% |  |
| `data[].groupName` | str | 100.0% | 我的产品 |
| `data[].groupType` | int | 100.0% | =1; 1 |
| `data[].groupid` | str | 100.0% | 231964 / 231168 / 201208 |
| `data[].isAdd` | bool | 100.0% | False |

#### `user-info`

当前 SIF 会员信息：vip 等级、有效期

- **可用性**：✅ CLI 实测可用（0.84s，533 B）
- **字段表样本**：1 条历史成功响应（日志共 1 条，2026-09-14 ~ 2026-09-14），打平 13 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.expirationDate` | str | 100.0% | 2027-09-02 23:59:59 |
| `data.isCountryLimitPermit` | bool | 100.0% | True |
| `data.isExtRegister` | bool | 100.0% | False |
| `data.isOfficialRegister` | bool | 100.0% | True |
| `data.isPaidVip` | bool | 100.0% | True |
| `data.isRenewal` | bool | 100.0% | False |
| `data.isSpecialVip` | bool | 100.0% | True |
| `data.isValidVip` | bool | 100.0% | True |
| `data.userid` | str | 100.0% | D0VXioD4Qh68lr0e5Pg2tLXl |
| `data.vipLevel` | str | 100.0% | shark |
| `data.vipType` | int | 100.0% | =1; 1 |

### keyword —— 关键词维度

#### `keyword-aba-trend`

关键词搜索趋势 + ABA 排名逐期曲线

- **可用性**：✅ CLI 实测可用（0.37s，5,747 B）
- **本次实调入参**：`{"keyword": "pink sweatsuit", "granularity": "month"}`
- **字段表样本**：120 条历史成功响应（日志共 5284 条，2026-08-10 ~ 2026-09-20），打平 17 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object? | 77.5% |  |
| `data.extSearchVolumes` | array | 100.0% | len 23~23 |
| `data.extSearchVolumes[]` | int? | 69.3% | 1267 ~ 29165903; 22094 / 25235 / 19416 |
| `data.festivals` | array | 100.0% | len 23~23 |
| `data.festivals[]` | array? | 78.1% | len 1~2 |
| `data.festivals[][]` | object | 100.0% |  |
| `data.festivals[][].endDate` | str | 100.0% | 2024-10-09 / 2024-10-31 / 2024-12-02 |
| `data.festivals[][].name` | str | 100.0% | Prime秋季大促会员日 / 万圣节 / 黑五网一 |
| `data.festivals[][].startDate` | str | 100.0% | 2024-10-08 / 2024-10-31 / 2024-11-21 |
| `data.granularities` | array | 100.0% | len 23~23 |
| `data.granularities[]` | str | 100.0% | 2024-10 / 2024-11 / 2024-12 |
| `data.keywordRanks` | array | 100.0% | len 23~23 |
| `data.keywordRanks[]` | int? | 67.5% | 22 ~ 1482651; 172070 / 164497 / 220796 |
| `data.keywordSearchVolumes` | array | 100.0% | len 23~23 |
| `data.keywordSearchVolumes[]` | int? | 67.5% | 1267 ~ 3619824; 8722 / 10055 / 8191 |
| `message` | null | 0.0% |  |

#### `keyword-overview`

关键词概览：搜索量、真实产品数、各类广告产品数

- **可用性**：✅ CLI 实测可用（0.47s，725 B）
- **本次实调入参**：`{"keyword": "pink sweatsuit"}`
- **字段表样本**：120 条历史成功响应（日志共 21910 条，2026-08-07 ~ 2026-09-20），打平 21 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.abaDate` | str | 100.0% | 2026-09-06 |
| `data.abaDateEnd` | str | 100.0% | 2026-09-12 |
| `data.acAsinNum` | int | 100.0% | =0; 0 |
| `data.brandAdAsinNum` | int | 100.0% | 0 ~ 189; 30 / 77 / 41 |
| `data.demandRatio` | null | 0.0% |  |
| `data.erAsinNum` | int | 100.0% | =0; 0 |
| `data.estSearchesNum` | int | 100.0% | 0 ~ 208781; 232 / 419 / 590 |
| `data.globalKeywordNum` | int | 100.0% | =1000000; 1000000 |
| `data.keyword` | str | 100.0% | 15 inch round tray / wooden stand for kitchen counter / wooden pedestal stand |
| `data.nfAsinNum` | int | 100.0% | 0 ~ 415; 141 / 242 / 256 |
| `data.ppcAdAsinNum` | int | 100.0% | 0 ~ 326; 60 / 257 / 190 |
| `data.saleNum` | int? | 59.2% | 549 ~ 221614; 5115 / 61292 / 105324 |
| `data.searchRecommendAsinNum` | int | 100.0% | 0 ~ 183; 22 / 100 / 93 |
| `data.searchesRank` | int | 100.0% | 0 ~ 2620986; 1474977 / 816317 / 577344 |
| `data.spAdAsinNum` | int | 100.0% | 0 ~ 183; 30 / 165 / 143 |
| `data.trAsinNum` | int | 100.0% | =0; 0 |
| `data.updateTime` | str? | 59.2% | 2026-09-12 |
| `data.vedioAdAsinNum` | int | 100.0% | 0 ~ 24; 2 / 22 / 11 |
| `message` | null | 0.0% |  |

### asin —— ASIN 维度

#### `asin-basic-info`

标题/主图/价格/评分/评论数

- **可用性**：✅ CLI 实测可用（0.4s，885 B）
- **本次实调入参**：`{"asins": ["B0FVNPKGJ8"]}`
- **字段表样本**：120 条历史成功响应（日志共 373 条，2026-08-12 ~ 2026-09-20），打平 24 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | array | 100.0% | len 1~27 |
| `data[]` | object | 100.0% |  |
| `data[].asin` | str | 100.0% | B0FVNPKGJ8 / B0H361D35D / B0HCNWGYWJ |
| `data[].bestSellers` | null | 0.0% |  |
| `data[].bestSellersTime` | null | 0.0% |  |
| `data[].boughtInPastWeek` | null | 0.0% |  |
| `data[].brand` | null | 0.0% |  |
| `data[].brandLink` | null | 0.0% |  |
| `data[].buyBox` | null | 0.0% |  |
| `data[].buyBoxLink` | null | 0.0% |  |
| `data[].category` | null | 0.0% |  |
| `data[].img` | str? | 90.3% | https://m.media-amazon.com/images/I/61gom4zyZBL._AC_UL320_.j… / https://m.media-amazon.com/images/I/8183EpwRACL._AC_UL320_.j… / https://m.media-amazon.com/images/I/711obDvprPL._AC_UL320_.j… |
| `data[].isBestSeller` | null | 0.0% |  |
| `data[].isCoupon` | null | 0.0% |  |
| `data[].isFocus` | bool | 100.0% | False |
| `data[].isLimitedTimeDeal` | null | 0.0% |  |
| `data[].isLowest30` | null | 0.0% |  |
| `data[].price` | float? | 90.3% | 2.77 ~ 189.99; 39.94 / 39.99 / 66.99 |
| `data[].ratingNum` | int? | 87.9% | 1 ~ 235888; 146 / 14 / 75 |
| `data[].score` | float? | 88.0% | 1.0 ~ 5.0; 4.2 / 4.4 / 4.5 |
| `data[].star` | float? | 88.0% | 1.0 ~ 5.0; 4.0 / 4.5 / 5.0 |
| `data[].title` | str? | 90.3% | 2 Piece Sets for Women 1/2 Zip Sweatsuit 2026 Matching Outfi… / 3 Pack Women's Long Sleeve Henley Shirts Tunic Tops / Sweet Lolita Dress Pink Layered Ruffle Dress with White Lace… |
| `message` | null | 0.0% |  |

#### `asin-focus-status`

一组 ASIN 是否已被当前账号关注

- **可用性**：✅ CLI 实测可用（0.35s，281 B）
- **本次实调入参**：`{"asins": ["B0FVNPKGJ8"]}`
- **字段表样本**：3 条历史成功响应（日志共 5 条，2026-09-04 ~ 2026-09-20），打平 6 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | array | 100.0% | len 1~1 |
| `data[]` | object | 100.0% |  |
| `data[].asin` | str | 100.0% | B0FVNPKGJ8 / B09B8V1LZ3 / B07KVV8RFF |
| `data[].isFocus` | bool | 100.0% | False |
| `message` | null | 0.0% |  |

#### `asin-history-cache`

BSR/价格历史缓存。已失效，从无成功记录

- **可用性**：❌ CLI 实测失效（HTTP 404）（2.56s，154 B）｜HTTP 404
- **本次实调入参**：`{"asin": "B0FVNPKGJ8"}`
- **字段表样本**：**无** —— 日志里 74 次调用全部失败（2026-08-18 ~ 2026-09-20），无成功响应可采样，因此无法给出字段结构

> 该接口无任何成功响应，字段结构未知。

#### `asin-history-repair-status`

历史数据补齐进度。已失效，从无成功记录

- **可用性**：❌ CLI 实测失效（HTTP 404）（3.55s，154 B）｜HTTP 404
- **本次实调入参**：`{"asin": "B0FVNPKGJ8"}`
- **字段表样本**：**无** —— 日志里 2 次调用全部失败（2026-09-20 ~ 2026-09-20），无成功响应可采样，因此无法给出字段结构

> 该接口无任何成功响应，字段结构未知。

#### `asin-keyword-detail`

反查词精细版。已失效，用 asin-keyword-list 代替

- **可用性**：❌ CLI 实测失效（HTTP 404）（3.4s，154 B）｜HTTP 404
- **本次实调入参**：`{"asin": "B0FVNPKGJ8", "desc": true, "sortBy": "scoreInfo.scoreRatio", "pageNum": 1, "pageSize": 80}`
- **字段表样本**：14 条历史成功响应（日志共 189 条，2026-08-12 ~ 2026-09-20），打平 4 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.keywords` | array | 100.0% | len 0~0 |
| `message` | null | 0.0% |  |

#### `asin-keyword-list`

反查流量词（核心）：流量分、占比、曝光位、排名

- **可用性**：✅ CLI 实测可用（0.49s，20,269 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8", "pageNo": 1, "pageSize": 20}`
- **字段表样本**：120 条历史成功响应（日志共 7282 条，2026-08-06 ~ 2026-09-20），打平 97 个字段
- **⚠️ 动态 key**：以下路径是「以业务值为 key 的 map」，不是数组，ETL 要先 `jsonb_each` 展开：
    - `data.list[].allRankHistory.recRanks[]` 的 key 是 {keyword}

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.campaignRemark` | object? | 43.3% |  |
| `data.list` | array? | 75.8% | len 1~4 |
| `data.list[]` | object | 100.0% |  |
| `data.list[].ac` | bool | 100.0% | False / True |
| `data.list[].allRankHistory` | object | 100.0% |  |
| `data.list[].allRankHistory.date` | array | 100.0% | len 8~8 |
| `data.list[].allRankHistory.date[]` | str | 100.0% | 2026-09-12 / 2026-09-13 / 2026-09-14 |
| `data.list[].allRankHistory.nfRank` | array | 100.0% | len 8~8 |
| `data.list[].allRankHistory.nfRank[]` | object? | 54.9% |  |
| `data.list[].allRankHistory.nfRank[].asin` | str | 100.0% | B0H6JM86RZ / B0H44N9H9N / B0H154KVKZ |
| `data.list[].allRankHistory.nfRank[].asinOrder` | null | 0.0% |  |
| `data.list[].allRankHistory.nfRank[].campaignId` | null | 0.0% |  |
| `data.list[].allRankHistory.nfRank[].maskCampaignId` | null | 0.0% |  |
| `data.list[].allRankHistory.nfRank[].rank` | int | 100.0% | 1 ~ 144; 112 / 109 / 118 |
| `data.list[].allRankHistory.nfRank[].rankStr` | str | 100.0% | p3,16/48 / p3,13/48 / p3,22/48 |
| `data.list[].allRankHistory.nfRank[].rankTime` | str | 100.0% | 2026-09-12 / 2026-09-13 / 2026-09-14 |
| `data.list[].allRankHistory.recRanks` | array | 100.0% | len 8~8 |
| `data.list[].allRankHistory.recRanks[]` 🔑 | object? | 5.9% |  |
| `data.list[].allRankHistory.recRanks[].{keyword}` | object | 100.0% |  |
| `data.list[].allRankHistory.recRanks[].{keyword}.campaignId` | str | 100.0% | A003030132S4JX5X39JO3 / A02431261PL626E6AB61I / A10126431QH2F1T83Y20G |
| `data.list[].allRankHistory.recRanks[].{keyword}.maskCampaignId` | str | 100.0% | 9JO3 / B61I / Y20G |
| `data.list[].allRankHistory.sbRank` | array | 100.0% | len 8~8 |
| `data.list[].allRankHistory.sbRank[]` | object? | 4.3% |  |
| `data.list[].allRankHistory.sbRank[].asin` | str? | 10.3% | B0F62P61G5 / B0DRHN7DYM / B0DYDY3CT8 |
| `data.list[].allRankHistory.sbRank[].asinOrder` | int | 100.0% | 1 ~ 2; 1 / 2 |
| `data.list[].allRankHistory.sbRank[].campaignId` | str | 100.0% | 300071763078606 / 200072134983471 / 200091224905071 |
| `data.list[].allRankHistory.sbRank[].maskCampaignId` | str | 100.0% | 5G96 / I24C / AAKX |
| `data.list[].allRankHistory.sbRank[].rank` | float | 100.0% | 1.1 ~ 3.5; 2.9 / 1.9 / 1.5 |
| `data.list[].allRankHistory.sbRank[].rankStr` | str | 100.0% | sb,2,tail / sb,1,tail / sb,1,middle |
| `data.list[].allRankHistory.sbRank[].rankTime` | str | 100.0% | 2026-09-13 / 2026-09-14 / 2026-09-15 |
| `data.list[].allRankHistory.sbvRank` | array | 100.0% | len 8~8 |
| `data.list[].allRankHistory.sbvRank[]` | object? | 0.8% |  |
| `data.list[].allRankHistory.sbvRank[].asin` | str? | 9.1% | B0FL29DXNV / B0HDZ9FV4K |
| `data.list[].allRankHistory.sbvRank[].asinOrder` | int | 100.0% | =1; 1 |
| `data.list[].allRankHistory.sbvRank[].campaignId` | str | 100.0% | 200107110615371 / 200116148628471 / 200097179651171 |
| `data.list[].allRankHistory.sbvRank[].maskCampaignId` | str | 100.0% | 5371 / 8471 / 1171 |
| `data.list[].allRankHistory.sbvRank[].rank` | float | 100.0% | 1.1 ~ 2.8; 2.8 / 1.5 / 2.1 |
| `data.list[].allRankHistory.sbvRank[].rankStr` | str | 100.0% | sbv,2,bottom / sbv,1,middle / sbv,2,top |
| `data.list[].allRankHistory.sbvRank[].rankTime` | str | 100.0% | 2026-09-14 / 2026-09-15 / 2026-09-16 |
| `data.list[].allRankHistory.spRank` | array | 100.0% | len 8~8 |
| `data.list[].allRankHistory.spRank[]` | object? | 9.8% |  |
| `data.list[].allRankHistory.spRank[].asin` | str | 100.0% | B0H154KVKZ / B0FF3VWQGZ / B0GZ39NJMG |
| `data.list[].allRankHistory.spRank[].asinOrder` | null | 0.0% |  |
| … 另有 52 个字段 | | | 见 `_schemas.json` |

#### `asin-keyword-rank-history`

某 ASIN 某词下的逐日排名曲线

- **可用性**：✅ CLI 实测可用（0.36s，1,284 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8", "keyword": "pink sweatsuit"}`
- **字段表样本**：120 条历史成功响应（日志共 157 条，2026-09-03 ~ 2026-09-20），打平 52 个字段
- **⚠️ 动态 key**：以下路径是「以业务值为 key 的 map」，不是数组，ETL 要先 `jsonb_each` 展开：
    - `data.recSpRankHistories` 的 key 是 {keyword}

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object? | 87.5% |  |
| `data.campaignRemark` | object? | 89.5% |  |
| `data.dates` | array | 100.0% | len 6~989 |
| `data.dates[]` | str | 100.0% | 2026-09-12 / 2026-09-13 / 2026-09-14 |
| `data.nfRankHistory` | array | 100.0% | len 6~989 |
| `data.nfRankHistory[]` | object? | 32.1% |  |
| `data.nfRankHistory[].asin` | str | 100.0% | B0HB4P4VWJ / B0CBLHY7VJ / B0DQ3B5T55 |
| `data.nfRankHistory[].asinOrder` | null | 0.0% |  |
| `data.nfRankHistory[].campaignId` | null | 0.0% |  |
| `data.nfRankHistory[].maskCampaignId` | null | 0.0% |  |
| `data.nfRankHistory[].rank` | int | 100.0% | 1 ~ 148; 3 / 90 / 86 |
| `data.nfRankHistory[].rankStr` | str | 100.0% | p1,3/48 / p2,42/48 / p2,38/48 |
| `data.nfRankHistory[].rankTime` | str? | 0.3% | 2026-09-17 / 2026-09-16 / 2026-09-15 |
| `data.recSpRankHistories` 🔑 | object | 100.0% |  |
| `data.recSpRankHistories.{keyword}` | array | 100.0% | len 8~989 |
| `data.recSpRankHistories.{keyword}[]` | object? | 2.0% |  |
| `data.recSpRankHistories.{keyword}[].asin` | null | 0.0% |  |
| `data.recSpRankHistories.{keyword}[].asinOrder` | int | 100.0% | 1 ~ 6; 2 / 3 / 1 |
| `data.recSpRankHistories.{keyword}[].campaignId` | str | 100.0% | A0790054N1KGS463X3BC / A017137639OMEYV0MG4ZX / A000761433HV0VVRT4MNE |
| `data.recSpRankHistories.{keyword}[].maskCampaignId` | str | 100.0% | X3BC / G4ZX / 4MNE |
| `data.recSpRankHistories.{keyword}[].rank` | float | 100.0% | 1.2 ~ 3.9; 3.4 / 3.3 / 1.9 |
| `data.recSpRankHistories.{keyword}[].rankStr` | str | 100.0% | New arrivals,3,3.4 / New arrivals,3,3.3 / Trending now,1,1.9 |
| `data.recSpRankHistories.{keyword}[].rankTime` | null | 0.0% |  |
| `data.sbRankHistory` | array | 100.0% | len 6~989 |
| `data.sbRankHistory[]` | object? | 3.6% |  |
| `data.sbRankHistory[].asin` | str? | 0.2% | B0D7NZW7HZ / B0B5WMT1J8 / B0DWSGN78X |
| `data.sbRankHistory[].asinOrder` | int | 100.0% | 1 ~ 9; 1 / 3 / 2 |
| `data.sbRankHistory[].campaignId` | str | 100.0% | 200121447611671 / 200099433665971 / 300017800077906 |
| `data.sbRankHistory[].maskCampaignId` | str | 100.0% | 406K / HZ1F / 06XR |
| `data.sbRankHistory[].rank` | float | 100.0% | 1.1 ~ 3.9; 1.1 / 3.9 / 1.9 |
| `data.sbRankHistory[].rankStr` | str | 100.0% | sb,1,top / sb,3,tail / sb,1,tail |
| `data.sbRankHistory[].rankTime` | str? | 0.2% | 2026-09-17 / 2026-09-15 |
| `data.sbvRankHistory` | array | 100.0% | len 6~989 |
| `data.sbvRankHistory[]` | object? | 1.8% |  |
| `data.sbvRankHistory[].asin` | str? | 0.1% | B00Q7XUUC2 |
| `data.sbvRankHistory[].asinOrder` | int | 100.0% | =1; 1 |
| `data.sbvRankHistory[].campaignId` | str | 100.0% | 300045868004806 / 200064180046971 / 200078626601471 |
| `data.sbvRankHistory[].maskCampaignId` | str | 100.0% | D9VH / 6971 / 1471 |
| `data.sbvRankHistory[].rank` | float | 100.0% | 1.1 ~ 3.8; 2.5 / 2.8 / 3.5 |
| `data.sbvRankHistory[].rankStr` | str | 100.0% | sbv,2,middle / sbv,2,bottom / sbv,3,middle |
| `data.sbvRankHistory[].rankTime` | str? | 0.1% | 2026-09-07 |
| `data.spRankHistory` | array | 100.0% | len 6~989 |
| `data.spRankHistory[]` | object? | 4.3% |  |
| `data.spRankHistory[].asin` | str | 100.0% | B0FVNPKGJ8 / B0CBLHY7VJ / B0DQ3B5T55 |
| … 另有 7 个字段 | | | 见 `_schemas.json` |

#### `asin-keyword-type-history`

关键词分渠道（自然/广告）历史

- **可用性**：✅ CLI 实测可用（0.39s，652 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8", "keyword": "pink sweatsuit"}`
- **字段表样本**：2 条历史成功响应（日志共 31 条，2026-08-21 ~ 2026-09-20），打平 14 个字段
- **⚠️ 动态 key**：以下路径是「以业务值为 key 的 map」，不是数组，ETL 要先 `jsonb_each` 展开：
    - `data.adLastRankHistory` 的 key 是 {date}
    - `data.brandAdHistory` 的 key 是 {date}
    - `data.lastRankHistory` 的 key 是 {date}

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.acHistory` | object | 100.0% |  |
| `data.adLastRankHistory` 🔑 | object | 100.0% |  |
| `data.adLastRankHistory.{date}` | int? | 0.7% | 3 ~ 22; 3 / 22 / 10 |
| `data.brandAdHistory` 🔑 | object | 100.0% |  |
| `data.brandAdHistory.{date}` | int? | 0.3% | =1; 1 |
| `data.erHistory` | object | 100.0% |  |
| `data.lastRankHistory` 🔑 | object | 100.0% |  |
| `data.lastRankHistory.{date}` | int? | 47.8% | 10 ~ 93; 35 / 38 / 33 |
| `data.maxRank` | str | 100.0% | 2026-09-20 / 2026-09-16 |
| `data.trHistory` | object | 100.0% |  |
| `data.vedioAdHistory` | object | 100.0% |  |
| `message` | null | 0.0% |  |

#### `asin-sales-history`

近月销量 + 约 3 年逐月历史销量

- **可用性**：✅ CLI 实测可用（0.58s，893 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8", "variantInfo": {"asin": "B0FVNPKGJ8"}, "dimension": 1}`
- **字段表样本**：47 条历史成功响应（日志共 497 条，2026-08-11 ~ 2026-09-20），打平 17 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.boughtHistoryDates` | array | 100.0% | len 0~40 |
| `data.boughtHistoryDates[]` | str | 100.0% | 2025-12 / 2026-01 / 2026-02 |
| `data.boughtInPastMonth` | str | 100.0% | <50 / 4,000+ / 700+ |
| `data.chars` | array | 100.0% | len 0~1 |
| `data.chars[]` | object | 100.0% |  |
| `data.chars[].boughtInPastMonthBest` | null | 0.0% |  |
| `data.chars[].boughtList` | array | 100.0% | len 1~40 |
| `data.chars[].boughtList[]` | int? | 90.7% | 0 ~ 10000; 0 / 50 / 100 |
| `data.chars[].dimVal` | str | 100.0% | B0FVNPKGJ8 / B0D7W242KX / B0BC1524WW |
| `data.chars[].features` | null | 0.0% |  |
| `data.chars[].img` | str? | 9.3% | https://m.media-amazon.com/images/I/715r6o+-GkL._AC_UL320_.j… / https://m.media-amazon.com/images/I/91b075CJ6nL._AC_UL320_.j… / https://m.media-amazon.com/images/I/81zi-XCJ19L._AC_UL320_.j… |
| `data.features` | array | 100.0% | len 0~0 |
| `data.pasinBoughtInPastMonth` | str | 100.0% | <50 / 4,000+ / 700+ |
| `data.total` | int | 100.0% | 0 ~ 1; 1 / 0 |
| `message` | null | 0.0% |  |

#### `asin-statistics`

流量词总数、近月销量、是否被关注

- **可用性**：✅ CLI 实测可用（0.38s，290 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8"}`
- **字段表样本**：47 条历史成功响应（日志共 86 条，2026-08-12 ~ 2026-09-20），打平 6 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.boughtInPastMonth` | int? | 44.7% | 50 ~ 10000; 100 / 3000 / 4000 |
| `data.isFocus` | bool | 100.0% | False |
| `data.keywordNum` | int | 100.0% | 0 ~ 5391; 24 / 0 / 16 |
| `message` | null | 0.0% |  |

#### `asins-search-exposure`

一组 ASIN 在搜索结果中的曝光占比

- **可用性**：✅ CLI 实测可用（0.46s，396 B）
- **本次实调入参**：`{"asins": ["B0FVNPKGJ8"]}`
- **字段表样本**：81 条历史成功响应（日志共 100 条，2026-08-19 ~ 2026-09-20），打平 25 个字段
- **⚠️ 动态 key**：以下路径是「以业务值为 key 的 map」，不是数组，ETL 要先 `jsonb_each` 展开：
    - `data` 的 key 是 {asin}

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` 🔑 | object | 100.0% |  |
| `data.{asin}` | object | 100.0% |  |
| `data.{asin}.asin` | str | 100.0% | B0FVNPKGJ8 / B0D7W242KX / B0CSNTXVYF |
| `data.{asin}.exposureRatioScore` | object? | 17.2% |  |
| `data.{asin}.exposureRatioScore.brandAdRank` | int? | 11.8% | 15 ~ 72; 15 / 72 / 70 |
| `data.{asin}.exposureRatioScore.brandAdScoreRatio` | float | 100.0% | 0.0 ~ 0.0009313939944725475; 0.00023473267358155704 / 0.0009313939944725473 / 0.0009313939944725475 |
| `data.{asin}.exposureRatioScore.nfRank` | int? | 76.5% | 1 ~ 102; 102 / 100 / 70 |
| `data.{asin}.exposureRatioScore.nfScoreRatio` | float | 100.0% | 0.0 ~ 0.09345549685074946; 0.002322177412915819 / 0.0 / 0.0025482778190052263 |
| `data.{asin}.exposureRatioScore.recRank` | int? | 5.9% | 2 ~ 10; 2 / 10 |
| `data.{asin}.exposureRatioScore.recScoreRatio` | float | 100.0% | 0.0 ~ 0.15002219697590105; 0.0 / 0.15002219697590105 / 0.01996897341104527 |
| `data.{asin}.exposureRatioScore.spRank` | int? | 41.2% | 4 ~ 86; 68 / 21 / 15 |
| `data.{asin}.exposureRatioScore.spScoreRatio` | float | 100.0% | 0.0 ~ 0.1095371530868073; 0.0 / 0.002387400384655286 / 0.015070045523922753 |
| `data.{asin}.exposureRatioScore.vedioAdRank` | int? | 5.9% | 7 ~ 20; 7 / 20 |
| `data.{asin}.exposureRatioScore.vedioAdScoreRatio` | float | 100.0% | 0.0 ~ 0.05933254522900388; 0.0 / 0.05933254522900388 / 0.004047575081317579 |
| `data.{asin}.history` | object? | 17.2% |  |
| `data.{asin}.history.adLastRankHistory` | array | 100.0% | len 8~8 |
| `data.{asin}.history.adLastRankHistory[]` | int? | 9.9% | 1 ~ 36; 19 / 4 / 3 |
| `data.{asin}.history.date` | array | 100.0% | len 8~8 |
| `data.{asin}.history.date[]` | str | 100.0% | 2026-09-08 / 2026-09-09 / 2026-09-10 |
| `data.{asin}.history.lastRankHistory` | array | 100.0% | len 8~8 |
| `data.{asin}.history.lastRankHistory[]` | int? | 48.5% | 1 ~ 135; 135 / 87 / 108 |
| `data.{asin}.isFocus` | bool | 100.0% | False |
| `data.{asin}.pasinBoughtInPastMonth` | null | 0.0% |  |
| `message` | null | 0.0% |  |

#### `listing-summary`

Listing 各口径流量词数 + 变体横向对比

- **可用性**：✅ CLI 实测可用（0.47s，3,081 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8"}`
- **字段表样本**：120 条历史成功响应（日志共 372 条，2026-08-12 ~ 2026-09-20），打平 29 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.asins` | array | 100.0% | len 1~4 |
| `data.asins[]` | object | 100.0% |  |
| `data.asins[].ac` | int | 100.0% | 0 ~ 207; 0 / 26 / 2 |
| `data.asins[].acBest` | bool | 100.0% | False / True |
| `data.asins[].ad` | int | 100.0% | 0 ~ 4382; 24 / 1455 / 1421 |
| `data.asins[].adBest` | bool | 100.0% | False / True |
| `data.asins[].asin` | str | 100.0% | B0FVNPKGJ8 / B0FDKBBN3K / B0FDKBC2H1 |
| `data.asins[].brand` | int | 100.0% | 0 ~ 2328; 0 / 1331 / 1334 |
| `data.asins[].brandBest` | bool | 100.0% | False / True |
| `data.asins[].brandVedio` | int | 100.0% | 0 ~ 4358; 0 / 1331 / 1334 |
| `data.asins[].brandVedioBest` | bool | 100.0% | False / True |
| `data.asins[].features` | array? | 94.6% | len 1~3 |
| `data.asins[].features[]` | str | 100.0% | Standard / XX-Large / Pink |
| `data.asins[].isFocus` | bool | 100.0% | False |
| `data.asins[].natural` | int | 100.0% | 0 ~ 1942; 0 / 544 / 69 |
| `data.asins[].naturalBest` | bool | 100.0% | False / True |
| `data.asins[].rec` | int | 100.0% | 0 ~ 693; 21 / 167 / 97 |
| `data.asins[].recBest` | bool | 100.0% | False / True |
| `data.asins[].sp` | int | 100.0% | 0 ~ 442; 3 / 157 / 106 |
| `data.asins[].spBest` | bool | 100.0% | False / True |
| `data.asins[].spRec` | int | 100.0% | 0 ~ 942; 24 / 259 / 168 |
| `data.asins[].spRecBest` | bool | 100.0% | False / True |
| `data.asins[].total` | int | 100.0% | 0 ~ 5391; 24 / 1744 / 1455 |
| `data.asins[].totalBest` | bool | 100.0% | False / True |
| `data.asins[].vedio` | int | 100.0% | 0 ~ 4358; 0 / 4 / 19 |
| `data.asins[].vedioBest` | bool | 100.0% | False / True |
| `message` | null | 0.0% |  |

#### `traffic-change-detail`

某日 Listing 图片/标题/广告变更明细

- **可用性**：✅ CLI 实测可用（0.38s，359 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8", "day": "2026-09-19"}`
- **字段表样本**：120 条历史成功响应（日志共 197 条，2026-08-17 ~ 2026-09-20），打平 29 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.ad` | null | 0.0% |  |
| `data.campaign` | object? | 11.7% |  |
| `data.campaign.campaignNum` | int | 100.0% | =1; 1 |
| `data.campaign.info` | array | 100.0% | len 1~1 |
| `data.campaign.info[]` | object | 100.0% |  |
| `data.campaign.info[].campaignShowId` | str | 100.0% | A042858316C2351W8OGDA / A06482021WFMG986QOEK1 / A03714302WVYJ6MQ4YIEJ |
| `data.campaign.info[].fakeCampaignId` | str | 100.0% | OGDA / OEK1 / YIEJ |
| `data.campaign.info[].variants` | array | 100.0% | len 1~5 |
| `data.campaign.info[].variants[]` | str | 100.0% | B08517ZFQ6 / B0892LMK9K / B0D6GFLP4P |
| `data.campaign.variantNum` | int | 100.0% | 1 ~ 5; 1 / 3 / 5 |
| `data.img` | object? | 1.7% |  |
| `data.img.before` | array | 100.0% | len 1~1 |
| `data.img.before[]` | str | 100.0% | https://m.media-amazon.com/images/I/81U3rh5TEZL.jpg / https://m.media-amazon.com/images/I/81AsFzZ4ReL.jpg |
| `data.img.fresh` | array | 100.0% | len 1~1 |
| `data.img.fresh[]` | str | 100.0% | https://m.media-amazon.com/images/I/81AsFzZ4ReL.jpg / https://m.media-amazon.com/images/I/81U3rh5TEZL.jpg |
| `data.lastChangeTime` | str? | 96.7% | 2026-08-17 / 2026-09-12 / 2026-09-13 |
| `data.nextChangeTime` | str? | 80.0% | 2026-09-13 / 2026-04-24 / 2026-03-12 |
| `data.title` | object? | 23.3% |  |
| `data.title.before` | str | 100.0% | Kacctyen 5 Pcs Thanksgiving Gift Basket for Women Pumpkin Bi… / HunnmingRe 2 Pcs Wreath Sash for Front Door, White Satin Nut… / HunnmingRe 2 Pcs Wreath Sash for Front Door Xmas Satin Sash … |
| `data.title.del` | array | 100.0% | len 0~23 |
| `data.title.del[]` | array | 100.0% | len 2~2 |
| `data.title.del[][]` | int | 100.0% | 0 ~ 201; 75 / 195 / 24 |
| `data.title.fresh` | str | 100.0% | Kacctyen 5 Pcs Thanksgiving Gift Basket for Women Pumpkin Bi… / HunnmingRe 2 Pcs Christmas Wreath Sashes Nutcracker Satin Nu… / HunnmingRe 2 Pcs Wreath Sash for Front Door, White Satin Nut… |
| `data.title.inc` | array | 100.0% | len 0~23 |
| `data.title.inc[]` | array | 100.0% | len 2~2 |
| `data.title.inc[][]` | int | 100.0% | 0 ~ 201; 17 / 27 / 34 |
| `message` | null | 0.0% |  |

#### `traffic-trend`

时光机：自然流 vs 广告流随时间变化

- **可用性**：✅ CLI 实测可用（0.59s，196,609 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8"}`
- **字段表样本**：120 条历史成功响应（日志共 2517 条，2026-08-06 ~ 2026-09-20），打平 158 个字段
- **⚠️ 动态 key**：以下路径是「以业务值为 key 的 map」，不是数组，ETL 要先 `jsonb_each` 展开：
    - `data.subBsr` 的 key 是 {keyword}

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.adId` | array | 100.0% | len 0~0 |
| `data.adScore` | array | 100.0% | len 0~1357 |
| `data.adScore[]` | object? | 28.2% |  |
| `data.adScore[].contriChangeRatio` | null | 0.0% |  |
| `data.adScore[].score` | float? | 87.9% | 0.003042257116133711 ~ 8091.3472077650995; 0.5014556531089256 / 0.6793066495937075 / 0.934331474767896 |
| `data.adScore[].scoreChange` | float? | 100.0% | -6984.59441728606 ~ 5874.223903387218; 0.5014556531089256 / 0.17785099648478186 / 0.25502482517418856 |
| `data.adScore[].scoreChangeRatio` | float? | 87.6% | -1.0 ~ 25653.29771625; 0.35466944 / 0.3754193 / 0.72098355 |
| `data.adScore[].scoreRatio` | float? | 87.9% | 4.46e-06 ~ 1.0; 1.0 / 0.43227963 / 0.16964373 |
| `data.asin` | str? | 95.0% | B0FG21XH4S / B0CFXG4TXR / B0CG33ZG8V |
| `data.boughtInPastMonth` | array | 100.0% | len 0~1357 |
| `data.boughtInPastMonth[]` | int? | 60.6% | 0 ~ 1000; 0 / 600 / 200 |
| `data.bsr` | array | 100.0% | len 0~1357 |
| `data.bsr[]` | int? | 87.8% | 395 ~ 16536797; 58607 / 47284 / 51767 |
| `data.buyboxPrice` | array | 100.0% | len 0~1357 |
| `data.buyboxPrice[]` | float? | 79.0% | 3.0 ~ 139.99; 129.99 / 125.99 / 126.99 |
| `data.buyboxSeller` | array | 100.0% | len 0~1357 |
| `data.buyboxSeller[]` | str? | 79.2% | Waeeshy## / OVOOTOK Store## / MORDUN## |
| `data.campaignId` | array | 100.0% | len 0~1357 |
| `data.campaignId[]` | int? | 1.1% | 1 ~ 3; 1 / 2 / 3 |
| `data.catId` | str? | 92.5% | 228013 / 1055398 / 7141123011 |
| `data.catName` | str? | 92.5% | Tools & Home Improvement / Home & Kitchen / Clothing, Shoes & Jewelry |
| `data.couponInfo` | array | 100.0% | len 0~1357 |
| `data.couponInfo[]` | str? | 0.9% | 6.0_0_20%_23.99 / 4.5_0_15%_25.49 / 3.6_0_12%_26.39 |
| `data.dates` | array? | 95.0% | len 1~1357 |
| `data.dates[]` | str | 100.0% | 2023-09-27 / 2023-09-28 / 2023-09-29 |
| `data.dealPrice` | array | 100.0% | len 0~1357 |
| `data.dealPrice[]` | float? | 79.0% | 3.0 ~ 139.99; 129.99 / 125.99 / 126.99 |
| `data.exposurePermit` | bool | 100.0% | True |
| `data.invite` | bool | 100.0% | True |
| `data.keepaMinDate` | str? | 95.0% | 2025-07-28 / 2023-09-16 / 2023-08-23 |
| `data.ldPrice` | array | 100.0% | len 0~1357 |
| `data.ldPrice[]` | str? | 0.0% | 6.79_0_当天19:19-第二天07:19 / 6.79_0_前一天19:19-当天07:19 / 6.39_0_当天17:19-第二天05:19 |
| `data.nfScore` | array | 100.0% | len 0~1357 |
| `data.nfScore[]` | object? | 61.1% |  |
| `data.nfScore[].contriChangeRatio` | null | 0.0% |  |
| `data.nfScore[].score` | float? | 95.2% | 0.2199309762266431 ~ 60576.587774935106; 1.227073819001132 / 7.122924594574644 / 28.286918246502008 |
| `data.nfScore[].scoreChange` | float? | 99.9% | -31386.303054063857 ~ 21537.029956244485; 1.227073819001132 / -1.227073819001132 / 7.122924594574644 |
| `data.nfScore[].scoreChangeRatio` | float? | 94.8% | -1.0 ~ 383.73703083; -1.0 / -0.57952668 / -0.24172621 |
| `data.nfScore[].scoreRatio` | float? | 95.2% | 0.00039179 ~ 1.0; 0.56772037 / 0.83035627 / 0.77822665 |
| `data.nonNullMinIndex` | int | 100.0% | -1 ~ 0; 0 / -1 |
| `data.pasin` | bool | 100.0% | False |
| `data.primePrice` | array | 100.0% | len 0~1357 |
| `data.primePrice[]` | float? | 1.4% | 4.79 ~ 66.49; 23.99 / 28.79 / 25.59 |
| … 另有 113 个字段 | | | 见 `_schemas.json` |

### compete —— 竞品/曝光

#### `asin-bs-exposure`

一组 ASIN 的畅销/曝光数据

- **可用性**：✅ CLI 实测可用（0.38s，3,016 B）
- **本次实调入参**：`{"asins": ["B0FVNPKGJ8"]}`
- **字段表样本**：66 条历史成功响应（日志共 73 条，2026-08-12 ~ 2026-09-20），打平 26 个字段
- **⚠️ 动态 key**：以下路径是「以业务值为 key 的 map」，不是数组，ETL 要先 `jsonb_each` 展开：
    - `data` 的 key 是 {asin}

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` 🔑 | object | 100.0% |  |
| `data.{asin}` | object | 100.0% |  |
| `data.{asin}.acKeywordNum` | int | 100.0% | 0 ~ 399; 0 / 21 / 3 |
| `data.{asin}.adKeywordNum` | int | 100.0% | 0 ~ 4398; 24 / 0 / 136 |
| `data.{asin}.asin` | str | 100.0% | B0FVNPKGJ8 / B0H361D35D / B0FKHB7PMQ |
| `data.{asin}.bestAsin` | str? | 13.6% | B0FDKBBN3K / B0B5WH79QH / B0BCWP28GC |
| `data.{asin}.bestAsinBought` | str? | 13.6% | 200+ / 300+ / 400+ |
| `data.{asin}.bestAsinFeature` | array? | 13.6% | len 1~3 |
| `data.{asin}.bestAsinFeature[]` | str | 100.0% | Petite / Medium / Espresso Brown |
| `data.{asin}.boughtHistory` | array | 100.0% | len 39~40 |
| `data.{asin}.boughtHistoryDates` | array | 100.0% | len 39~40 |
| `data.{asin}.boughtHistoryDates[]` | str | 100.0% | 2023-05 / 2023-06 / 2023-07 |
| `data.{asin}.boughtHistory[]` | int? | 50.8% | 0 ~ 100000; 0 / 100 / 50 |
| `data.{asin}.boughtInPastMonth` | str | 100.0% | <50 / 100+ / 200+ |
| `data.{asin}.isChanged` | bool | 100.0% | False |
| `data.{asin}.isFocus` | bool | 100.0% | False |
| `data.{asin}.naturalKeywordNum` | int | 100.0% | 0 ~ 2512; 0 / 4 / 55 |
| `data.{asin}.pasinBoughtHistory` | array | 100.0% | len 39~40 |
| `data.{asin}.pasinBoughtHistory[]` | int? | 50.8% | 0 ~ 100000; 0 / 100 / 50 |
| `data.{asin}.pasinBoughtInPastMonth` | null | 0.0% |  |
| `data.{asin}.ppcAdKeywordNum` | int | 100.0% | =0; 0 |
| `data.{asin}.recAdKeywordNum` | int | 100.0% | 0 ~ 836; 21 / 0 / 76 |
| `data.{asin}.searchRecommendKeywordNum` | int | 100.0% | =0; 0 |
| `data.{asin}.totalKeywordNum` | int | 100.0% | 0 ~ 4999; 24 / 0 / 4 |
| `message` | null | 0.0% |  |

### monitor —— 坑位监控

#### `monitor-keyword-query`

坑位监控快照（只读）

- **可用性**：⚠️ CLI 实测通但返回空（1.54s，262 B）｜所有字段均空（list,campaignRemark）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8", "keywords": ["pink sweatsuit"]}`
- **字段表样本**：4 条历史成功响应（日志共 10 条，2026-09-04 ~ 2026-09-20），打平 5 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.campaignRemark` | null | 0.0% |  |
| `data.list` | array | 100.0% | len 0~0 |
| `message` | null | 0.0% |  |

### webapp —— 网页版接口

#### `web-asin-core-keywords`

核心流量词 + 建议词

- **可用性**：✅ CLI 实测可用（0.38s，27,523 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8", "timePieceType": "latelyDay", "timePieceValue": "7"}`
- **字段表样本**：120 条历史成功响应（日志共 550 条，2026-08-11 ~ 2026-09-20），打平 65 个字段
- **⚠️ 动态 key**：以下路径是「以业务值为 key 的 map」，不是数组，ETL 要先 `jsonb_each` 展开：
    - `data.suggestList[].allRankHistory.recRanks[]` 的 key 是 {keyword}

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.campaignRemark` | object? | 51.7% |  |
| `data.date` | str? | 96.7% | 2026-09-18 / 2026-09-16 / 2026-09-15 |
| `data.list` | array? | 80.8% | len 0~0 |
| `data.pasin` | bool | 100.0% | False / True |
| `data.suggestList` | array? | 80.8% | len 1~25 |
| `data.suggestList[]` | object | 100.0% |  |
| `data.suggestList[].allRankHistory` | object | 100.0% |  |
| `data.suggestList[].allRankHistory.date` | array | 100.0% | len 7~7 |
| `data.suggestList[].allRankHistory.date[]` | str | 100.0% | 2026-09-12 / 2026-09-13 / 2026-09-14 |
| `data.suggestList[].allRankHistory.nfRank` | array | 100.0% | len 7~7 |
| `data.suggestList[].allRankHistory.nfRank[]` | object? | 35.9% |  |
| `data.suggestList[].allRankHistory.nfRank[].asin` | str | 100.0% | B0CG6C9Y35 / B0D7W242KX / B0HB4P4VWJ |
| `data.suggestList[].allRankHistory.nfRank[].asinOrder` | null | 0.0% |  |
| `data.suggestList[].allRankHistory.nfRank[].campaignId` | null | 0.0% |  |
| `data.suggestList[].allRankHistory.nfRank[].maskCampaignId` | null | 0.0% |  |
| `data.suggestList[].allRankHistory.nfRank[].rank` | int | 100.0% | 1 ~ 144; 26 / 36 / 37 |
| `data.suggestList[].allRankHistory.nfRank[].rankStr` | str | 100.0% | p1,26/48 / p1,36/48 / p1,37/48 |
| `data.suggestList[].allRankHistory.nfRank[].rankTime` | null | 0.0% |  |
| `data.suggestList[].allRankHistory.recRanks` | array | 100.0% | len 7~7 |
| `data.suggestList[].allRankHistory.recRanks[]` 🔑 | object? | 5.1% |  |
| `data.suggestList[].allRankHistory.recRanks[].{keyword}` | object | 100.0% |  |
| `data.suggestList[].allRankHistory.recRanks[].{keyword}.campaignId` | str | 100.0% | A10227511TMI75I8C0WVY / A00772773TZ8B1ANTTDCI / A01340271TDRC2FZ40KZD |
| `data.suggestList[].allRankHistory.recRanks[].{keyword}.maskCampaignId` | str | 100.0% | 0WVY / TDCI / 0KZD |
| `data.suggestList[].allRankHistory.sbRank` | array | 100.0% | len 7~7 |
| `data.suggestList[].allRankHistory.sbRank[]` | object? | 1.3% |  |
| `data.suggestList[].allRankHistory.sbRank[].asin` | null | 0.0% |  |
| `data.suggestList[].allRankHistory.sbRank[].asinOrder` | int | 100.0% | 1 ~ 3; 1 / 3 |
| `data.suggestList[].allRankHistory.sbRank[].campaignId` | str | 100.0% | 200074029675171 / 200099385605171 / 200080791598771 |
| `data.suggestList[].allRankHistory.sbRank[].maskCampaignId` | str | 100.0% | EMB5 / JESC / UE2Z |
| `data.suggestList[].allRankHistory.sbRank[].rank` | float | 100.0% | 1.1 ~ 3.5; 1.5 / 3.5 / 1.1 |
| `data.suggestList[].allRankHistory.sbRank[].rankStr` | str | 100.0% | sb,1,middle / sb,3,middle / sb,1,top |
| `data.suggestList[].allRankHistory.sbRank[].rankTime` | null | 0.0% |  |
| `data.suggestList[].allRankHistory.sbvRank` | array | 100.0% | len 7~7 |
| `data.suggestList[].allRankHistory.sbvRank[]` | object? | 0.7% |  |
| `data.suggestList[].allRankHistory.sbvRank[].asin` | null | 0.0% |  |
| `data.suggestList[].allRankHistory.sbvRank[].asinOrder` | int | 100.0% | 1 ~ 3; 1 / 3 |
| `data.suggestList[].allRankHistory.sbvRank[].campaignId` | str | 100.0% | 200094822589471 / 300018998327706 / 200107194634971 |
| `data.suggestList[].allRankHistory.sbvRank[].maskCampaignId` | str | 100.0% | 9471 / DZHX / 4971 |
| `data.suggestList[].allRankHistory.sbvRank[].rank` | float | 100.0% | 1.1 ~ 3.8; 3.5 / 1.5 / 1.8 |
| `data.suggestList[].allRankHistory.sbvRank[].rankStr` | str | 100.0% | sbv,3,middle / sbv,1,middle / sbv,1,bottom |
| `data.suggestList[].allRankHistory.sbvRank[].rankTime` | null | 0.0% |  |
| `data.suggestList[].allRankHistory.spRank` | array | 100.0% | len 7~7 |
| `data.suggestList[].allRankHistory.spRank[]` | object? | 6.9% |  |
| … 另有 20 个字段 | | | 见 `_schemas.json` |

#### `web-asin-day-trend`

日粒度 ASIN 数/关键词数/评分趋势

- **可用性**：✅ CLI 实测可用（0.55s，47,906 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8"}`
- **字段表样本**：27 条历史成功响应（日志共 27 条，2026-08-12 ~ 2026-09-20），打平 44 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.asinCntList` | array? | 70.4% | len 5~51 |
| `data.asinCntList[]` | object | 100.0% |  |
| `data.asinCntList[].change` | int | 100.0% | -15 ~ 30; 5 / 3 / -4 |
| `data.asinCntList[].changeRatio` | float? | 71.4% | -1.0 ~ 1.66666667; 1.66666667 / 0.625 / 0.23076923 |
| `data.asinCntList[].decCnt` | int | 100.0% | 0 ~ 29; 2 / 6 / 7 |
| `data.asinCntList[].incCnt` | int | 100.0% | 0 ~ 42; 7 / 11 / 10 |
| `data.asinCntList[].prev` | int | 100.0% | 0 ~ 76; 3 / 8 / 13 |
| `data.asinCntList[].value` | int | 100.0% | 0 ~ 76; 8 / 13 / 16 |
| `data.dates` | array? | 70.4% | len 5~51 |
| `data.dates[]` | str | 100.0% | 2026-08-01 / 2026-08-02 / 2026-08-03 |
| `data.extraScoreList` | array? | 70.4% | len 5~51 |
| `data.extraScoreList[]` | object | 100.0% |  |
| `data.extraScoreList[].change` | float | 100.0% | -16273.33999999999 ~ 11930.490000000005; -0.269999999999996 / -14.729999999999997 / 12.999999999999993 |
| `data.extraScoreList[].changeRatio` | float? | 61.8% | -1.0 ~ 28.45; -0.00345976 / -0.18940465 / 0.20621827 |
| `data.extraScoreList[].prev` | float | 100.0% | 0.0 ~ 53246.51999999997; 78.03999999999999 / 77.77 / 63.04 |
| `data.extraScoreList[].ratio` | float? | 96.5% | 0.0 ~ 0.36009455; 0.23542411 / 0.22607136 / 0.15962047 |
| `data.extraScoreList[].value` | float | 100.0% | 0.0 ~ 53246.51999999997; 77.77 / 63.04 / 76.03999999999999 |
| `data.keywordCntList` | array? | 70.4% | len 5~51 |
| `data.keywordCntList[]` | object | 100.0% |  |
| `data.keywordCntList[].change` | int | 100.0% | -83 ~ 89; 3 / 2 / -2 |
| `data.keywordCntList[].changeRatio` | float? | 71.4% | -1.0 ~ 7.0; 3.0 / 0.5 / 0.33333333 |
| `data.keywordCntList[].decCnt` | int | 100.0% | 0 ~ 57; 0 / 1 / 3 |
| `data.keywordCntList[].incCnt` | int | 100.0% | 0 ~ 60; 2 / 4 / 3 |
| `data.keywordCntList[].prev` | int | 100.0% | 0 ~ 411; 1 / 4 / 6 |
| `data.keywordCntList[].value` | int | 100.0% | 0 ~ 411; 4 / 6 / 9 |
| `data.listingAsinCnt` | int | 100.0% | 0 ~ 388; 388 / 3 / 5 |
| `data.listingUpdateTime` | int? | 70.4% | 1786528080000 ~ 1789860600000; 1789860600000 / 1789643361502 / 1789613820000 |
| `data.scoreList` | array? | 70.4% | len 5~51 |
| `data.scoreList[]` | object | 100.0% |  |
| `data.scoreList[].change` | float | 100.0% | -16269.889999999985 ~ 21270.469999999987; 30.65999999999994 / -36.75999999999999 / 184.53 |
| `data.scoreList[].changeRatio` | float? | 96.1% | -1.0 ~ 8.89121813; 0.13816412 / -0.14554381 / 0.85505769 |
| `data.scoreList[].prev` | float | 100.0% | 0.0 ~ 105409.49000000003; 221.91000000000003 / 252.56999999999996 / 215.80999999999997 |
| `data.scoreList[].ratio` | float? | 96.5% | 0.63990545 ~ 1.0; 0.76457589 / 0.77392864 / 0.84037953 |
| `data.scoreList[].value` | float | 100.0% | 0.0 ~ 105409.49000000003; 252.56999999999996 / 215.80999999999997 / 400.34 |
| `data.totalScoreList` | array? | 70.4% | len 5~51 |
| `data.totalScoreList[]` | object | 100.0% |  |
| `data.totalScoreList[].change` | float | 100.0% | -29088.04999999999 ~ 21347.740000000005; 30.38999999999993 / -51.49000000000001 / 197.53000000000003 |
| `data.totalScoreList[].changeRatio` | float? | 96.1% | -1.0 ~ 8.89121813; 0.10131689 / -0.15586971 / 0.70837368 |
| `data.totalScoreList[].prev` | float | 100.0% | 0.0 ~ 156723.12; 299.95000000000005 / 330.34 / 278.84999999999997 |
| `data.totalScoreList[].ratio` | float? | 96.5% | =1.0; 1.0 |
| `data.totalScoreList[].value` | float | 100.0% | 0.0 ~ 156723.12; 330.34 / 278.84999999999997 / 476.38 |
| `message` | null | 0.0% |  |

#### `web-asin-detail`

ASIN 详情：标题/价格/评分

- **可用性**：✅ CLI 实测可用（0.45s，893 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8"}`
- **字段表样本**：120 条历史成功响应（日志共 163 条，2026-08-10 ~ 2026-09-20），打平 24 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.info` | object? | 85.8% |  |
| `data.info.asin` | str | 100.0% | B0H8D8RW8K / B0FVNPKGJ8 / B0H2J3LMQB |
| `data.info.bestSellers` | null | 0.0% |  |
| `data.info.bestSellersTime` | null | 0.0% |  |
| `data.info.boughtInPastWeek` | null | 0.0% |  |
| `data.info.brand` | null | 0.0% |  |
| `data.info.brandLink` | null | 0.0% |  |
| `data.info.buyBox` | null | 0.0% |  |
| `data.info.buyBoxLink` | null | 0.0% |  |
| `data.info.category` | null | 0.0% |  |
| `data.info.img` | str | 100.0% | https://m.media-amazon.com/images/I/813bVMenZZL._AC_UL320_.j… / https://m.media-amazon.com/images/I/61gom4zyZBL._AC_UL320_.j… / https://m.media-amazon.com/images/I/71H2aRTAwGL._AC_UL320_.j… |
| `data.info.isBestSeller` | null | 0.0% |  |
| `data.info.isCoupon` | null | 0.0% |  |
| `data.info.isFocus` | bool | 100.0% | False |
| `data.info.isLimitedTimeDeal` | null | 0.0% |  |
| `data.info.isLowest30` | null | 0.0% |  |
| `data.info.price` | float | 100.0% | 4.99 ~ 189.99; 89.99 / 39.94 / 13.99 |
| `data.info.ratingNum` | int? | 91.3% | 2 ~ 91557; 146 / 26 / 7 |
| `data.info.score` | float? | 91.3% | 2.6 ~ 5.0; 4.2 / 4.7 / 4.6 |
| `data.info.star` | float? | 91.3% | 2.5 ~ 5.0; 4.0 / 4.5 / 3.0 |
| `data.info.title` | str | 100.0% | Yalikop Natural Cane Webbing Roll, 24in x 10ft, 3-Pack for C… / 2 Piece Sets for Women 1/2 Zip Sweatsuit 2026 Matching Outfi… / Boo Basket Stuffers for Women, Spooky Stuffed Animals Set |
| `message` | null | 0.0% |  |

#### `web-asin-flow-overview`

流量结构总览。已失效（2026-09-08 后全 404）

- **可用性**：❌ CLI 实测失效（HTTP 404）（3.81s，154 B）｜HTTP 404
- **本次实调入参**：`{"asin": "B0FVNPKGJ8", "timePieceType": "latelyDay", "timePieceValue": "30"}`
- **字段表样本**：88 条历史成功响应（日志共 241 条，2026-08-11 ~ 2026-09-20），打平 42 个字段
- **⚠️ 动态 key**：以下路径是「以业务值为 key 的 map」，不是数组，ETL 要先 `jsonb_each` 展开：
    - `data.recommend` 的 key 是 {keyword}

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.ad` | object | 100.0% |  |
| `data.ad.recommend` | object | 100.0% |  |
| `data.ad.recommend.name` | str | 100.0% | SP(推荐) |
| `data.ad.recommend.ratio` | float | 100.0% | 0.00180959 ~ 1.0; 0.02219353 / 1.0 / 0.03077643 |
| `data.ad.recommend.score` | float | 100.0% | 0.23596013 ~ 61892.98582527; 3.17273252 / 0.23596013 / 803.65188415 |
| `data.ad.recommend.wholeName` | str | 100.0% | Sponsored Recommend |
| `data.ad.sb` | object | 100.0% |  |
| `data.ad.sb.name` | str | 100.0% | SB(常规) |
| `data.ad.sb.ratio` | float | 100.0% | 0.00483385 ~ 0.9930501; 0.47467723 / 0.35058907 / 0.8226188 |
| `data.ad.sb.score` | float | 100.0% | 34.69430972 ~ 184427.02970439; 12395.04524524 / 17623.10370636 / 117125.54888335 |
| `data.ad.sb.wholeName` | str | 100.0% | Sponsored Brand |
| `data.ad.sbv` | object | 100.0% |  |
| `data.ad.sbv.name` | str | 100.0% | SBV |
| `data.ad.sbv.ratio` | float | 100.0% | 0.00018624 ~ 1.0; 0.1806803 / 0.00627896 / 0.60562426 |
| `data.ad.sbv.score` | float | 100.0% | 0.45457733 ~ 217088.60455052; 489.36189139 / 0.89762505 / 9.61213461 |
| `data.ad.sbv.wholeName` | str | 100.0% | Sponsored Brand Video |
| `data.ad.sp` | object | 100.0% |  |
| `data.ad.sp.name` | str | 100.0% | SP(常规) |
| `data.ad.sp.ratio` | float | 100.0% | 0.00289669 ~ 1.0; 0.8193197 / 0.9715275 / 1.0 |
| `data.ad.sp.score` | float | 100.0% | 0.5902712 ~ 295638.62162912; 2219.07887182 / 138.88717273 / 0.85621329 |
| `data.ad.sp.wholeName` | str | 100.0% | Sponsored Product |
| `data.overview` | object | 100.0% |  |
| `data.overview.ad` | object | 100.0% |  |
| `data.overview.ad.name` | str | 100.0% | 广告流量 |
| `data.overview.ad.ratio` | float | 100.0% | 0.00079246 ~ 1.0; 0.14275184 / 0.16842916 / 0.00079246 |
| `data.overview.ad.score` | float | 100.0% | 0.23596013 ~ 712021.52602015; 2708.44076321 / 142.9575303 / 0.23596013 |
| `data.overview.ad.wholeName` | str | 100.0% | - |
| `data.overview.nf` | object | 100.0% |  |
| `data.overview.nf.name` | str | 100.0% | 自然流量 |
| `data.overview.nf.ratio` | float | 100.0% | 0.00112794 ~ 1.0; 0.85724816 / 0.83157084 / 1.0 |
| `data.overview.nf.score` | float | 100.0% | 0.63302748 ~ 6306191.55775483; 16264.62970495 / 705.81196702 / 9.52245848 |
| `data.overview.nf.wholeName` | str | 100.0% | - |
| `data.recommend` 🔑 | object | 100.0% |  |
| `data.recommend.{keyword}` | object | 100.0% |  |
| `data.recommend.{keyword}.name` | str | 100.0% | New arrivals / Seen on social media / Trending now |
| `data.recommend.{keyword}.ratio` | float | 100.0% | 4.158e-05 ~ 1.0; 1.0 / 0.03709337 / 0.00135817 |
| `data.recommend.{keyword}.score` | float | 100.0% | 0.10928907 ~ 50374.42294256; 3.17273252 / 0.23596013 / 29.81015634 |
| `data.recommend.{keyword}.wholeName` | str | 100.0% | New arrivals / Seen on social media / Trending now |
| `data.total` | float? | 92.0% | 0.0 ~ 7018213.083774985; 18973.07046816542 / 848.7694973242092 / 9.522458477592945 |
| `message` | null | 0.0% |  |

#### `web-asin-head-keywords`

头部流量词 + 建议词

- **可用性**：✅ CLI 实测可用（0.46s，336 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8", "timePieceType": "latelyDay", "timePieceValue": "7"}`
- **字段表样本**：120 条历史成功响应（日志共 510 条，2026-08-12 ~ 2026-09-20），打平 65 个字段
- **⚠️ 动态 key**：以下路径是「以业务值为 key 的 map」，不是数组，ETL 要先 `jsonb_each` 展开：
    - `data.suggestList[].allRankHistory.recRanks[]` 的 key 是 {keyword}

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.campaignRemark` | object? | 17.5% |  |
| `data.date` | str? | 96.7% | 2026-09-18 / 2026-09-16 / 2026-09-15 |
| `data.list` | array? | 17.5% | len 0~0 |
| `data.pasin` | bool | 100.0% | False / True |
| `data.suggestList` | array? | 17.5% | len 1~10 |
| `data.suggestList[]` | object | 100.0% |  |
| `data.suggestList[].allRankHistory` | object | 100.0% |  |
| `data.suggestList[].allRankHistory.date` | array | 100.0% | len 7~7 |
| `data.suggestList[].allRankHistory.date[]` | str | 100.0% | 2026-09-10 / 2026-09-11 / 2026-09-12 |
| `data.suggestList[].allRankHistory.nfRank` | array | 100.0% | len 7~7 |
| `data.suggestList[].allRankHistory.nfRank[]` | object? | 64.2% |  |
| `data.suggestList[].allRankHistory.nfRank[].asin` | str | 100.0% | B0H7J73YYX / B0GXVG4TBJ / B0F8B9H4DB |
| `data.suggestList[].allRankHistory.nfRank[].asinOrder` | null | 0.0% |  |
| `data.suggestList[].allRankHistory.nfRank[].campaignId` | null | 0.0% |  |
| `data.suggestList[].allRankHistory.nfRank[].maskCampaignId` | null | 0.0% |  |
| `data.suggestList[].allRankHistory.nfRank[].rank` | int | 100.0% | 1 ~ 140; 11 / 13 / 26 |
| `data.suggestList[].allRankHistory.nfRank[].rankStr` | str | 100.0% | p1,11/48 / p1,13/48 / p1,26/48 |
| `data.suggestList[].allRankHistory.nfRank[].rankTime` | null | 0.0% |  |
| `data.suggestList[].allRankHistory.recRanks` | array | 100.0% | len 7~7 |
| `data.suggestList[].allRankHistory.recRanks[]` 🔑 | object? | 53.3% |  |
| `data.suggestList[].allRankHistory.recRanks[].{keyword}` | object | 100.0% |  |
| `data.suggestList[].allRankHistory.recRanks[].{keyword}.campaignId` | str | 100.0% | A06374852OIIHNFR5DM23 / A038561122TO3965QCCFY / A055849726JYMWE1QA6NZ |
| `data.suggestList[].allRankHistory.recRanks[].{keyword}.maskCampaignId` | str | 100.0% | DM23 / CCFY / A6NZ |
| `data.suggestList[].allRankHistory.sbRank` | array | 100.0% | len 7~7 |
| `data.suggestList[].allRankHistory.sbRank[]` | object? | 6.2% |  |
| `data.suggestList[].allRankHistory.sbRank[].asin` | null | 0.0% |  |
| `data.suggestList[].allRankHistory.sbRank[].asinOrder` | int | 100.0% | =1; 1 |
| `data.suggestList[].allRankHistory.sbRank[].campaignId` | str | 100.0% | 200074029675171 / 300091870033706 / 200099385605171 |
| `data.suggestList[].allRankHistory.sbRank[].maskCampaignId` | str | 100.0% | EMB5 / DPEC / JESC |
| `data.suggestList[].allRankHistory.sbRank[].rank` | float | 100.0% | 1.1 ~ 3.5; 1.5 / 2.5 / 3.5 |
| `data.suggestList[].allRankHistory.sbRank[].rankStr` | str | 100.0% | sb,1,middle / sb,2,middle / sb,3,middle |
| `data.suggestList[].allRankHistory.sbRank[].rankTime` | null | 0.0% |  |
| `data.suggestList[].allRankHistory.sbvRank` | array | 100.0% | len 7~7 |
| `data.suggestList[].allRankHistory.sbvRank[]` | object? | 2.3% |  |
| `data.suggestList[].allRankHistory.sbvRank[].asin` | null | 0.0% |  |
| `data.suggestList[].allRankHistory.sbvRank[].asinOrder` | int | 100.0% | =1; 1 |
| `data.suggestList[].allRankHistory.sbvRank[].campaignId` | str | 100.0% | 200116913675271 / 300056251014406 / 300018998327706 |
| `data.suggestList[].allRankHistory.sbvRank[].maskCampaignId` | str | 100.0% | 5271 / ODC1 / DZHX |
| `data.suggestList[].allRankHistory.sbvRank[].rank` | float | 100.0% | 1.5 ~ 3.8; 1.5 / 2.5 / 3.5 |
| `data.suggestList[].allRankHistory.sbvRank[].rankStr` | str | 100.0% | sbv,1,middle / sbv,2,middle / sbv,3,middle |
| `data.suggestList[].allRankHistory.sbvRank[].rankTime` | null | 0.0% |  |
| `data.suggestList[].allRankHistory.spRank` | array | 100.0% | len 7~7 |
| `data.suggestList[].allRankHistory.spRank[]` | object? | 56.5% |  |
| … 另有 20 个字段 | | | 见 `_schemas.json` |

#### `web-asin-keyword-overview`

分周期关键词概览：9 渠道 total/prev/in/out

- **可用性**：✅ CLI 实测可用（0.43s，1,229 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8", "timePieceType": "latelyDay", "timePieceValue": "7"}`
- **字段表样本**：120 条历史成功响应（日志共 568 条，2026-08-11 ~ 2026-09-20），打平 50 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object? | 98.3% |  |
| `data.adKeywordCnt` | object | 100.0% |  |
| `data.adKeywordCnt.in` | int | 100.0% | 0 ~ 723; 20 / 33 / 0 |
| `data.adKeywordCnt.out` | int | 100.0% | 0 ~ 392; 4 / 96 / 1 |
| `data.adKeywordCnt.prev` | int | 100.0% | 0 ~ 539; 8 / 121 / 1 |
| `data.adKeywordCnt.total` | int | 100.0% | 0 ~ 974; 24 / 58 / 0 |
| `data.allSbKeywordCnt` | object | 100.0% |  |
| `data.allSbKeywordCnt.in` | int | 100.0% | 0 ~ 737; 0 / 4 / 2 |
| `data.allSbKeywordCnt.out` | int | 100.0% | 0 ~ 266; 0 / 18 / 1 |
| `data.allSbKeywordCnt.prev` | int | 100.0% | 0 ~ 533; 0 / 18 / 1 |
| `data.allSbKeywordCnt.total` | int | 100.0% | 0 ~ 919; 0 / 4 / 2 |
| `data.allSpKeywordCnt` | object | 100.0% |  |
| `data.allSpKeywordCnt.in` | int | 100.0% | 0 ~ 513; 20 / 33 / 0 |
| `data.allSpKeywordCnt.out` | int | 100.0% | 0 ~ 393; 4 / 83 / 0 |
| `data.allSpKeywordCnt.prev` | int | 100.0% | 0 ~ 450; 8 / 108 / 0 |
| `data.allSpKeywordCnt.total` | int | 100.0% | 0 ~ 598; 24 / 58 / 0 |
| `data.historyTotal` | int | 100.0% | 0 ~ 7958; 182 / 865 / 46 |
| `data.nfKeywordCnt` | object | 100.0% |  |
| `data.nfKeywordCnt.in` | int | 100.0% | 0 ~ 273; 0 / 72 / 95 |
| `data.nfKeywordCnt.out` | int | 100.0% | 0 ~ 136; 0 / 32 / 7 |
| `data.nfKeywordCnt.prev` | int | 100.0% | 0 ~ 904; 0 / 107 / 7 |
| `data.nfKeywordCnt.total` | int | 100.0% | 0 ~ 1071; 0 / 147 / 131 |
| `data.pasin` | bool | 100.0% | False |
| `data.recSpKeywordCnt` | object | 100.0% |  |
| `data.recSpKeywordCnt.in` | int | 100.0% | 0 ~ 270; 19 / 33 / 0 |
| `data.recSpKeywordCnt.out` | int | 100.0% | 0 ~ 162; 4 / 70 / 0 |
| `data.recSpKeywordCnt.prev` | int | 100.0% | 0 ~ 208; 6 / 87 / 0 |
| `data.recSpKeywordCnt.total` | int | 100.0% | 0 ~ 368; 21 / 50 / 0 |
| `data.sbKeywordCnt` | object | 100.0% |  |
| `data.sbKeywordCnt.in` | int | 100.0% | 0 ~ 737; 0 / 243 / 8 |
| `data.sbKeywordCnt.out` | int | 100.0% | 0 ~ 251; 0 / 1 / 16 |
| `data.sbKeywordCnt.prev` | int | 100.0% | 0 ~ 521; 0 / 1 / 25 |
| `data.sbKeywordCnt.total` | int | 100.0% | 0 ~ 919; 0 / 243 / 17 |
| `data.sbvKeywordCnt` | object | 100.0% |  |
| `data.sbvKeywordCnt.in` | int | 100.0% | 0 ~ 158; 0 / 4 / 2 |
| `data.sbvKeywordCnt.out` | int | 100.0% | 0 ~ 88; 0 / 18 / 2 |
| `data.sbvKeywordCnt.prev` | int | 100.0% | 0 ~ 177; 0 / 18 / 2 |
| `data.sbvKeywordCnt.total` | int | 100.0% | 0 ~ 204; 0 / 4 / 2 |
| `data.spKeywordCnt` | object | 100.0% |  |
| `data.spKeywordCnt.in` | int | 100.0% | 0 ~ 439; 2 / 8 / 0 |
| `data.spKeywordCnt.out` | int | 100.0% | 0 ~ 282; 2 / 32 / 0 |
| `data.spKeywordCnt.prev` | int | 100.0% | 0 ~ 330; 3 / 40 / 0 |
| `data.spKeywordCnt.total` | int | 100.0% | 0 ~ 511; 3 / 16 / 0 |
| `data.totalPeriod` | object | 100.0% |  |
| … 另有 5 个字段 | | | 见 `_schemas.json` |

#### `web-asin-keyword-trend`

逐期 全部/自然/广告/SP 词数变化

- **可用性**：✅ CLI 实测可用（0.53s，62,852 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8", "granularity": "week"}`
- **字段表样本**：120 条历史成功响应（日志共 251 条，2026-08-12 ~ 2026-09-20），打平 70 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object? | 96.7% |  |
| `data.adKeywords` | array | 100.0% | len 2~976 |
| `data.adKeywords[]` | object | 100.0% |  |
| `data.adKeywords[].diffNum` | int? | 85.9% | -716 ~ 980; 2 / 4 / 9 |
| `data.adKeywords[].inNum` | int? | 85.9% | 0 ~ 980; 2 / 6 / 14 |
| `data.adKeywords[].isChanged` | bool? | 85.9% | True / False |
| `data.adKeywords[].keywordNum` | int? | 81.2% | 1 ~ 980; 2 / 6 / 15 |
| `data.adKeywords[].noChangeNum` | int? | 85.9% | 0 ~ 411; 0 / 1 / 2 |
| `data.adKeywords[].outNum` | int? | 85.9% | 0 ~ 766; 0 / 2 / 5 |
| `data.adKeywords[].value` | int? | 81.2% | 1 ~ 980; 2 / 6 / 15 |
| `data.allKeywords` | array | 100.0% | len 2~976 |
| `data.allKeywords[]` | object | 100.0% |  |
| `data.allKeywords[].diffNum` | int? | 97.9% | -734 ~ 985; 2 / 4 / 10 |
| `data.allKeywords[].inNum` | int? | 97.9% | 0 ~ 985; 2 / 6 / 15 |
| `data.allKeywords[].isChanged` | bool? | 97.9% | True / False |
| `data.allKeywords[].keywordNum` | int? | 97.1% | 1 ~ 2016; 2 / 6 / 16 |
| `data.allKeywords[].noChangeNum` | int? | 97.9% | 0 ~ 1425; 0 / 1 / 2 |
| `data.allKeywords[].outNum` | int? | 97.9% | 0 ~ 868; 0 / 2 / 5 |
| `data.allKeywords[].value` | int? | 97.1% | 1 ~ 2016; 2 / 6 / 16 |
| `data.asin` | str | 100.0% | B0FVNPKGJ8 / B0GZPSVY74 / B0H721J41C |
| `data.dates` | array | 100.0% | len 2~976 |
| `data.dates[]` | str | 100.0% | 2025-11-30 / 2025-12-07 / 2025-12-14 |
| `data.nfKeywords` | array | 100.0% | len 2~976 |
| `data.nfKeywords[]` | object | 100.0% |  |
| `data.nfKeywords[].diffNum` | int? | 97.1% | -661 ~ 651; 1 / -1 / 7 |
| `data.nfKeywords[].inNum` | int? | 97.1% | 0 ~ 820; 1 / 0 / 7 |
| `data.nfKeywords[].isChanged` | bool? | 97.1% | True / False |
| `data.nfKeywords[].keywordNum` | int? | 96.2% | 1 ~ 1807; 1 / 7 / 15 |
| `data.nfKeywords[].noChangeNum` | int? | 97.1% | 0 ~ 1278; 0 / 3 / 1 |
| `data.nfKeywords[].outNum` | int? | 97.1% | 0 ~ 864; 0 / 1 / 4 |
| `data.nfKeywords[].value` | int? | 96.2% | 1 ~ 1807; 1 / 7 / 15 |
| `data.pasin` | bool | 100.0% | False |
| `data.recSpKeywords` | array | 100.0% | len 2~976 |
| `data.recSpKeywords[]` | object | 100.0% |  |
| `data.recSpKeywords[].diffNum` | int? | 67.4% | -528 ~ 460; 1 / 3 / -4 |
| `data.recSpKeywords[].inNum` | int? | 67.4% | 0 ~ 540; 1 / 4 / 0 |
| `data.recSpKeywords[].isChanged` | bool? | 67.4% | True / False |
| `data.recSpKeywords[].keywordNum` | int? | 61.3% | 1 ~ 722; 1 / 4 / 2 |
| `data.recSpKeywords[].noChangeNum` | int? | 67.4% | 0 ~ 280; 0 / 1 / 4 |
| `data.recSpKeywords[].outNum` | int? | 67.4% | 0 ~ 579; 0 / 1 / 4 |
| `data.recSpKeywords[].value` | int? | 61.3% | 1 ~ 722; 1 / 4 / 2 |
| `data.sbKeywords` | array | 100.0% | len 2~976 |
| `data.sbKeywords[]` | object | 100.0% |  |
| `data.sbKeywords[].diffNum` | int? | 13.7% | -582 ~ 373; 1 / -1 / 54 |
| … 另有 25 个字段 | | | 见 `_schemas.json` |

#### `web-asin-traffic-detail`

某天流量变化归因明细

- **可用性**：✅ CLI 实测可用（0.46s，2,147 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8", "date": "2026-09-19", "listingSearch": false}`
- **字段表样本**：120 条历史成功响应（日志共 486 条，2026-09-07 ~ 2026-09-20），打平 48 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object? | 87.5% |  |
| `data.date` | str | 100.0% | 2026-09-19 / 2026-09-18 / 2026-09-16 |
| `data.mainChangeKeywords` | array | 100.0% | len 1~10 |
| `data.mainChangeKeywords[]` | object | 100.0% |  |
| `data.mainChangeKeywords[].changeReasons` | array | 100.0% | len 0~5 |
| `data.mainChangeKeywords[].changeReasons[]` | object | 100.0% |  |
| `data.mainChangeKeywords[].changeReasons[].asin` | str | 100.0% | B0FSY6M47D / B0FSD1TWD6 / B0FX377CH5 |
| `data.mainChangeKeywords[].changeReasons[].contriChange` | float | 100.0% | -372.85814371327865 ~ 44.074418410118014; -372.85814371327865 / -34.77781149439583 / -85.28381907037061 |
| `data.mainChangeKeywords[].changeReasons[].contriChangeRatio` | float | 100.0% | -1.0 ~ 1.0; -0.91468414 / -0.08531586 / -1.0 |
| `data.mainChangeKeywords[].changeReasons[].img` | str | 100.0% | https://m.media-amazon.com/images/I/81MSHACayEL._AC_UL320_.j… / https://m.media-amazon.com/images/I/81c+oeuEGAL._AC_UL320_.j… / https://m.media-amazon.com/images/I/81wMbB96vvL._AC_UL320_.j… |
| `data.mainChangeKeywords[].changeReasons[].positive` | int | 100.0% | -1 ~ 1; 1 / -1 |
| `data.mainChangeKeywords[].changeReasons[].reason` | str | 100.0% | SP(常规)位：- → 30 / SP(常规)位：- → 7 / 获得视频广告 |
| `data.mainChangeKeywords[].changeReasons[].recTitle` | str | 100.0% | From frequently shopped brands / Today's deals / Picks from Amazon Influencers |
| `data.mainChangeKeywords[].changeReasons[].type` | str | 100.0% | REC / DEFAULT / LISTING |
| `data.mainChangeKeywords[].contriChange` | float | 100.0% | -517.1957774953554 ~ 155.82209831955493; 8.79379158552037 / 5.568104765519286 / -0.06466297294205937 |
| `data.mainChangeKeywords[].contriChangeRatio` | float | 100.0% | -1.0 ~ 1.0; 0.60955571 / 0.38596207 / -0.00448222 |
| `data.mainChangeKeywords[].contriChangeTotal` | float | 100.0% | 0.018969070641255747 ~ 4103.913347295026; 14.426559323981717 / 4.700973041799069 / 14.293965048921828 |
| `data.mainChangeKeywords[].keyword` | str | 100.0% | pink jogging suit sets for women / pink set / zip front jogging suits for women |
| `data.mainChangeKeywords[].searchRank` | int? | 96.1% | 9034 ~ 2648761; 998712 / 96405 / 697288 |
| `data.mainChangeKeywords[].searchVolume` | int? | 96.1% | 126 ~ 25484; 343 / 3328 / 489 |
| `data.mainChangeKeywords[].searchVolumeChangeRatio` | null | 0.0% |  |
| `data.mainChangeScoreType` | object | 100.0% |  |
| `data.mainChangeScoreType.adScoreChangeRatio` | float? | 61.0% | -1.0 ~ 221.10386714; 221.10386714 / 5.94454342 / -0.32170315 |
| `data.mainChangeScoreType.nfScoreChangeRatio` | float? | 95.2% | -1.0 ~ 4.03101288; 0.04598147 / 0.0746981 / -0.1897373 |
| `data.mainChangeScoreType.recSpScoreChangeRatio` | float? | 39.0% | -1.0 ~ 134.99423573; 134.99423573 / 11.61226994 / -0.64558464 |
| `data.mainChangeScoreType.sbScoreChangeRatio` | float? | 11.4% | -1.0 ~ 5.15312912; -0.32170315 / 1.24932345 / -0.75427525 |
| `data.mainChangeScoreType.sbvScoreChangeRatio` | float? | 16.2% | -1.0 ~ 6.89025372; -0.48228097 / -0.65629173 / -0.87914685 |
| `data.mainChangeScoreType.scoreChangeRatio` | float? | 97.1% | -1.0 ~ 221.10386714; 221.10386714 / 0.04598147 / 0.27751084 |
| `data.mainChangeScoreType.spScoreChangeRatio` | float? | 44.8% | -1.0 ~ 96.9207407; 5.10119255 / -0.86092456 / 2.60130641 |
| `data.nfInKeywords` | array? | 86.7% | len 0~55 |
| `data.nfInKeywords[]` | object | 100.0% |  |
| `data.nfInKeywords[].keyword` | str | 100.0% | gold christmas decor / champagne bows for christmas tree / sexy vampire costume for women |
| `data.nfInKeywords[].nfLastRank` | int | 100.0% | 1 ~ 144; 70 / 76 / 116 |
| `data.nfInKeywords[].nfLastRankStr` | str | 100.0% | p2,22/48 / p2,28/48 / p3,20/48 |
| `data.nfInKeywords[].searchRank` | int? | 93.6% | 9034 ~ 2651371; 359596 / 134067 / 230436 |
| `data.nfInKeywords[].searchVolume` | int? | 93.6% | 126 ~ 25484; 944 / 2429 / 1449 |
| `data.nfInKeywords[].translateKeyword` | str? | 97.0% | 金色圣诞装饰 / 圣诞树香槟色蝴蝶结 / 女士性感吸血鬼服装 |
| `data.nfOutKeywords` | array? | 86.7% | len 0~72 |
| `data.nfOutKeywords[]` | object | 100.0% |  |
| `data.nfOutKeywords[].keyword` | str | 100.0% | gothic accessories for woman / victorian jewelry / fall figurines |
| `data.nfOutKeywords[].nfLastRank` | int | 100.0% | 1 ~ 144; 134 / 141 / 120 |
| `data.nfOutKeywords[].nfLastRankStr` | str | 100.0% | p3,38/48 / p3,45/48 / p3,24/48 |
| `data.nfOutKeywords[].searchRank` | int? | 95.4% | 9034 ~ 2672516; 185017 / 436094 / 204754 |
| `data.nfOutKeywords[].searchVolume` | int? | 95.4% | 126 ~ 25484; 1787 / 782 / 1621 |
| … 另有 3 个字段 | | | 见 `_schemas.json` |

#### `web-asin-variants`

变体关系：父 ASIN + 变体清单

- **可用性**：✅ CLI 实测可用（0.61s，273,955 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8"}`
- **字段表样本**：120 条历史成功响应（日志共 430 条，2026-08-11 ~ 2026-09-20），打平 24 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object? | 95.0% |  |
| `data.pasin` | bool | 100.0% | False / True |
| `data.total` | int | 100.0% | 1 ~ 316; 2 / 1 / 7 |
| `data.variants` | array | 100.0% | len 2~317 |
| `data.variants[]` | object | 100.0% |  |
| `data.variants[].asin` | str | 100.0% |  / B0GRJFV49G / B0GRJ9XVLP |
| `data.variants[].asinScore` | float? | 90.5% | 3.2 ~ 5.0; 4.6 / 4.3 / 3.2 |
| `data.variants[].contriChangeRatio` | float? | 72.1% | -1.0 ~ 1.0; 0.57208849 / -0.42791151 / -1.0 |
| `data.variants[].features` | array? | 96.4% | len 1~3 |
| `data.variants[].features[]` | str | 100.0% | Pink Gingham / Pina Colada Stripe / Beige Camel |
| `data.variants[].img` | str? | 91.4% | https://m.media-amazon.com/images/I/81IzsYrRGzL._AC_UL320_.j… / https://m.media-amazon.com/images/I/812CXU4lIpL._AC_UL320_.j… / https://m.media-amazon.com/images/I/810wBVaZDeL._AC_UL320_.j… |
| `data.variants[].isBestSeller` | bool? | 88.9% | False / True |
| `data.variants[].keywordCount` | int? | 72.1% | =0; 0 |
| `data.variants[].order` | int | 100.0% | 0 ~ 316; 0 / 2 / 1 |
| `data.variants[].price` | float? | 91.4% | 3.99 ~ 296.99; 39.99 / 18.99 / 37.99 |
| `data.variants[].ratingNum` | int? | 90.3% | 1 ~ 49381; 49 / 54 / 9 |
| `data.variants[].ratio` | float? | 99.9% | 0.0 ~ 1.0; 1.0 / 0.58913555 / 0.41086445 |
| `data.variants[].score` | float? | 75.3% | 0.0 ~ 1595702.0858987255; 3209.5926157950607 / 1890.8851242633846 / 1318.7074915316764 |
| `data.variants[].scoreChangeRatio` | float? | 68.6% | -1.0 ~ 1485.27025502; 0.02876607 / 0.23202543 / -0.16804422 |
| `data.variants[].star` | float? | 90.5% | 3.0 ~ 5.0; 4.5 / 3.0 / 4.0 |
| `data.variants[].title` | str? | 91.4% | Fit & Fresh Insulated Double Decker Casserole Carrier for Ho… / Junkin 40 Pcs Western Party Decorations Cowboy Table Centerp… / 16 Pcs Beige Camel Shaggy Fur Floor Tiles, 11.8 in Puzzle Ma… |
| `data.variants[].variantCount` | null | 0.0% |  |
| `message` | null | 0.0% |  |

#### `web-compete-keyword`

关键词竞品分析：搜索量+排名+销量+竞品数

- **可用性**：✅ CLI 实测可用（0.48s，15,176 B）
- **本次实调入参**：`{"keywords": ["pink sweatsuit"], "trendType": "week"}`
- **字段表样本**：120 条历史成功响应（日志共 650 条，2026-08-10 ~ 2026-09-20），打平 65 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `balanceIntegral` | float? | 92.5% | =1988.0; 1988.0 |
| `balanceLimit` | null | 0.0% |  |
| `channel` | str | 100.0% | personal |
| `code` | int | 100.0% | =1; 1 |
| `consumeIntegral` | float | 100.0% | =0.0; 0.0 |
| `data` | object | 100.0% |  |
| `data.keywords` | array | 100.0% | len 0~14 |
| `data.keywords[]` | object | 100.0% |  |
| `data.keywords[].acAsinNum` | int | 100.0% | =0; 0 |
| `data.keywords[].brandAsinNum` | int | 100.0% | 0 ~ 166; 140 / 72 / 74 |
| `data.keywords[].clickShared` | float? | 88.5% | 0.0 ~ 0.6396; 0.16 / 0.002036 / 0.00361 |
| `data.keywords[].conversionShared` | float? | 88.5% | 0.0 ~ 0.75; 0.0769 / 0.001016 / 0.0 |
| `data.keywords[].erAsinNum` | null | 0.0% |  |
| `data.keywords[].estSearchesNum` | int? | 87.2% | 136 ~ 749533; 757 / 12055 / 2126 |
| `data.keywords[].estSearchesNumHistory` | object | 100.0% |  |
| `data.keywords[].estSearchesNumHistory.date` | array | 100.0% | len 8~37 |
| `data.keywords[].estSearchesNumHistory.date[]` | str | 100.0% | 2025-12-28 / 2026-01-04 / 2026-01-11 |
| `data.keywords[].estSearchesNumHistory.estSearchesNum` | array | 100.0% | len 8~37 |
| `data.keywords[].estSearchesNumHistory.estSearchesNum[]` | int? | 78.6% | 126 ~ 6524393; 3358 / 3803 / 4737 |
| `data.keywords[].estSearchesNumHistory.festivals` | array | 100.0% | len 8~37 |
| `data.keywords[].estSearchesNumHistory.festivals[]` | array? | 40.3% | len 1~2 |
| `data.keywords[].estSearchesNumHistory.festivals[][]` | object | 100.0% |  |
| `data.keywords[].estSearchesNumHistory.festivals[][].endDate` | str | 100.0% | 2026-02-14 / 2026-03-08 / 2026-03-31 |
| `data.keywords[].estSearchesNumHistory.festivals[][].name` | str | 100.0% | 情人节 / 妇女节 / 春季大促 |
| `data.keywords[].estSearchesNumHistory.festivals[][].startDate` | str | 100.0% | 2026-02-14 / 2026-03-08 / 2026-03-25 |
| `data.keywords[].estSearchesNumHistory.searchesNumChangeRatio` | array | 100.0% | len 8~37 |
| `data.keywords[].estSearchesNumHistory.searchesNumChangeRatio[]` | float? | 76.8% | -1.0 ~ 8.41892744; 0.79764454 / 0.4655106 / 0.86129666 |
| `data.keywords[].estSearchesNumHistory.searchesRank` | array | 100.0% | len 8~37 |
| `data.keywords[].estSearchesNumHistory.searchesRankChangeRatio` | array | 100.0% | len 8~37 |
| `data.keywords[].estSearchesNumHistory.searchesRankChangeRatio[]` | float? | 76.8% | -15.99460799 ~ 1.0; 0.4323032 / 0.3054358 / 0.45847308 |
| `data.keywords[].estSearchesNumHistory.searchesRank[]` | int? | 78.6% | 4 ~ 3256099; 104119 / 86517 / 66682 |
| `data.keywords[].estSearchesNumHistory.selectDate` | null | 0.0% |  |
| `data.keywords[].estSearchesNumHistoryPrev` | object | 100.0% |  |
| `data.keywords[].estSearchesNumHistoryPrev.date` | array | 100.0% | len 12~53 |
| `data.keywords[].estSearchesNumHistoryPrev.date[]` | str | 100.0% | 2024-12-29 / 2025-01-05 / 2025-01-12 |
| `data.keywords[].estSearchesNumHistoryPrev.estSearchesNum` | array | 100.0% | len 12~53 |
| `data.keywords[].estSearchesNumHistoryPrev.estSearchesNum[]` | int? | 80.7% | 126 ~ 6795860; 1868 / 2595 / 2545 |
| `data.keywords[].estSearchesNumHistoryPrev.festivals` | array | 100.0% | len 12~53 |
| `data.keywords[].estSearchesNumHistoryPrev.festivals[]` | array? | 14.0% | len 1~2 |
| `data.keywords[].estSearchesNumHistoryPrev.festivals[][]` | object | 100.0% |  |
| `data.keywords[].estSearchesNumHistoryPrev.festivals[][].endDate` | str | 100.0% | 2025-10-08 / 2025-10-31 / 2025-12-01 |
| `data.keywords[].estSearchesNumHistoryPrev.festivals[][].name` | str | 100.0% | Prime秋季大促会员日 / 万圣节 / 黑五网一 |
| `data.keywords[].estSearchesNumHistoryPrev.festivals[][].startDate` | str | 100.0% | 2025-10-07 / 2025-10-31 / 2025-11-20 |
| `data.keywords[].estSearchesNumHistoryPrev.searchesNumChangeRatio` | array | 100.0% | len 0~0 |
| `data.keywords[].estSearchesNumHistoryPrev.searchesRank` | array | 100.0% | len 12~53 |
| … 另有 20 个字段 | | | 见 `_schemas.json` |

#### `web-compete-pattern`

竞争格局：竞品清单 + 近月销量

- **可用性**：⚠️ CLI 实测通但返回空（1.16s，450 B）｜所有字段均空（asins,total,boughtMonth,dutyFinishDate）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8", "pageNum": 1, "pageSize": 20}`
- **字段表样本**：82 条历史成功响应（日志共 740 条，2026-08-10 ~ 2026-09-20），打平 39 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `balanceIntegral` | float? | 26.8% | =1988.0; 1988.0 |
| `balanceLimit` | null | 0.0% |  |
| `channel` | str | 100.0% | personal |
| `code` | int | 100.0% | =1; 1 |
| `consumeIntegral` | float | 100.0% | =0.0; 0.0 |
| `data` | object | 100.0% |  |
| `data.asins` | array? | 26.8% | len 20~100 |
| `data.asins[]` | object | 100.0% |  |
| `data.asins[].ac` | bool | 100.0% | False / True |
| `data.asins[].acDates` | array | 100.0% | len 0~25 |
| `data.asins[].acDates[]` | str | 100.0% | 2026-09-07 / 2026-09-08 / 2026-09-09 |
| `data.asins[].acScoreRatio` | float | 100.0% | 0.0 ~ 1.0; 0.0 / 0.71428571 / 0.14285714 |
| `data.asins[].asin` | str | 100.0% | B0D5D8CK76 / B0D5D8TJ9Q / B0D5JXMYN8 |
| `data.asins[].boughtHistory` | array | 100.0% | len 4~40 |
| `data.asins[].boughtHistoryDates` | array | 100.0% | len 4~40 |
| `data.asins[].boughtHistoryDates[]` | str | 100.0% | 2024-06 / 2024-07 / 2024-08 |
| `data.asins[].boughtHistory[]` | int? | 55.2% | 0 ~ 100000; 100 / 50 / 300 |
| `data.asins[].boughtInPastMonth` | str | 100.0% | 100+ / <50 / 1,000+ |
| `data.asins[].brandAdScoreRatio` | float | 100.0% | 0.0 ~ 0.27127739; 0.0 / 0.00033935 / 0.02127834 |
| `data.asins[].createdAt` | null | 0.0% |  |
| `data.asins[].erScoreRatio` | float | 100.0% | =0.0; 0.0 |
| `data.asins[].hasVaiants` | bool | 100.0% | False |
| `data.asins[].img` | str | 100.0% | https://m.media-amazon.com/images/I/61ai-V1hadL._AC_UL320_.j… / https://m.media-amazon.com/images/I/615djoUZHrL._AC_UL320_.j… / https://m.media-amazon.com/images/I/61ShXZvQYBL._AC_UL320_.j… |
| `data.asins[].isFocus` | bool | 100.0% | False |
| `data.asins[].nfScoreRatio` | float | 100.0% | 0.0 ~ 0.13889085; 0.00780416 / 0.0 / 0.00208869 |
| `data.asins[].price` | float | 100.0% | 2.98 ~ 104.99; 36.99 / 34.99 / 44.99 |
| `data.asins[].ratingNum` | int? | 98.7% | 1 ~ 93133; 131 / 11 / 124 |
| `data.asins[].score` | float? | 98.7% | 1.0 ~ 5.0; 4.4 / 4.9 / 4.0 |
| `data.asins[].spRecScoreRatio` | float | 100.0% | 0.0 ~ 0.16821329; 0.0553153 / 0.00152963 / 0.0 |
| `data.asins[].spScoreRatio` | float | 100.0% | 0.0 ~ 0.19747061; 0.0 / 0.00216033 / 0.01126314 |
| `data.asins[].star` | float? | 98.7% | 1.0 ~ 5.0; 4.5 / 5.0 / 4.0 |
| `data.asins[].title` | str | 100.0% | ALINK Plastic Classroom Caddy Organizer with Handle, 6-Pack … / ECR4Kids 4-Compartment Small Storage Caddy Organizer, 6-Pack… / 4E's Novelty 6 Colorful Plastic Trays for Teachers, Durable … |
| `data.asins[].trScoreRatio` | float | 100.0% | =0.0; 0.0 |
| `data.asins[].vedioAdScoreRatio` | float | 100.0% | 0.0 ~ 0.63736664; 0.0 / 0.02603873 / 0.63736664 |
| `data.boughtMonth` | null | 0.0% |  |
| `data.dutyFinishDate` | null | 0.0% |  |
| `data.total` | int? | 26.8% | 347 ~ 1456; 347 / 1149 / 556 |
| `integralLimit` | null | 0.0% |  |
| `message` | str? | 26.8% | 不需要扣取积分。 |

#### `web-est-searches-history`

关键词逐期预估搜索量曲线

- **可用性**：✅ CLI 实测可用（0.47s，16,680 B）
- **本次实调入参**：`{"keywords": ["pink sweatsuit"]}`
- **字段表样本**：120 条历史成功响应（日志共 484 条，2026-08-19 ~ 2026-09-20），打平 52 个字段
- **⚠️ 动态 key**：以下路径是「以业务值为 key 的 map」，不是数组，ETL 要先 `jsonb_each` 展开：
    - `data.estSearchesNumHistory` 的 key 是 {keyword}

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.estSearchesNumHistory` 🔑 | object | 100.0% |  |
| `data.estSearchesNumHistory.diya` | object | 100.0% |  |
| `data.estSearchesNumHistory.diya.date` | array | 100.0% | len 74~74 |
| `data.estSearchesNumHistory.diya.date[]` | str | 100.0% | 2020-07 / 2020-08 / 2020-09 |
| `data.estSearchesNumHistory.diya.estSearchesNum` | array | 100.0% | len 74~74 |
| `data.estSearchesNumHistory.diya.estSearchesNum[]` | int | 100.0% | 2045 ~ 42872; 5426 / 6267 / 5588 |
| `data.estSearchesNumHistory.diya.festivals` | array | 100.0% | len 74~74 |
| `data.estSearchesNumHistory.diya.festivals[]` | array? | 66.2% | len 1~2 |
| `data.estSearchesNumHistory.diya.festivals[][]` | object | 100.0% |  |
| `data.estSearchesNumHistory.diya.festivals[][].endDate` | str | 100.0% | 2020-10-14 / 2020-10-31 / 2020-11-30 |
| `data.estSearchesNumHistory.diya.festivals[][].name` | str | 100.0% | Prime Day / 万圣节 / 黑五网一 |
| `data.estSearchesNumHistory.diya.festivals[][].startDate` | str | 100.0% | 2020-10-13 / 2020-10-31 / 2020-11-20 |
| `data.estSearchesNumHistory.diya.searchesNumChangeRatio` | array | 100.0% | len 0~0 |
| `data.estSearchesNumHistory.diya.searchesRank` | array | 100.0% | len 74~74 |
| `data.estSearchesNumHistory.diya.searchesRankChangeRatio` | array | 100.0% | len 0~0 |
| `data.estSearchesNumHistory.diya.searchesRank[]` | int | 100.0% | 23256 ~ 979657; 362276 / 265761 / 302015 |
| `data.estSearchesNumHistory.diya.selectDate` | null | 0.0% |  |
| `data.estSearchesNumHistory.geschenk` | object | 100.0% |  |
| `data.estSearchesNumHistory.geschenk.date` | array | 100.0% | len 0~0 |
| `data.estSearchesNumHistory.geschenk.estSearchesNum` | array | 100.0% | len 0~0 |
| `data.estSearchesNumHistory.geschenk.festivals` | array | 100.0% | len 0~0 |
| `data.estSearchesNumHistory.geschenk.searchesNumChangeRatio` | array | 100.0% | len 0~0 |
| `data.estSearchesNumHistory.geschenk.searchesRank` | array | 100.0% | len 0~0 |
| `data.estSearchesNumHistory.geschenk.searchesRankChangeRatio` | array | 100.0% | len 0~0 |
| `data.estSearchesNumHistory.geschenk.selectDate` | null | 0.0% |  |
| `data.estSearchesNumHistory.weihnachten` | object | 100.0% |  |
| `data.estSearchesNumHistory.weihnachten.date` | array | 100.0% | len 0~0 |
| `data.estSearchesNumHistory.weihnachten.estSearchesNum` | array | 100.0% | len 0~0 |
| `data.estSearchesNumHistory.weihnachten.festivals` | array | 100.0% | len 0~0 |
| `data.estSearchesNumHistory.weihnachten.searchesNumChangeRatio` | array | 100.0% | len 0~0 |
| `data.estSearchesNumHistory.weihnachten.searchesRank` | array | 100.0% | len 0~0 |
| `data.estSearchesNumHistory.weihnachten.searchesRankChangeRatio` | array | 100.0% | len 0~0 |
| `data.estSearchesNumHistory.weihnachten.selectDate` | null | 0.0% |  |
| `data.estSearchesNumHistory.{keyword}` | object | 100.0% |  |
| `data.estSearchesNumHistory.{keyword}.date` | array | 100.0% | len 0~311 |
| `data.estSearchesNumHistory.{keyword}.date[]` | str | 100.0% | 2020-09 / 2020-10 / 2020-11 |
| `data.estSearchesNumHistory.{keyword}.estSearchesNum` | array | 100.0% | len 0~311 |
| `data.estSearchesNumHistory.{keyword}.estSearchesNum[]` | int? | 76.4% | 24 ~ 5393580; 3967 / 9337 / 4284 |
| `data.estSearchesNumHistory.{keyword}.festivals` | array | 100.0% | len 0~311 |
| `data.estSearchesNumHistory.{keyword}.festivals[]` | array? | 56.1% | len 1~2 |
| `data.estSearchesNumHistory.{keyword}.festivals[][]` | object | 100.0% |  |
| `data.estSearchesNumHistory.{keyword}.festivals[][].endDate` | str | 100.0% | 2020-10-14 / 2020-10-31 / 2020-11-30 |
| `data.estSearchesNumHistory.{keyword}.festivals[][].name` | str | 100.0% | Prime Day / 万圣节 / 黑五网一 |
| … 另有 7 个字段 | | | 见 `_schemas.json` |

#### `web-keyword-conversion`

ABA 转化漏斗：搜索/点击/购买 + 三种转化率

- **可用性**：✅ CLI 实测可用（0.38s，340 B）
- **本次实调入参**：`{"keywords": ["pink sweatsuit"]}`
- **字段表样本**：120 条历史成功响应（日志共 658 条，2026-08-14 ~ 2026-09-20），打平 176 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.keywords` | array | 100.0% | len 0~100 |
| `data.keywords[]` | object | 100.0% |  |
| `data.keywords[].acos` | object | 100.0% |  |
| `data.keywords[].acos.autoForSales_broad` | array | 100.0% | len 1~1 |
| `data.keywords[].acos.autoForSales_broad[]` | object | 100.0% |  |
| `data.keywords[].acos.autoForSales_broad[].categoryName` | null | 0.0% |  |
| `data.keywords[].acos.autoForSales_broad[].categoryid` | null | 0.0% |  |
| `data.keywords[].acos.autoForSales_broad[].end` | float? | 92.2% | 0.0017 ~ 4.1684; 0.3539 / 0.2278 / 0.1566 |
| `data.keywords[].acos.autoForSales_broad[].median` | float? | 92.2% | 0.034 ~ 9.1884; 1.1769 / 0.7135 / 0.4688 |
| `data.keywords[].acos.autoForSales_broad[].start` | float? | 92.2% | 0.0947 ~ 39.8684; 4.967 / 2.0551 / 1.3632 |
| `data.keywords[].acos.autoForSales_exact` | array | 100.0% | len 1~1 |
| `data.keywords[].acos.autoForSales_exact[]` | object | 100.0% |  |
| `data.keywords[].acos.autoForSales_exact[].categoryName` | null | 0.0% |  |
| `data.keywords[].acos.autoForSales_exact[].categoryid` | null | 0.0% |  |
| `data.keywords[].acos.autoForSales_exact[].end` | float? | 92.2% | 0.0011 ~ 4.0017; 0.2337 / 0.2223 / 0.1768 |
| `data.keywords[].acos.autoForSales_exact[].median` | float? | 92.2% | 0.0375 ~ 9.3524; 0.7772 / 0.6961 / 0.5293 |
| `data.keywords[].acos.autoForSales_exact[].start` | float? | 92.2% | 0.2106 ~ 48.906; 3.2801 / 2.005 / 1.5391 |
| `data.keywords[].acos.autoForSales_phrase` | array | 100.0% | len 1~1 |
| `data.keywords[].acos.autoForSales_phrase[]` | object | 100.0% |  |
| `data.keywords[].acos.autoForSales_phrase[].categoryName` | null | 0.0% |  |
| `data.keywords[].acos.autoForSales_phrase[].categoryid` | null | 0.0% |  |
| `data.keywords[].acos.autoForSales_phrase[].end` | float? | 92.2% | 0.0017 ~ 4.1684; 0.3138 / 0.2334 / 0.1566 |
| `data.keywords[].acos.autoForSales_phrase[].median` | float? | 92.2% | 0.0485 ~ 9.3973; 1.0437 / 0.7309 / 0.4688 |
| `data.keywords[].acos.autoForSales_phrase[].start` | float? | 92.2% | 0.1262 ~ 39.8684; 4.4047 / 2.1053 / 1.3632 |
| `data.keywords[].acos.legacyForSales_broad` | array | 100.0% | len 1~1 |
| `data.keywords[].acos.legacyForSales_broad[]` | object | 100.0% |  |
| `data.keywords[].acos.legacyForSales_broad[].categoryName` | null | 0.0% |  |
| `data.keywords[].acos.legacyForSales_broad[].categoryid` | null | 0.0% |  |
| `data.keywords[].acos.legacyForSales_broad[].end` | float? | 90.7% | 0.0027 ~ 5.1974; 0.5475 / 0.3557 / 0.2476 |
| `data.keywords[].acos.legacyForSales_broad[].median` | float? | 90.7% | 0.0544 ~ 14.3047; 1.8209 / 1.1138 / 0.741 |
| `data.keywords[].acos.legacyForSales_broad[].start` | float? | 90.7% | 0.1452 ~ 57.6152; 7.6848 / 3.208 / 2.1548 |
| `data.keywords[].acos.legacyForSales_exact` | array | 100.0% | len 1~1 |
| `data.keywords[].acos.legacyForSales_exact[]` | object | 100.0% |  |
| `data.keywords[].acos.legacyForSales_exact[].categoryName` | null | 0.0% |  |
| `data.keywords[].acos.legacyForSales_exact[].categoryid` | null | 0.0% |  |
| `data.keywords[].acos.legacyForSales_exact[].end` | float? | 90.7% | 0.0017 ~ 4.5224; 0.2337 / 0.3445 / 0.2172 |
| `data.keywords[].acos.legacyForSales_exact[].median` | float? | 90.7% | 0.0547 ~ 13.365; 0.7772 / 1.079 / 0.6503 |
| `data.keywords[].acos.legacyForSales_exact[].start` | float? | 90.7% | 0.2209 ~ 73.4803; 3.2801 / 3.1078 / 1.8909 |
| `data.keywords[].acos.legacyForSales_phrase` | array | 100.0% | len 1~1 |
| `data.keywords[].acos.legacyForSales_phrase[]` | object | 100.0% |  |
| `data.keywords[].acos.legacyForSales_phrase[].categoryName` | null | 0.0% |  |
| `data.keywords[].acos.legacyForSales_phrase[].categoryid` | null | 0.0% |  |
| `data.keywords[].acos.legacyForSales_phrase[].end` | float? | 90.7% | 0.0025 ~ 5.0025; 0.5208 / 0.3612 / 0.2526 |
| … 另有 131 个字段 | | | 见 `_schemas.json` |

#### `web-keyword-extend`

扩展词：由种子词扩展出的关键词清单

- **可用性**：✅ CLI 实测可用（0.49s，9,113 B）
- **本次实调入参**：`{"keyword": "pink sweatsuit", "pageNum": 1, "pageSize": 50}`
- **字段表样本**：120 条历史成功响应（日志共 924 条，2026-08-13 ~ 2026-09-20），打平 108 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `balanceIntegral` | float? | 89.2% | =1988.0; 1988.0 |
| `balanceLimit` | null | 0.0% |  |
| `channel` | str | 100.0% | personal |
| `code` | int | 100.0% | =1; 1 |
| `consumeIntegral` | float | 100.0% | =0.0; 0.0 |
| `data` | object | 100.0% |  |
| `data.globalKeywordNum` | int | 100.0% | =1000000; 1000000 |
| `data.groupFilterNum` | int | 100.0% | =0; 0 |
| `data.groupValidNum` | int | 100.0% | 0 ~ 86; 0 / 2 / 50 |
| `data.keywords` | array | 100.0% | len 0~86 |
| `data.keywords[]` | object | 100.0% |  |
| `data.keywords[].clickPurchaseRatio` | float? | 34.3% | 0.0 ~ 0.3791; 0.2611 / 0.2063 / 0.2456 |
| `data.keywords[].confirmRelevance` | null | 0.0% |  |
| `data.keywords[].cpc` | object | 100.0% |  |
| `data.keywords[].cpc.autoForSales_broad` | array | 100.0% | len 0~1 |
| `data.keywords[].cpc.autoForSales_broad[]` | object | 100.0% |  |
| `data.keywords[].cpc.autoForSales_broad[].categoryName` | str | 100.0% | Paper Towel Holders / Kids' Backpacks / Reusable Lunch Bags |
| `data.keywords[].cpc.autoForSales_broad[].categoryid` | str | 100.0% | 3744201 / 2404178011 / 2287321011 |
| `data.keywords[].cpc.autoForSales_broad[].end` | float? | 93.3% | 0.13 ~ 7.85; 1.09 / 1.06 / 1.23 |
| `data.keywords[].cpc.autoForSales_broad[].median` | float? | 93.3% | 0.12 ~ 7.14; 0.9 / 0.86 / 0.98 |
| `data.keywords[].cpc.autoForSales_broad[].start` | float? | 93.3% | 0.11 ~ 6.43; 0.67 / 0.61 / 0.74 |
| `data.keywords[].cpc.autoForSales_exact` | array | 100.0% | len 0~1 |
| `data.keywords[].cpc.autoForSales_exact[]` | object | 100.0% |  |
| `data.keywords[].cpc.autoForSales_exact[].categoryName` | str | 100.0% | Paper Towel Holders / Kids' Backpacks / Reusable Lunch Bags |
| `data.keywords[].cpc.autoForSales_exact[].categoryid` | str | 100.0% | 3744201 / 2404178011 / 2287321011 |
| `data.keywords[].cpc.autoForSales_exact[].end` | float? | 93.3% | 0.38 ~ 3.1; 0.76 / 0.96 / 1.16 |
| `data.keywords[].cpc.autoForSales_exact[].median` | float? | 93.3% | 0.35 ~ 2.48; 0.68 / 0.76 / 0.93 |
| `data.keywords[].cpc.autoForSales_exact[].start` | float? | 93.3% | 0.32 ~ 1.6; 0.58 / 0.63 / 0.7 |
| `data.keywords[].cpc.autoForSales_phrase` | array | 100.0% | len 0~1 |
| `data.keywords[].cpc.autoForSales_phrase[]` | object | 100.0% |  |
| `data.keywords[].cpc.autoForSales_phrase[].categoryName` | str | 100.0% | Paper Towel Holders / Kids' Backpacks / Reusable Lunch Bags |
| `data.keywords[].cpc.autoForSales_phrase[].categoryid` | str | 100.0% | 3744201 / 2404178011 / 2287321011 |
| `data.keywords[].cpc.autoForSales_phrase[].end` | float? | 93.3% | 0.22 ~ 11.0; 1.1 / 1.23 / 1.08 |
| `data.keywords[].cpc.autoForSales_phrase[].median` | float? | 93.3% | 0.2 ~ 10.0; 0.92 / 0.98 / 0.78 |
| `data.keywords[].cpc.autoForSales_phrase[].start` | float? | 93.3% | 0.18 ~ 7.6; 0.68 / 0.74 / 0.64 |
| `data.keywords[].cpc.legacyForSales_broad` | array | 100.0% | len 0~1 |
| `data.keywords[].cpc.legacyForSales_broad[]` | object | 100.0% |  |
| `data.keywords[].cpc.legacyForSales_broad[].categoryName` | str | 100.0% | Paper Towel Holders / Kids' Backpacks / Reusable Lunch Bags |
| `data.keywords[].cpc.legacyForSales_broad[].categoryid` | str | 100.0% | 3744201 / 2404178011 / 2287321011 |
| `data.keywords[].cpc.legacyForSales_broad[].end` | float? | 85.0% | 0.19 ~ 7.85; 1.71 / 1.76 / 1.98 |
| `data.keywords[].cpc.legacyForSales_broad[].median` | float? | 85.0% | 0.15 ~ 7.14; 1.4 / 1.46 / 1.58 |
| `data.keywords[].cpc.legacyForSales_broad[].start` | float? | 85.0% | 0.11 ~ 6.43; 0.99 / 1.08 / 1.19 |
| `data.keywords[].cpc.legacyForSales_exact` | array | 100.0% | len 0~1 |
| `data.keywords[].cpc.legacyForSales_exact[]` | object | 100.0% |  |
| `data.keywords[].cpc.legacyForSales_exact[].categoryName` | str | 100.0% | Paper Towel Holders / Kids' Backpacks / Reusable Lunch Bags |
| … 另有 63 个字段 | | | 见 `_schemas.json` |

#### `web-keywords-basic-info`

批量关键词基础字段

- **可用性**：✅ CLI 实测可用（0.37s，14,526 B）
- **本次实调入参**：`{"keywords": ["pink sweatsuit"]}`
- **字段表样本**：120 条历史成功响应（日志共 270 条，2026-08-19 ~ 2026-09-20），打平 45 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.keywords` | array | 100.0% | len 1~36 |
| `data.keywords[]` | object | 100.0% |  |
| `data.keywords[].estSearchesNum` | int? | 65.1% | 126 ~ 321757; 757 / 9151 / 4772 |
| `data.keywords[].estSearchesNumHistory` | object | 100.0% |  |
| `data.keywords[].estSearchesNumHistory.date` | array | 100.0% | len 37~37 |
| `data.keywords[].estSearchesNumHistory.date[]` | str | 100.0% | 2025-12-28 / 2026-01-04 / 2026-01-11 |
| `data.keywords[].estSearchesNumHistory.estSearchesNum` | array | 100.0% | len 37~37 |
| `data.keywords[].estSearchesNumHistory.estSearchesNum[]` | int? | 56.9% | 126 ~ 1968054; 3358 / 3803 / 4737 |
| `data.keywords[].estSearchesNumHistory.festivals` | array | 100.0% | len 37~37 |
| `data.keywords[].estSearchesNumHistory.festivals[]` | array? | 35.1% | len 1~1 |
| `data.keywords[].estSearchesNumHistory.festivals[][]` | object | 100.0% |  |
| `data.keywords[].estSearchesNumHistory.festivals[][].endDate` | str | 100.0% | 2026-02-14 / 2026-03-08 / 2026-03-31 |
| `data.keywords[].estSearchesNumHistory.festivals[][].name` | str | 100.0% | 情人节 / 妇女节 / 春季大促 |
| `data.keywords[].estSearchesNumHistory.festivals[][].startDate` | str | 100.0% | 2026-02-14 / 2026-03-08 / 2026-03-25 |
| `data.keywords[].estSearchesNumHistory.searchesNumChangeRatio` | array | 100.0% | len 37~37 |
| `data.keywords[].estSearchesNumHistory.searchesNumChangeRatio[]` | float? | 53.5% | -1.0 ~ 151.1369863; 0.79764454 / 0.4655106 / 0.86129666 |
| `data.keywords[].estSearchesNumHistory.searchesRank` | array | 100.0% | len 37~37 |
| `data.keywords[].estSearchesNumHistory.searchesRankChangeRatio` | array | 100.0% | len 37~37 |
| `data.keywords[].estSearchesNumHistory.searchesRankChangeRatio[]` | float? | 53.5% | -240.99038462 ~ 1.0; 0.4323032 / 0.3054358 / 0.45847308 |
| `data.keywords[].estSearchesNumHistory.searchesRank[]` | int? | 56.9% | 2 ~ 3371676; 104119 / 86517 / 66682 |
| `data.keywords[].estSearchesNumHistory.selectDate` | null | 0.0% |  |
| `data.keywords[].estSearchesNumHistoryPrev` | object | 100.0% |  |
| `data.keywords[].estSearchesNumHistoryPrev.date` | array | 100.0% | len 53~53 |
| `data.keywords[].estSearchesNumHistoryPrev.date[]` | str | 100.0% | 2024-12-29 / 2025-01-05 / 2025-01-12 |
| `data.keywords[].estSearchesNumHistoryPrev.estSearchesNum` | array | 100.0% | len 53~53 |
| `data.keywords[].estSearchesNumHistoryPrev.estSearchesNum[]` | int? | 58.3% | 126 ~ 2478563; 1868 / 2595 / 2545 |
| `data.keywords[].estSearchesNumHistoryPrev.festivals` | array | 100.0% | len 53~53 |
| `data.keywords[].estSearchesNumHistoryPrev.festivals[]` | array? | 11.3% | len 1~2 |
| `data.keywords[].estSearchesNumHistoryPrev.festivals[][]` | object | 100.0% |  |
| `data.keywords[].estSearchesNumHistoryPrev.festivals[][].endDate` | str | 100.0% | 2025-10-08 / 2025-10-31 / 2025-12-01 |
| `data.keywords[].estSearchesNumHistoryPrev.festivals[][].name` | str | 100.0% | Prime秋季大促会员日 / 万圣节 / 黑五网一 |
| `data.keywords[].estSearchesNumHistoryPrev.festivals[][].startDate` | str | 100.0% | 2025-10-07 / 2025-10-31 / 2025-11-20 |
| `data.keywords[].estSearchesNumHistoryPrev.searchesNumChangeRatio` | array | 100.0% | len 0~0 |
| `data.keywords[].estSearchesNumHistoryPrev.searchesRank` | array | 100.0% | len 53~53 |
| `data.keywords[].estSearchesNumHistoryPrev.searchesRankChangeRatio` | array | 100.0% | len 0~0 |
| `data.keywords[].estSearchesNumHistoryPrev.searchesRank[]` | int? | 58.3% | 2 ~ 3709134; 183406 / 124563 / 123137 |
| `data.keywords[].estSearchesNumHistoryPrev.selectDate` | null | 0.0% |  |
| `data.keywords[].keyword` | str | 100.0% | pink sweatsuit / christmas village / christmas village houses |
| `data.keywords[].relevance` | null | 0.0% |  |
| `data.keywords[].searchesRank` | int? | 65.1% | 123 ~ 2620986; 450798 / 31873 / 65541 |
| `data.keywords[].translateKeyword` | str? | 90.5% | 粉色运动服 / 圣诞村庄 / 圣诞村庄房屋 |
| `data.total` | int | 100.0% | 1 ~ 36; 1 / 10 / 5 |
| `message` | null | 0.0% |  |

#### `web-sales-asin`

一组 ASIN 的销量概览 + 父子体信息

- **可用性**：✅ CLI 实测可用（0.48s，22,343 B）
- **本次实调入参**：`{"asins": ["B0FVNPKGJ8"]}`
- **字段表样本**：120 条历史成功响应（日志共 797 条，2026-08-11 ~ 2026-09-20），打平 49 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.asins` | array | 100.0% | len 0~40 |
| `data.asins[]` | object | 100.0% |  |
| `data.asins[].asin` | str | 100.0% | B0CG33ZG8V / B07HM6QT14 / B0CFXG4TXR |
| `data.asins[].boughtHistory` | array | 100.0% | len 0~40 |
| `data.asins[].boughtHistoryDates` | array | 100.0% | len 0~40 |
| `data.asins[].boughtHistoryDates[]` | str | 100.0% | 2023-10 / 2023-11 / 2023-12 |
| `data.asins[].boughtHistory[]` | int? | 96.8% | 0 ~ 6000; 300 / 1000 / 0 |
| `data.asins[].boughtInPastMonth` | str | 100.0% | 400+ / <50 / 200+ |
| `data.asins[].boughtInPastMonthBest` | bool? | 1.9% | True |
| `data.asins[].brand` | null | 0.0% |  |
| `data.asins[].brandHref` | null | 0.0% |  |
| `data.asins[].brandRefreshable` | null | 0.0% |  |
| `data.asins[].datasourceFlag` | null | 0.0% |  |
| `data.asins[].diffAvailableDays` | null | 0.0% |  |
| `data.asins[].diffAvailableDaysDateFormat` | null | 0.0% |  |
| `data.asins[].diffAvailableDaysNumberFormat` | null | 0.0% |  |
| `data.asins[].features` | array? | 16.3% | len 1~4 |
| `data.asins[].features[]` | object | 100.0% |  |
| `data.asins[].features[].boughtInPastMonthBest` | bool? | 0.6% | True |
| `data.asins[].features[].code` | str | 100.0% | Color / Style / Specialsizetype |
| `data.asins[].features[].feature` | str | 100.0% | Color / Style / Specialsizetype |
| `data.asins[].features[].value` | str | 100.0% | 9pcs / Creative / Petite |
| `data.asins[].firstAvailableDay` | null | 0.0% |  |
| `data.asins[].img` | str? | 65.4% | https://m.media-amazon.com/images/I/71At2Qnj8XL._AC_UL320_.j… / https://m.media-amazon.com/images/I/81igUchbjUL._AC_UL320_.j… / https://m.media-amazon.com/images/I/71JSXvSueqL._AC_UL320_.j… |
| `data.asins[].isFocus` | bool | 100.0% | False |
| `data.asins[].isVaiant` | bool | 100.0% | False / True |
| `data.asins[].keepaLoaded` | null | 0.0% |  |
| `data.asins[].listedRefreshable` | null | 0.0% |  |
| `data.asins[].pasinBoughtHistory` | array | 100.0% | len 0~0 |
| `data.asins[].price` | float? | 65.2% | 0.0 ~ 11363.7; 39.99 / 99.95 / 19.99 |
| `data.asins[].priceBest` | bool? | 3.9% | True |
| `data.asins[].ratingNum` | int? | 36.0% | 1 ~ 10518; 380 / 621 / 156 |
| `data.asins[].ratingNumBest` | bool? | 2.8% | True |
| `data.asins[].refreshable` | null | 0.0% |  |
| `data.asins[].score` | float? | 36.2% | 0.0 ~ 5.0; 4.7 / 4.5 / 4.3 |
| `data.asins[].scoreBest` | bool? | 7.0% | True |
| `data.asins[].snapshotUpdateTime` | null | 0.0% |  |
| `data.asins[].star` | float? | 36.2% | 0.0 ~ 5.0; 4.5 / 5.0 / 3.0 |
| `data.asins[].title` | str? | 65.4% | Christmas Decorations - Village Sets of 5 Lighted Ceramic Ho… / Mark Feldstein Winter Village LED Porcelain Christmas Set, 3… / Ovootok Wood & Plastic Christmas Sculpture Set, 9pcs, Includ… |
| `data.boughtMonth` | null | 0.0% |  |
| `data.features` | array | 100.0% | len 0~3 |
| `data.features[]` | str | 100.0% | Specialsizetype / Size / Color |
| `data.isParentAsin` | bool | 100.0% | False |
| … 另有 4 个字段 | | | 见 `_schemas.json` |

#### `web-sales-keyword`

某关键词下 ASIN 的近月销量

- **可用性**：✅ CLI 实测可用（0.4s，31,372 B）
- **本次实调入参**：`{"keyword": "pink sweatsuit"}`
- **字段表样本**：120 条历史成功响应（日志共 3024 条，2026-08-10 ~ 2026-09-20），打平 48 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.asins` | array? | 74.2% | len 10~50 |
| `data.asins[]` | object | 100.0% |  |
| `data.asins[].asin` | str | 100.0% | B0CHDY2GMR / B0F62P61G5 / B0FF1VMDWT |
| `data.asins[].boughtHistory` | array | 100.0% | len 11~40 |
| `data.asins[].boughtHistoryDates` | array | 100.0% | len 11~40 |
| `data.asins[].boughtHistoryDates[]` | str | 100.0% | 2023-10 / 2023-11 / 2023-12 |
| `data.asins[].boughtHistory[]` | int? | 55.4% | 0 ~ 100000; 0 / 50 / 100 |
| `data.asins[].boughtInPastMonth` | str | 100.0% | <50 / 500+ / 300+ |
| `data.asins[].boughtInPastMonthBest` | null | 0.0% |  |
| `data.asins[].brand` | str? | 99.8% | TMLTCOR / Demonwer / OUQQWEU |
| `data.asins[].brandHref` | str? | 99.4% | https://www.amazon.com/TMLTCOR/b/ref=bl_dp_s_web_11851921801… / https://www.amazon.com/Demonwer/b/ref=bl_dp_s_web_1210423250… / https://www.amazon.com/s/ref=bl_dp_s_web_0?ie=UTF8&search-al… |
| `data.asins[].brandRefreshable` | bool | 100.0% | False / True |
| `data.asins[].datasourceFlag` | int | 100.0% | 1 ~ 3; 3 / 1 / 2 |
| `data.asins[].diffAvailableDays` | int? | 99.7% | 9 ~ 9120; 1111 / 516 / 456 |
| `data.asins[].diffAvailableDaysDateFormat` | str? | 99.7% | 3年零1个月 / 1年零5个月 / 1年零3个月 |
| `data.asins[].diffAvailableDaysNumberFormat` | str? | 99.7% | 1,111天 / 516天 / 456天 |
| `data.asins[].features` | array? | 86.4% | len 1~3 |
| `data.asins[].features[]` | object | 100.0% |  |
| `data.asins[].features[].boughtInPastMonthBest` | null | 0.0% |  |
| `data.asins[].features[].code` | str | 100.0% | Size / Color / Number |
| `data.asins[].features[].feature` | str | 100.0% | Size / Color / Number |
| `data.asins[].features[].value` | str | 100.0% | 52"W x 96"L (Pack of 2) / Dark Grey/Star / 4 Pack |
| `data.asins[].firstAvailableDay` | str? | 99.7% | 2023-09-05 / 2025-04-22 / 2025-06-21 |
| `data.asins[].img` | str | 100.0% | https://m.media-amazon.com/images/I/71GthDoK6eL._AC_UL320_.j… / https://m.media-amazon.com/images/I/71WmbgxCwlL._AC_UY218_.j… / https://m.media-amazon.com/images/I/71mLlgtSw3L._AC_UL320_.j… |
| `data.asins[].isFocus` | bool | 100.0% | False |
| `data.asins[].isVaiant` | bool | 100.0% | False |
| `data.asins[].keepaLoaded` | bool | 100.0% | True / False |
| `data.asins[].listedRefreshable` | bool | 100.0% | False / True |
| `data.asins[].pasinBoughtHistory` | array | 100.0% | len 0~0 |
| `data.asins[].price` | float | 100.0% | 3.59 ~ 236.73; 19.99 / 13.99 / 12.99 |
| `data.asins[].priceBest` | null | 0.0% |  |
| `data.asins[].ratingNum` | int? | 98.5% | 1 ~ 77413; 356 / 154 / 1 |
| `data.asins[].ratingNumBest` | null | 0.0% |  |
| `data.asins[].refreshable` | bool | 100.0% | False / True |
| `data.asins[].score` | float? | 98.5% | 2.4 ~ 5.0; 4.4 / 5.0 / 4.0 |
| `data.asins[].scoreBest` | null | 0.0% |  |
| `data.asins[].snapshotUpdateTime` | int | 100.0% | 1770955006748 ~ 1789884980178; 1789632395316 / 1789875043322 / 1789884975408 |
| `data.asins[].star` | float? | 98.5% | 2.5 ~ 5.0; 4.5 / 5.0 / 4.0 |
| `data.asins[].title` | str | 100.0% | Blackout Curtains for Bedroom,Room Darkening Curtains 96 inc… / 4 Pack Glow in The Dark Curtains Party Supplies 6.6 x 3.3 Ft… / Glow in The Dark Party Supplies, 2 Packs Rainbow Neon Foil F… |
| `data.boughtMonth` | null | 0.0% |  |
| `data.features` | array | 100.0% | len 0~0 |
| `data.isParentAsin` | null | 0.0% |  |
| `data.nbVaiantsNum` | null | 0.0% |  |
| … 另有 3 个字段 | | | 见 `_schemas.json` |

#### `web-sales-listing-history`

Listing 逐月历史销量（含父体）

- **可用性**：✅ CLI 实测可用（0.41s，20,048 B）
- **本次实调入参**：`{"asins": ["B0FVNPKGJ8"], "dimension": 1}`
- **字段表样本**：120 条历史成功响应（日志共 506 条，2026-08-11 ~ 2026-09-20），打平 31 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.boughtHistoryDates` | array | 100.0% | len 0~40 |
| `data.boughtHistoryDates[]` | str | 100.0% | 2025-08 / 2025-09 / 2025-10 |
| `data.boughtInPastMonth` | str? | 45.0% | <50 / 100+ / 4,000+ |
| `data.chars` | array | 100.0% | len 0~100 |
| `data.chars[]` | object | 100.0% |  |
| `data.chars[].boughtInPastMonthBest` | bool? | 0.6% | True |
| `data.chars[].boughtList` | array | 100.0% | len 0~40 |
| `data.chars[].boughtList[]` | object | 100.0% |  |
| `data.chars[].boughtList[].bought` | int? | 36.6% | 0 ~ 10000; 0 / 100 / 200 |
| `data.chars[].boughtList[].boughtInPastMonthBest` | bool? | 0.7% | True |
| `data.chars[].boughtList[].ratio` | null | 0.0% |  |
| `data.chars[].dimVal` | str | 100.0% | B0FDJWW351 / B0FDKBBN3K / B0FDHW137V |
| `data.chars[].features` | array? | 75.2% | len 1~3 |
| `data.chars[].features[]` | object | 100.0% |  |
| `data.chars[].features[].boughtInPastMonthBest` | null | 0.0% |  |
| `data.chars[].features[].code` | str | 100.0% | Color / Style / Size |
| `data.chars[].features[].feature` | str | 100.0% | Color / Style / Size |
| `data.chars[].features[].value` | str | 100.0% | Multicolor / 4PCS MIXB / Color A |
| `data.chars[].img` | str? | 86.5% | https://m.media-amazon.com/images/I/81wnXqLqstL._AC_UL320_.j… / https://m.media-amazon.com/images/I/81Natp0u-0L._AC_UL320_.j… / https://m.media-amazon.com/images/I/81h1QQSdJ-L._AC_UL320_.j… |
| `data.chars[].price` | float? | 86.5% | 4.75 ~ 4545.08; 10.99 / 31.99 / 16.96 |
| `data.features` | array? | 45.0% | len 0~3 |
| `data.features[]` | object | 100.0% |  |
| `data.features[].code` | str | 100.0% | Specialsizetype / Size / Color |
| `data.features[].fetching` | bool | 100.0% | False |
| `data.features[].name` | str | 100.0% | Specialsizetype / Size / Color |
| `data.pasinBoughtHistory` | null | 0.0% |  |
| `data.pasinBoughtInPastMonth` | str? | 45.0% | 2,250+ / <50 / 100+ |
| `data.total` | int | 100.0% | 0 ~ 494; 372 / 1 / 3 |
| `message` | null | 0.0% |  |

#### `web-traffic-diagnose`

诊断流量：按词拆分的占比与归因

- **可用性**：✅ CLI 实测可用（0.5s，38,822 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8", "granularity": "month", "endDay": "2026-09", "pageNum": 1, "pageSize": 20, "sortBy": ""}`
- **字段表样本**：120 条历史成功响应（日志共 2061 条，2026-09-03 ~ 2026-09-20），打平 112 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object? | 95.0% |  |
| `data.details` | array | 100.0% | len 1~500 |
| `data.details[]` | object | 100.0% |  |
| `data.details[].affectBeforeRatio` | null | 0.0% |  |
| `data.details[].affectTotalScore` | float | 100.0% | 0.011364189075347475 ~ 398045.3706120059; 140.41632931574827 / 90.53426945439632 / 395.23570017945934 |
| `data.details[].affectWholeRatio` | float | 100.0% | -1.0 ~ 1.0; 0.35228339 / 0.20563758 / 0.17576442 |
| `data.details[].akScore` | null | 0.0% |  |
| `data.details[].akScoreBefore` | null | 0.0% |  |
| `data.details[].diffScore` | float | 100.0% | -11571.430326414744 ~ 52747.80100871629; 49.46634112953325 / 28.874874207798634 / 24.680194243733602 |
| `data.details[].diffScoreRatio` | float? | 64.8% | -1.0 ~ 1503.04133032; -1.0 / -0.78223573 / -0.47664234 |
| `data.details[].estSearchesNum` | int | 100.0% | 0 ~ 2062357; 4318 / 4358 / 1626 |
| `data.details[].focus` | bool | 100.0% | False |
| `data.details[].groups` | null | 0.0% |  |
| `data.details[].isChanged` | bool | 100.0% | True / False |
| `data.details[].keyword` | str | 100.0% | rattan roll / cane webbing / cane webbing roll |
| `data.details[].pchangeReason` | object | 100.0% |  |
| `data.details[].pchangeReason.acInfo` | null | 0.0% |  |
| `data.details[].pchangeReason.brandInfo` | str? | 5.4% | 0_5 / 0_2 / 0_1 |
| `data.details[].pchangeReason.erInfo` | null | 0.0% |  |
| `data.details[].pchangeReason.isChanged` | bool | 100.0% | True / False |
| `data.details[].pchangeReason.nfInfo` | object | 100.0% |  |
| `data.details[].pchangeReason.nfInfo.beforeInFre` | int? | 95.9% | 0 ~ 31; 0 / 8 / 5 |
| `data.details[].pchangeReason.nfInfo.begoreRankAvg` | int? | 95.9% | 0 ~ 144; 0 / 135 / 133 |
| `data.details[].pchangeReason.nfInfo.change` | str? | 1.7% | 45_43 / 50_51 / 23_24 |
| `data.details[].pchangeReason.nfInfo.in` | str? | 0.9% | 77 / 112 / 131 |
| `data.details[].pchangeReason.nfInfo.inFre` | int? | 95.9% | 0 ~ 31; 1 / 0 / 5 |
| `data.details[].pchangeReason.nfInfo.isChanged` | bool | 100.0% | True / False |
| `data.details[].pchangeReason.nfInfo.out` | str? | 1.3% | 22 / 88 / 17 |
| `data.details[].pchangeReason.nfInfo.rankAvg` | int? | 95.9% | 0 ~ 144; 100 / 98 / 97 |
| `data.details[].pchangeReason.otherRecommendedInfo` | null | 0.0% |  |
| `data.details[].pchangeReason.recSpInfo` | str? | 27.7% | 0_1 / 0_2 / 0_3 |
| `data.details[].pchangeReason.sbInfo` | str? | 5.4% | 0_5 / 0_2 / 0_1 |
| `data.details[].pchangeReason.sbvInfo` | str? | 11.4% | 0_2 / 0_5 / 0_1 |
| `data.details[].pchangeReason.spInfo` | object | 100.0% |  |
| `data.details[].pchangeReason.spInfo.beforeInFre` | int? | 95.9% | 0 ~ 29; 0 / 2 / 1 |
| `data.details[].pchangeReason.spInfo.begoreRankAvg` | int? | 95.9% | 0 ~ 36; 0 / 24 / 20 |
| `data.details[].pchangeReason.spInfo.change` | null | 0.0% |  |
| `data.details[].pchangeReason.spInfo.in` | str? | 0.1% | 21 / 36 / 5 |
| `data.details[].pchangeReason.spInfo.inFre` | int? | 95.9% | 0 ~ 30; 2 / 6 / 5 |
| `data.details[].pchangeReason.spInfo.isChanged` | bool | 100.0% | True / False |
| `data.details[].pchangeReason.spInfo.out` | str? | 0.1% | 24 / 5 / 7 |
| `data.details[].pchangeReason.spInfo.rankAvg` | int? | 95.9% | 0 ~ 36; 7 / 11 / 10 |
| `data.details[].pchangeReason.trInfo` | null | 0.0% |  |
| `data.details[].pchangeReason.vedioInfo` | str? | 11.4% | 0_2 / 0_5 / 0_1 |
| … 另有 67 个字段 | | | 见 `_schemas.json` |

#### `web-variant-ad-keywords`

变体投放词 + 广告位/活动计数

- **可用性**：✅ CLI 实测可用（0.99s，1,748,070 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8", "pageNum": 1, "pageSize": 100, "timePieceType": "latelyDay", "timePieceValue": "30"}`
- **字段表样本**：14 条历史成功响应（日志共 112 条，2026-08-25 ~ 2026-09-20），打平 86 个字段
- **⚠️ 动态 key**：以下路径是「以业务值为 key 的 map」，不是数组，ETL 要先 `jsonb_each` 展开：
    - `data.keywords[].nfHistory` 的 key 是 {asin}
    - `data.keywords[].spHistory` 的 key 是 {asin}

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.adIdTotalNum` | int | 100.0% | 10 ~ 654; 654 / 10 / 38 |
| `data.campaignIdTotalNum` | int | 100.0% | 1 ~ 32; 11 / 1 / 7 |
| `data.estDate` | null | 0.0% |  |
| `data.etymaInfo` | object | 100.0% |  |
| `data.etymaInfo.adIdTotalNum` | int | 100.0% | =0; 0 |
| `data.etymaInfo.campaignIdTotalNum` | int | 100.0% | =0; 0 |
| `data.etymaInfo.estSearchesTotalNum` | int | 100.0% | =0; 0 |
| `data.etymaInfo.kwsSpScoreRatio` | float | 100.0% | =0.0; 0.0 |
| `data.etymaInfo.total` | int | 100.0% | =0; 0 |
| `data.etymaInfo.variantTotalNum` | int | 100.0% | =0; 0 |
| `data.granularity` | null | 0.0% |  |
| `data.keywords` | array | 100.0% | len 50~100 |
| `data.keywords[]` | object | 100.0% |  |
| `data.keywords[].adIdNum` | int | 100.0% | 1 ~ 14; 1 / 3 / 4 |
| `data.keywords[].adIds` | array | 100.0% | len 1~14 |
| `data.keywords[].adIds[]` | str | 100.0% | A0992043EV6JYTSDQFJY / A103505424JYU2LWB7YDW / A04396113GNEOIRF0CVZ4 |
| `data.keywords[].asins` | array | 100.0% | len 1~14 |
| `data.keywords[].asins[]` | str | 100.0% | B0FDK6V3BF / B0FDKBC2H1 / B0FDKBBN3K |
| `data.keywords[].campaignIdNum` | int | 100.0% | 1 ~ 5; 1 / 2 / 3 |
| `data.keywords[].campaignIds` | array | 100.0% | len 1~5 |
| `data.keywords[].campaignIds[]` | str | 100.0% | A0608368MQQXYZ1ZCXR / A08784213JU18VOF9KVSO / A00772773TZ8B1ANTTDCI |
| `data.keywords[].clickPurchaseRatio` | float? | 24.6% | 0.0 ~ 0.04383562; 0.00137493 / 0.00282381 / 0.00232065 |
| `data.keywords[].estSearchesNum` | int? | 90.6% | 126 ~ 129078; 95412 / 122848 / 27080 |
| `data.keywords[].estSearchesNumHistory` | object | 100.0% |  |
| `data.keywords[].estSearchesNumHistory.date` | array | 100.0% | len 37~37 |
| `data.keywords[].estSearchesNumHistory.date[]` | str | 100.0% | 2025-12-28 / 2026-01-04 / 2026-01-11 |
| `data.keywords[].estSearchesNumHistory.estSearchesNum` | array | 100.0% | len 37~37 |
| `data.keywords[].estSearchesNumHistory.estSearchesNum[]` | int? | 81.9% | 126 ~ 595096; 90836 / 83581 / 90981 |
| `data.keywords[].estSearchesNumHistory.festivals` | array | 100.0% | len 37~37 |
| `data.keywords[].estSearchesNumHistory.festivals[]` | array? | 35.1% | len 1~1 |
| `data.keywords[].estSearchesNumHistory.festivals[][]` | object | 100.0% |  |
| `data.keywords[].estSearchesNumHistory.festivals[][].endDate` | str | 100.0% | 2026-02-14 / 2026-03-08 / 2026-03-31 |
| `data.keywords[].estSearchesNumHistory.festivals[][].name` | str | 100.0% | 情人节 / 妇女节 / 春季大促 |
| `data.keywords[].estSearchesNumHistory.festivals[][].startDate` | str | 100.0% | 2026-02-14 / 2026-03-08 / 2026-03-25 |
| `data.keywords[].estSearchesNumHistory.searchesNumChangeRatio` | array | 100.0% | len 37~37 |
| `data.keywords[].estSearchesNumHistory.searchesNumChangeRatio[]` | float? | 68.8% | -1.0 ~ 82.77326969; 0.31682637 / 0.27729384 / 0.42077894 |
| `data.keywords[].estSearchesNumHistory.searchesRank` | array | 100.0% | len 37~37 |
| `data.keywords[].estSearchesNumHistory.searchesRankChangeRatio` | array | 100.0% | len 37~37 |
| `data.keywords[].estSearchesNumHistory.searchesRankChangeRatio[]` | float? | 68.8% | -296.25793651 ~ 1.0; 0.33646743 / 0.31358638 / 0.39094488 |
| `data.keywords[].estSearchesNumHistory.searchesRank[]` | int? | 81.9% | 51 ~ 3371676; 1976 / 1935 / 1547 |
| `data.keywords[].estSearchesNumHistory.selectDate` | null | 0.0% |  |
| `data.keywords[].estSearchesNumHistoryPrev` | object | 100.0% |  |
| `data.keywords[].estSearchesNumHistoryPrev.date` | array | 100.0% | len 53~53 |
| … 另有 41 个字段 | | | 见 `_schemas.json` |

### virtual —— CLI 虚拟聚合接口

#### `asin-overview`

CLI 虚拟接口：basic+stats+listing 三合一

- **可用性**：✅ CLI 实测可用（0.52s，3,894 B）
- **本次实调入参**：`{"asin": "B0FVNPKGJ8"}`
- **字段表样本**：120 条历史成功响应（日志共 7058 条，2026-08-06 ~ 2026-09-20），打平 57 个字段

| 路径 | 类型 | 填充率 | 取值范围 / 样例 |
|---|---|---:|---|
| `code` | int | 100.0% | =1; 1 |
| `data` | object | 100.0% |  |
| `data.asin` | str | 100.0% | B0H6JM86RZ / B0H44N9H9N / B0H154KVKZ |
| `data.basic` | array | 100.0% | len 1~1 |
| `data.basic[]` | object | 100.0% |  |
| `data.basic[].asin` | str | 100.0% | B0H6JM86RZ / B0H44N9H9N / B0H154KVKZ |
| `data.basic[].bestSellers` | null | 0.0% |  |
| `data.basic[].bestSellersTime` | null | 0.0% |  |
| `data.basic[].boughtInPastWeek` | null | 0.0% |  |
| `data.basic[].brand` | null | 0.0% |  |
| `data.basic[].brandLink` | null | 0.0% |  |
| `data.basic[].buyBox` | null | 0.0% |  |
| `data.basic[].buyBoxLink` | null | 0.0% |  |
| `data.basic[].category` | null | 0.0% |  |
| `data.basic[].img` | str? | 79.2% | https://m.media-amazon.com/images/I/71RQbDPJzHL._AC_UL320_.j… / https://m.media-amazon.com/images/I/81O+6-NmLZL._AC_UL320_.j… / https://m.media-amazon.com/images/I/71gVWt-iN1L._AC_UL320_.j… |
| `data.basic[].isBestSeller` | null | 0.0% |  |
| `data.basic[].isCoupon` | null | 0.0% |  |
| `data.basic[].isFocus` | bool | 100.0% | False |
| `data.basic[].isLimitedTimeDeal` | null | 0.0% |  |
| `data.basic[].isLowest30` | null | 0.0% |  |
| `data.basic[].price` | float? | 79.2% | 5.59 ~ 1348.86; 42.55 / 15.99 / 19.99 |
| `data.basic[].ratingNum` | int? | 69.2% | 2 ~ 5754; 98 / 15 / 147 |
| `data.basic[].score` | float? | 69.2% | 3.5 ~ 5.0; 4.5 / 3.7 / 4.4 |
| `data.basic[].star` | float? | 69.2% | 3.5 ~ 5.0; 4.5 / 3.5 / 4.0 |
| `data.basic[].title` | str? | 79.2% | 15 Inch Acacia Wood Scalloped Pedestal Counter Tray, Brown R… / Jexine 500 Pcs Colorful Craft Feathers Bulk, 5 Styles Mixed … / Geelin Fall Paper Towel Holder Wooden Paper Stand for Kitche… |
| `data.country` | str | 100.0% | US / DE |
| `data.listing` | object? | 98.3% |  |
| `data.listing.asins` | array | 100.0% | len 1~4 |
| `data.listing.asins[]` | object | 100.0% |  |
| `data.listing.asins[].ac` | int | 100.0% | 0 ~ 100; 0 / 1 / 2 |
| `data.listing.asins[].acBest` | bool | 100.0% | False / True |
| `data.listing.asins[].ad` | int | 100.0% | 0 ~ 960; 0 / 2 / 26 |
| `data.listing.asins[].adBest` | bool | 100.0% | False / True |
| `data.listing.asins[].asin` | str | 100.0% | B0H6JM86RZ / B0H44N9H9N / B0H44YS55R |
| `data.listing.asins[].brand` | int | 100.0% | 0 ~ 943; 0 / 257 / 124 |
| `data.listing.asins[].brandBest` | bool | 100.0% | False / True |
| `data.listing.asins[].brandVedio` | int | 100.0% | 0 ~ 943; 0 / 1 / 14 |
| `data.listing.asins[].brandVedioBest` | bool | 100.0% | False / True |
| `data.listing.asins[].features` | array? | 81.1% | len 1~2 |
| `data.listing.asins[].features[]` | str | 100.0% | Colorful / Bright / Black |
| `data.listing.asins[].isFocus` | bool | 100.0% | False |
| `data.listing.asins[].natural` | int | 100.0% | 0 ~ 402; 6 / 1 / 7 |
| `data.listing.asins[].naturalBest` | bool | 100.0% | True / False |
| `data.listing.asins[].rec` | int | 100.0% | 0 ~ 355; 0 / 2 / 11 |
| `data.listing.asins[].recBest` | bool | 100.0% | False / True |
| … 另有 12 个字段 | | | 见 `_schemas.json` |

<!-- END GENERATED -->

---

## 8. 如何复现

三个脚本，各管一件事：

**① 判定可用性（§3）—— 实际调 CLI**

```bash
python scripts/sif_sweep.py B0FVNPKGJ8 --country US --out /tmp/sifout --retry-fresh
```

43 个 endpoint 逐个实调，约 60 秒。`--retry-fresh` 让每个非 OK 结果自动再用 `--fresh`
打一次，排除「缓存里存的是旧失败」。输出按结论分档：

| verdict | 含义 |
|---|---|
| `OK` | 拿到非空业务数据 |
| `OK_BUT_EMPTY` / `OK_BUT_NULL` | `code=1` 但 `data` 是空容器或全 null |
| `DEAD_404` | `HTTP 404`，路由已移除 |
| `BAD_PARAMS` | `code=-1`，入参不合法 |

**正确入参全部写在 `build_jobs()` 里**，改入参改那里。

**② 推断字段结构（§7）—— 采样历史响应**

```bash
python scripts/sif_schema_probe.py --limit 120 --json /tmp/sifout/_schemas.json
python scripts/sif_schema_probe.py --endpoint web-sales-asin --limit 200  # 单个
```

这一步**必须读日志**而不是单次 CLI 响应：填充率要靠上百条样本才有意义，
单次调用只能看到一种形态。

**③ 回填本文档的 §7 字段表**

```bash
python scripts/sif_gen_schema_doc.py \
    --schemas /tmp/sifout/_schemas.json \
    --out docs/SIF_API_SCHEMA.md --max-rows 45
```

只替换 `BEGIN/END GENERATED` 之间的内容，§1–6 手写部分不动，可重复执行。

> **注意**：`sif` 不在 PATH 上，它是 Python 包（`sif-cli 2.1.0`），
> 入口是 `python -m sif_cli`。三个脚本都已按此调用。
>
> §7 采样用 `ORDER BY id DESC LIMIT n`，是**滑动窗口** —— 两次运行间若有新日志写入，
> 样本量与填充率会有小幅变动（实测 <5pp），字段路径与类型集合不受影响。
>
> **换 ASIN 复测时**：§3 的可用性结论会因 ASIN 而异（新品的数据本来就少），
> `OK_BUT_EMPTY` 尤其如此 —— 判断是接口问题还是该 ASIN 无数据，要换几个 ASIN 对照，
> 或查日志里该 endpoint 是否曾返回过非空（本文档对那 2 个就是这样判定的）。
