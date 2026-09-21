# sif.com「AI工具 / 关键词调研」功能审计（/skill/keywords-library）

- 审计日期：2026-09-21
- 探查方式：静态分析 sif.com 前端 JS bundle（主站 `https://www-static.sif.com/static/js/app.b278f717.js`、子应用 `https://www.sif.com/assets/index-i9To303R.js`、共享库 `https://www.sif.com/shared/sif-services.js`）+ 已登录 JWT 直调只读 GET API。
- 红线遵守：全程只使用 GET 与只读查询接口，未提交任何任务、未消耗任何积分。
- 注：关键词调研是独立 Vite 子应用（非主站 SPA 的一部分），入口页面 `https://www.sif.com/skill/keywords-library`，页面 `<title>关键词调研</title>`（来源：`GET /skill/keywords-library` 返回 HTML）。

## 功能定位（官方介绍原文）

- `GET /api/sys/modelIntroduce/search?country=US&model=keywordsLibrary`（及 keywordResearch / keywords-library / keyword / skill / KeywordsLibrary / keyword_library / keywords_library 等 15+ 个变体）全部返回：
  `{"code":1,"data":{"model":null,"headline":null,"content":null,"introduce":null,"mustRead":null}}`
  即该模块在 modelIntroduce 体系下**没有登记任何官方介绍文案**；页面本身也没有"功能介绍"区块，标题只有「关键词调研」。
- 功能实质（依据子应用 JS 中的 8 步管道文案，来源：`/assets/index-i9To303R.js`）：
  输入 1~100 个竞品 ASIN + 站点，AI 管道自动完成「核心自然流量词获取 → 同类竞品扩展 → 竞品确认 → 相关性标准确认 → 竞品维度拓词与相关性计算 → 关键词点击/转化/建议竞价数据获取 → 生成 xlsx 导出文件」的全流程关键词调研。

## 可用 skill 清单

来源：主站导航菜单配置（`app.b278f717.js` 中「AI工具」菜单项，路由字符串 `"/skill/keywords-library"`）。

「AI工具」菜单下共 3 项，均已验证 HTTP 200 可达：

| 菜单名 | 路由 | 形态 |
|---|---|---|
| 关键词调研 | `/skill/keywords-library`（新标签页打开） | 独立 Vite 子应用，WS 管道驱动 |
| API数据服务 | `/datacenter`（新标签页） | 独立页面 |
| MCP服务 | `/mcp`（新标签页） | 独立页面（对外 MCP 接入） |

`/skill/` 前缀下只发现 `keywords-library` 这一个 skill 页面；其余 AI 能力走 /datacenter（API 服务）与 /mcp（MCP 服务）两条产品线。

## 表单/请求结构

### 1. 输入表单（来源：`/assets/index-i9To303R.js` 表单组件反编译）

- **输入项**：ASIN 文本框 + 站点选择器。
- **ASIN 解析**：按空白/英文逗号/分号/中文逗号/中文分号/换行切分，trim 后转大写；校验正则 `/^[A-Z0-9]{10}$/`；自动去重。
- **数量上限**：常量 `Hi=100`，超限提示「最多支持 100 个 ASIN，当前输入 N 个」；空输入提示「请输入至少一个 ASIN」，非法格式提示「xxx 不是有效的亚马逊ASIN」。
- **可选站点（13 个）**：US 美国、DE 德国、UK 英国、JP 日本、CA 加拿大、IT 意大利、FR 法国、ES 西班牙、AU 澳大利亚、MX 墨西哥、AE 阿联酋、BR 巴西、SA 沙特。默认 US，站点选择持久化在 localStorage（`last_country`），URL `?country=XX` 可覆盖。
- **关联域名映射**（`Dh` 常量）：US→www.amazon.com、UK→www.amazon.co.uk、JP→www.amazon.co.jp 等 13 项，用于「访问亚马逊」跳转链接 `{域}/dp/{keyword 所属 ASIN}`。

### 2. 执行通道：不是 HTTP 提交，而是 WebSocket 管道

- 连接地址：`wss://www.sif.com/ws/pipeline`（连接超时 10s 判失败）。鉴权用 localStorage 里的 token，随首条消息发送，且服务端每条消息可通过 `resp_headers.authorization` 下发新 token，客户端回发 `{type:"update_token"}` 同步。
- **客户端 → 服务端消息**：
  - 启动：`{"type":"start","asins":[...],"country":"US","token":"<jwt>"}`
  - 应答确认：`{"type":"input_response","step":<n>,"data":{"action":"continue"|"abort"[,"selected_keywords":[...]]}}`
  - 中止：`{"action":"abort"}`；继续：`{"action":"continue","selected_keywords":[...]}`
- **服务端 → 客户端消息类型**：`step_start`（含 step/name）、`step_progress`（inline 进度文案）、`step_partial_detail`（流式部分结果）、`step_complete`（含 detail）、`step_skipped`（含 reason）、`input_required`（含 config/input_type/api_call/resp_status）、`pipeline_complete`（含 summary）、`pipeline_aborted`、`error`、`api_raw_data`（原始 API 调用日志，前端有 rawApiLogs 调试面板）。

### 3. AI 管道 8 个步骤（`Eh` 常量，requiresInput=需人工确认）

| # | 步骤名 | 需确认 |
|---|---|---|
| 0 | 获取ASIN的核心自然流量词 | 否 |
| 1 | 基于核心自然流量词拓展更多相似竞品 | 否 |
| 2 | 确认扩展之后的竞品列表（input_type=`competitor_confirm`，提示「竞品数量越多，自动计算相关性越准确。不相关的产品可点击×移除，建议至少保留48个」） | 是 |
| 3 | 获取相关性区分的默认标准（返回 current_thresholds） | 否 |
| 4 | 确认本次任务的相关性区分标准（input_type=`keyword_quality_confirm`，提示「请设置相关性判定标准」） | 是 |
| 5 | 竞品维度拓词并自动计算相关性 | 否 |
| 6 | 获取关键词的点击转化率、建议竞价等数据 | 否 |
| 7 | 生成导出文件 | 否 |

### 4. 关键数据结构（detail / summary 字段）

- 核心流量词表（step 0 detail.keyword_details[]）：`keyword`、`translate_keyword`（中文翻译）、`rank_score`（7天综合自然排名）、`est_searches_num`（周搜索量）；表头文案：关键词/中文翻译/7天综合自然排名/周搜索量。
- 竞品确认（step 2 detail.keyword_products，按产品分组）：`items[]`、`translate_keyword`；关键词质量确认表字段：`keyword`、`translate_keyword`、`rank_score`，默认勾选前 5 个，可全选/反选，continue 时回传 `selected_keywords`。
- 相关性阈值对象：`current_thresholds` / `updated_thresholds` = `{high, mid, low}`，四级分类文案：高相关 / 中相关 / 低相关 / 几乎不相关（阈值区间展示「相关性 ∈ [a,b)，高相关」等）。
- 拓词 detail：`keywords[]`、`total_keywords`、`total_before_dedup`（去重前总量）、`relevance_breakdown`、`selected_count`、`filename`、`size_mb`。
- pipeline_complete.summary：`total_competitors`、`total_keywords`、`high_relevance`、`medium_relevance`、`low_relevance`、`irrelevant`、`download_filename`、`download_size_bytes`、`download_size_mb`、`download_data`（xlsx 文件内容，前端生成下载卡片「btn-download」）。

### 5. 配套 REST 接口

子应用仅调用 2 个 HTTP 接口：`GET /api/user/basic/info`（登录态/会员信息，封装于 `/shared/sif-services.js` 的 SifServices + axios 拦截器，code -10 未登录、-26 锁定、3107/3117 触发会员到期弹窗）；其余全部走 `/ws/pipeline`。

## 积分与限制

- **本页无积分消耗展示**：关键词调研子应用 JS 中不存在「积分/点数/消耗/扣除/免费」等任何文案，也没有积分扣减接口调用。积分账户体现在用户信息接口。
- `GET /api/user/basic/info`（实测）返回关键字段：`integral: 100.0`（积分数值字段名）、`vipLevel: "shark"`、`vipLevelSec: "trial"`、`isVipTrial: true`、`memberStatus: "none"`、`expirationDate: "2026-09-22 23:59:59"`、`isValidVip: true`。即积分模型 = 账户级 `integral` 余额 + 会员等级/有效期门禁；共享拦截器中 code 3107/3117 会触发「会员已到期，需要重新购买会员」弹窗（来源：`/shared/sif-services.js` createAIResponseSuccessHandler）。
- 限制汇总：单次任务 ≤100 个 ASIN（前端校验）；相关性确认建议保留 ≥48 个竞品；WS 连接 10s 超时；错误码 4001/4003 对应 401/403 鉴权失败。
- FAQ 类接口 `GET /api/sys/faq/search`、`/api/sys/problem/search`、`/api/sys/help/list`、`/api/sys/question/list` 等均 404，站点无该模式 FAQ 接口；modelIntroduce 亦无本模块内容。故"每次任务扣多少积分"无法从前端/公开接口确认，推测由服务端在 pipeline 内部计费。

## 对 Looom 实现的建议

1. **采用「WebSocket 任务管道 + 分步人工确认」而非一次性异步任务**：sif 把关键词调研拆成 8 个可观测步骤（start/progress/partial_detail/complete 事件流），并在竞品列表与相关性标准两处设人工确认点。Looom 可复刻该协议骨架（`step_*` 事件 + `input_required` + `input_response`），既降低长任务黑盒感，又把「AI 结果不可信」的风险交给用户把关（竞品 ≥48 提示、阈值可改）。
2. **表单与数据模型可直接对标**：ASIN ≤100、`/^[A-Z0-9]{10}$/`、13 站点（注意 sif 用 UK 而非 GB）；输出四级相关性（high/mid/low/irrelevant + 可调阈值 `{high,mid,low}`）、`total_before_dedup` 去重口径、`est_searches_num`（周搜索量）与 `rank_score`（7 天自然排名）两个核心指标命名值得沿用，导出走 xlsx（含 download_size 展示）。
3. **计费与鉴权设计**：积分作为账户级余额字段（如 sif 的 `integral`）+ VIP 等级/到期双门禁，计费在服务端 pipeline 内部完成、前端不展示单价；token 刷新可通过 WS 消息头回传（sif 的 `resp_headers.authorization` + `update_token` 机制），值得借鉴。
4. **注意**：sif 该模块无官方介绍文案、无 FAQ 接口，说明其把"教育成本"放在流程内提示（步骤名即说明）而非文档页；Looom 若做同类功能可按需补充。

---

### 附：来源接口/资产清单

| 结论 | 来源 |
|---|---|
| AI工具菜单 3 项、/skill 仅 keywords-library | `https://www-static.sif.com/static/js/app.b278f717.js` |
| 页面标题、子应用入口 | `GET https://www.sif.com/skill/keywords-library`（HTML → /assets/index-i9To303R.js） |
| 官方介绍为空 | `GET /api/sys/modelIntroduce/search?country=US&model=<15+变体>` 均返回 null |
| 表单/校验/上限/站点/域名映射/8步管道/WS协议/数据结构 | `https://www.sif.com/assets/index-i9To303R.js` |
| axios 封装、错误码语义、token 同步 | `https://www.sif.com/shared/sif-services.js` |
| 积分字段 integral、会员信息 | `GET /api/user/basic/info` |
| FAQ 接口不存在 | `GET /api/sys/faq/search`、`/api/sys/problem/search` 等均 404 |
