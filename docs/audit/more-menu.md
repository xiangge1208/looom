# sif.com「更多」菜单 4 功能审计（批量备注 / 实时查产品竞价 / API数据服务 / MCP服务）

- 审计日期：2026-09-21
- 探查方式：静态分析主站前端 bundle（`https://www-static.sif.com/static/js/app.b278f717.js`、`manifest.e95d6ed3.js`，懒加载 chunk 命名 `<id>.<hash>.js`）+ 直调 sif.com 只读 API（GET / 明显查询型 POST 均有标注）+ 公开网关 `GET /mcp-api/catalog`、`GET /mcp-api/config`。
- 红线遵守：全程未调用任何写入用户数据的接口。`/api/user/adNote/batchUpsert`、`/api/search/cpc/create` 等写接口仅做静态分析，**从未实际调用**。
- ⚠️ 重要环境说明：任务提供的 JWT（exp=2026-09-26，尚未到期）在本次审计中对所有需登录接口返回 `{"code":-10,"message":"UNAUTHORIZED"}`（验证过 `authorization` 原样 / `Bearer` / `token` / `x-token` 四种头格式 + 带 `country=US` 参数，均 401；同 token 对公开接口 `modelIntroduce` 正常返回，说明请求格式正确、是服务端会话失效，可能 userSalt 已轮换）。因此：**接口 schema 全部来自前端代码静态反推，未能做在线参数验证**；公开接口（modelIntroduce、/mcp-api/*）的返回均为实测。

---

## 更多菜单总览

来源：`app.b278f717.js` 顶部导航配置（`label:"更多"` 对象）。

当前导航实际结构（与任务假设略有出入，需修正认知）：

| 顶级菜单 | 子项 | 路由 | 说明 |
|---|---|---|---|
| **更多** | 前台广告位溯源后台广告活动（批量备注） | `/ad-multiNotes-submit` | activeUrls 含 `/cpc-realtime`、`/adxray-productTarget`、`/ad-multiNotes-view` |
| | 管理已备注的广告活动 | `/ad-multiNotes-view` | |
| | 实时查产品竞价 | `/cpc-realtime` | 路由 meta.title =「实时查产品竞价-Sif」 |
| | 查ASIN定位广告 | `/adxray-productTarget` | 任务未提及的第 4 项，本次未深挖 |
| **AI工具** | 关键词调研 / **API数据服务** / **MCP服务** | `/skill/keywords-library` / `/datacenter` / `/mcp` | API数据服务与MCP服务实际挂在「AI工具」组下，不在「更多」内（来源：app.js `label:"AI工具"` 导航对象；`MCP/API` 触发按钮文案 `ext_nav mcp-api-trigger`，chunk 9） |

- 「更多」4 项中前 3 项共享高亮 activeUrls，可视为一个"运营辅助工具"功能族。
- modelIntroduce 覆盖情况（来源：`GET /api/sys/modelIntroduce/search`，2026-09-21 实测 + 详见 `model-introductions.md`）：`adBatchNote`、`cpcList` 命中官方介绍（见下文各节）；`multiNotes` 仅存在于前端映射表、后端未配置；`apiService`/`mcpService`/`cpcRealtime`/`adMultiNotes` 等猜测名均不存在。这 4 个功能属于"工具/营销页"，不在 Sif 的官方介绍面板体系主打范围内。

---

## 实时查产品竞价（表单/接口/积分）

路由 `/cpc-realtime`，页面代码 chunk 63（`static/js/63.a7445bb3.js`）。

### 官方定位（来源：modelIntroduce `model=cpcList`，实测 2026-09-21）

- **"准确的讲，查询的是产品在关键词下的建议竞价，不是点击的 CPC，也不是卖家的出价"**（必读第1条，`$建议竞价^` 为强调词）。
- SP 竞价策略中「仅降低」与「固定」的建议竞价差别极小 → Sif **合并为"仅降低/固定"** 一档（必读第2条）。
- 建议竞价的**查询时间依据同时查询的任务量而变化，需要等待**（必读第3条）→ 说明后端是排队/抓取式而非即时返回。
- 关联模块：`cpcCategory`（/cpc-browsetree 类目竞价）：建议竞价**与产品无关、与品类强相关**，以周 ABA 为数据源、每月更新（来源：model-introductions.md §cpcCategory）。
- 推荐阅读：图文教程（feishu doxcnv6ghbl6D8g3hRuSxd7jdLf）、详解视频 videoId=31、秒懂视频 videoId=30。

### 表单/交互（来源：chunk 63 UI 字符串）

- 任务制，两种任务类型（`taskType`，创建参数 `type: 1==taskType?0:1`）：
  - **自动推荐**（type:0）：「查询亚马逊自动推荐的广告词」「自动推荐亚马逊最多返回200个关键词」；
  - **手动输入关键词**（type:1）：「多个关键词可换行；或直接从Excel按列批量复制粘贴」，且「已自动帮您填充上次查询的关键词，您可以增加或者删除」（关键词历史回填）。
- 「输入ASIN 查询历史记录」（ASIN 维度任务历史）；有「免费示例」入口。
- 结果维度（UI 字符串）：匹配模式 **精准/词组/广泛**，广告类型 **SP/SB**，竞价档 **提升与降低SP / 仅降低/固定SP**；「查看建议竞价」「下载建议竞价」；辅助指标：关键词竞品数量、ABA Top3集中度、搜索趋势、流量位竞争格局、查询时间。
- 「该关键词未进入ABA」为数据缺失场景；「搜索无结果可能的2个原因：1.没有添加该 ASIN 任务 2.请检查站点选择是否正确」→ 查询前必须先建 ASIN 任务。
- 会员墙：「实时查产品竞价」「该功能为旗舰会员专享」→ **旗舰（最高档）会员专享**。

### 接口 schema（来源：chunk 63 api 模块；方法字母经三重交叉验证：写接口全走 `s.b`=POST、modelIntroduce/user-info 走 `s.a`=GET）

| 接口 | 方法 | 用途/已知参数 |
|---|---|---|
| `/api/search/cpc/asinTaskList` | GET | 我的 ASIN 任务列表（**因 token 失效未实测**） |
| `/api/search/cpc/createCheck` | GET | 创建前校验（dry-run，未调用） |
| `/api/search/cpc/create` | POST | **创建查询任务（写接口，未调用）**。payload（chunk 63 反推）：`{type:0|1, asin, keywords:[...]}` |
| `/api/search/cpc/deleteTask` | GET | 删除任务 |
| `/api/search/cpc/refreshTaskStatus` | POST | 刷新任务状态（「刷新状态」按钮） |
| `/api/search/cpc/list` | POST | 任务结果列表 |
| `/api/search/cpc/detail` | POST | 任务详情（导出：`GET /api/updown/cpcDetail/download`，blob） |
| `/api/search/cpc/detailKeyword` | POST | 单关键词详情（导出：`GET /api/updown/cpcKeywordDetail/download`） |
| `/api/search/cpc/category` | POST | 类目列表（导出：`GET /api/updown/cpcCategory/download`） |

### 积分/配额（来源：chunk 63）

- 并发任务数限制读自用户角色：`role_integral_limit || 2`（接口响应字段，默认 2 个任务）——即免费/低档角色同时最多挂 2 个 ASIN 任务。
- 创建入口受旗舰会员门（TrialGate 类组件，见 model-introductions.md 的付费门体系）。
- 结果页支持「对比多次查询」→ 同 ASIN 可多次建任务留存历史。

---

## 广告活动批量备注

两个页面：提交 `/ad-multiNotes-submit`（chunk 83，`static/js/83.3a556eb9.js`）+ 管理 `/ad-multiNotes-view`（chunk 62，`static/js/62.c3da21a3.js`）。

### 官方定位（来源：modelIntroduce `model=adBatchNote`，实测）

- headline：「备注广告活动」有什么用？；秒懂视频：*通过Sif插件，在前台广告位溯源后台广告活动*（videoId=35）。
- 推荐阅读即两种方式：①《自动同步广告活动》（feishu EOn5dn6eOomfr1xWj8icukSvnfe）②《手动批量备注》（feishu EQDjdssKeoW8YNxFwqIcGW37nCe）。

### 提交页（chunk 83 UI 字符串）

- **方式一（推荐）：通过 Sif 浏览器插件自动同步**——「下载最新版插件」→「同步到Sif」→「查看已同步的广告活动」。
- **方式二：从亚马逊后台手动复制粘贴**——粘贴「广告活动编号和广告活动名称」；「未查到该广告活动的站点信息，请手动选择站点」→ 粘贴内容仅含 编号+名称，**站点由 Sif 按编号反查，查不到才让用户手选**。
- 安心话术：「不绑定后台，可放心使用」→ **不通过 Amazon API/授权对接**，纯前台数据。
- 行内操作：「+添加新行」「清空本行」「清空重填」「设置背景色」「查看原备注」；「批量快速备注指南」（feishu + 引导图 `Picture/Guide/muitiplenotes.jpg`、`muiltinote02.png`、`onestep/twostep/threestep.png`）。
- 去重规则（提交页文案）：**「该广告活动备注已存在，重复提交只保留最新版本」**→ upsert 语义，按广告活动维度覆盖。
- 表单字段（chunk 83 反推）：广告活动编号（后台 A0 开头 ID，变量 `idA0`）、前台纯数字 ID（`fakeCampaignId`/`encryptCampaignId`，Sif 侧加密映射）、广告活动名称、所属站点、备注内容、背景色（`colorid` → `backgroundColor` 渲染）。

### 管理页（chunk 62 UI 字符串）

- 定位：「可以在该页面查看并批量管理您已经添加的备注，比如将相同的投放模式统一为同样的背景色」；「总共备注了 N 个广告活动」「N 个正在进行中的广告活动」。
- 区分两类：**竞品的广告活动 / 自己产品的广告活动**；「用来区分不同的投放模式/品牌等」。
- 列表字段：序号、备注名称（=广告活动名称）、广告活动编号（后台A开头ID + 前台纯数字ID 双列）、所属站点、投放的产品、备注时间、备注背景色。
- 批量操作：全选、批量修改背景色、批量删除、批量添加更多备注（跳回提交页）、搜索、单个删除；「免费示例」示例数据。
- 数据兜底：「在Sif无法对应广告活动的两种情况」+「查看解决方案」（feishu EBqjd70yfo4wFuxHQAHcTLRjnwd 等）→ 存在 Sif 侧查不到对应关系的脏数据场景。

### 接口 schema（来源：app.js api 模块；`s.a`=GET、`s.b`=POST 已交叉验证）

| 接口 | 方法 | 用途 |
|---|---|---|
| `/api/user/adNote/extraInfo` | GET | 附加信息（未调用） |
| `/api/user/adNote/id` | GET | 按 ID 查（未调用） |
| `/api/user/adNote/list` | POST | 已备注列表（查询型 POST，因 token 失效未实测；参数反推含 country/site、竞品/自有类型筛选、分页） |
| `/api/user/adNote/upsert` | POST | 单条写入（**写接口，未调用**） |
| `/api/user/adNote/batchUpsert` | POST | 批量写入/同步（**写接口，未调用**；提交页/插件同步最终走这里） |
| `/api/user/adNote/delete` | POST | 删除（未调用） |
| `/api/user/adNote/batchUpdateColor` | POST | 批量改背景色（未调用） |
| `/api/user/adNote/updateByid` | POST | 按 ID 更新（未调用） |

- 数据模型与已知的 `sys_user_ad_note` 概念吻合：user_id + campaign 标识（后台 A0 ID / 前台数字 ID 双键）+ 站点 + 备注文本 + 颜色 + 类型（竞品/自有）+ 时间；写入全走 upsert（幂等覆盖）。
- 配套：跨页高亮渲染依赖「前台广告位溯源」能力——插件在亚马逊前台搜索/商品页把广告位归因到后台广告活动，这是 Looom 复刻时最大的非接口壁垒。

---

## API数据服务

- 入口：顶级导航「AI工具 → API数据服务」→ `/datacenter`，路由 meta.title =「API数据服务|Sif」（来源：app.js 路由表）。SEO 描述沿用主站通用文案（来源：web reader 实测 `GET /datacenter`）。
- **页面内容 chunk 当前缺失**：`/datacenter` 路由依赖 chunk `75.b18975c5.js`，CDN 实测 404（两次、带 referer 复测均 404；其余 chunk 全部可下载）→ 该营销页极可能正在改版/迁移（与 MCP 服务同属「AI工具」组，2026 年 Sif 在主推 MCP，见下节）。因此**对外定价与能力清单暂无法从该页获取**。
- 能力旁证（来源：MCP 落地页 chunk 60）：使用场景双轨制——「**MCP 服务**（对话式/工作流）」与「**API 直接集成**」并列出现，说明 Sif 对外数据输出是 MCP + API 两条产品线共用同一套点数/订阅体系。
- 生态入口：`/mcp` 落地页的「查看 Sif MCP 接入指南」「MCP 沟通群」、运营顾问二维码；企业采购支持银行转账（chunk 56「开户银行/银行账号」字段）。

## MCP服务

- 入口：「AI工具 → MCP服务」→ `/mcp`（落地页，chunk 60 `static/js/60.08575d4a.js`）+ `/mcp-console`（控制台，chunk 56 `static/js/56.58ba8dfe.js`）。
- **公开网关（实测 2026-09-21）**：
  - `GET /mcp-api/config`（无需登录）→ `{"sifBaseUrl":"https://www.sif.com","mcpBaseUrl":"https://mcp.sif.com","mcpIntegrationDoc":"https://opeblk6n4y.feishu.cn/docx/KyeLdkzK6oBGknx2KMsc0TXbnkh","publicToolCount":32,"appDocList":[初级/中级应用场景使用手册(feishu)]}`。
  - `GET /mcp-api/catalog`（无需登录）→ 完整工具目录：**7 大类 32 个工具**，含每个工具的 tool 名、shortName、summary、功能说明、触发时机、示例问法、参数（name/required/defaultValue/description）、返回结构。分类：
    - 场景应用(1)：`analyze_traffic_anomaly`（流量下跌根因诊断，输入 ASIN 直接出诊断结论+行动建议，depth 1~5 层推理链）
    - 查关键词(8)：查需求3（demand/history/root_trend）+ 查竞争4（competition/root_competitors/screen_opportunities/discover_competitors）+ 评估推广1
    - 查ASIN(2)：市场定位画像、采购成本上限反推（基于 FBA 费率+目标毛利率）
    - 反查关键词(3)：Listing 流量词分布、ASIN 关键词信号、ABA top3 卡位地图
    - 查运营数据(6)：查流量4 + 查销量2
    - 查广告(12)：ASIN层6 + Campaign层4 + Ad Group层2（结构/流量趋势/贡献拆分/历史变更/特征画像）
  - **单工具点数消耗不在公开 catalog 内**（登录控制台才可见），定价接口 `/api/mcp/pricing/subscription`、`/api/mcp/pricing/addon` 实测需登录（token 失效未获取到数字）。
- 落地页卖点（chunk 60 文案）：「把亚马逊运营数据直接接进你自己的 AI 客户端」；「Sif MCP 提供结构化分析工具，覆盖流量、市场、广告三大域，让 Claude、Kimi、Codex 等 AI 客户端直接调用真实运营数据，完成竞品分析、流量诊断、广告复盘」；「5分钟接入」「实时数据」「三域·结构化工具」「支持 AI 客户端」「版本更新（持续迭代中，记录每次重要变更）」「MCP 沟通群」；使用案例：流量异常根因定位、竞品打法复盘、关键词机会发现、广告结构优化建议、深度数据研究、自动化工作流、自定义 Agent。
- **商业化模型（chunk 56/60 反推）**：
  - 「Sif 注册用户可免费领取 **20,000点**」（落地页）+ 控制台「立即领取」「可领取对应等级的会员赠送包」→ 注册赠点 + 会员等级对应 MCP 点数礼包（`POST /api/mcp/gift/claim`）。
  - 订阅套餐：月配额/按月或**按年付费**（一次支付全年）、当前订阅/升级（**补齐费用=目标档价格-当前档剩余抵扣**）/续费、订阅到期。
  - 加量包：**应急充值，长期有效**；但「仅支持在 MCP 订阅套餐有效期内使用；套餐过期则加量包冻结使用，续费后自动恢复」。
  - 点数体系：「每个 MCP Tool 调用复杂度不同，会消耗不同点数」；本月可用点数/月配额重置/点数来源明细/近30天总消耗（`/api/mcp/points/overview|usage-daily|usage-detail`）；日用量柱状图可下钻当天调用明细。
  - 接入：**一个账号当前仅支持 1 个密钥**（secret-key，rotate 即旧密钥立即失效）；「快速集成 URL」（`https://mcp.sif.com`）；《密钥使用规范与风控政策声明》（平台风控条款）；接入指南按 AI 客户端分步。
  - 支付：微信扫码支付、折扣码（`/api/mcp/discount/validate`）、银行转账（大额/升级联系运营顾问）、售罄状态位（「暂时售罄，正在紧急补货中」——暗示套餐限量发售）。

---

## 对 Looom 实现的建议

1. **批量备注的护城河在插件+归因，不在表**：Sif 的备注表本身极简（campaign 双 ID+站点+文本+颜色+类型，upsert 幂等）。真正壁垒是浏览器插件在前台把广告位溯源到后台广告活动。Looom 若无插件，应优先做「手动粘贴 编号+名称」模式（Sif 已验证该路径可用且明确宣传"不绑定后台"），并把**站点自动反查、失败手选**、**重复提交只保留最新版本**两个细节抄到位；数据表建议直接采用 `campaign_id_a0` + `front_numeric_id` 双键 + `color` + `kind(competitor/own)`，管理页按「投放模式/品牌统一背景色」做批量操作。
2. **实时查竞价做「任务制 + 排队可见」而非同步查询**：Sif 官方明说查询时间随任务量变化、前端有刷新状态/任务列表/角色并发上限（默认 2）。Looom 应实现 ASIN 任务池（自动投放/手动词两种 type，自动上限 200 词）、任务状态轮询、结果按 精准/词组/广泛 × SP/SB × (提升/降低 + 仅降低/固定合并) 建议竞价矩阵导出，并把「仅降低与固定合并」作为口径写进文档。定位上它是**旗舰会员专享**，可作为 Looom 高档会员钩子；注意口径红线：卖的是「建议竞价」，不是 CPC/出价。
3. **MCP 是当下最值得抄的增量**：Sif 已把目录（32 工具/7 类）、公开 catalog 接口（`/mcp-api/catalog` 无需登录）、接入文档全部标准化，且「场景应用」（输入 ASIN 直接出诊断结论，如 analyze_traffic_anomaly 的 5 层推理链）是与纯数据工具最大的差异化。Looom 可直接对标：**注册赠点 + 会员等级赠点包 + 订阅月/年配额 + 长期有效但随订阅冻结的加量包 + 单账号单密钥可轮换 + 按工具复杂度计点** 的完整商业闭环，以及风控声明、运营顾问微信、售罄限量等运营细节。工具命名可直接参考其 `域_动作_对象` 规范（如 `ads_get_asin_ad_structure`）。
4. **API数据服务页可低成本跟进**：Sif 的 /datacenter 当前 chunk 404、处于半废弃状态，说明其重心已转向 MCP。Looom 不必单做 API 门户，可在 MCP 控制台内并列「API 直接集成」入口，共用点数体系即可。
5. **验证方式提示**：本文接口 schema 来自前端代码静态反推（方法/路径可信度高，参数为高置信推断）；待拿到有效登录态后，建议仅实测读接口 `POST /api/user/adNote/list`、`GET /api/search/cpc/asinTaskList`、`GET /api/mcp/pricing/subscription|addon` 即可闭环。
