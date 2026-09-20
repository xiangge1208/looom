# Sif Web 后台复刻 —— 规格说明书（SPEC）

> 状态：侦察阶段进行中。本文档由主 Agent 汇总，业务细节来自 `docs/fragments/*.spec.md`。

---

## 一、并行能力评估

### 1.1 环境实测结论

按 goal.md「并行探查协议」要求，先探测能力，不做假设。实测过程与结果：

| 探测项 | 方法 | 结果 |
|---|---|---|
| 内置浏览器是否有已登录会话 | 调用 `preview_snapshot` / `preview_eval` | ❌ **失败**。工具要求 `serverId` 参数，无预挂载会话 |
| 能否连接浏览器预览 | 写 `.claude/launch.json` 配 `url: https://sif.com` 后 `preview_start` | ❌ **失败**。返回"attaches to a URL, which needs the in-app Browser preview — it is not enabled on this install" |
| 宿主机是否有可接管的浏览器 | `tasklist` 查进程 + 探 CDP 端口 9222/9223/9229/21222 | ⚠️ Chrome/msedgewebview2 进程在运行，但**均未开启远程调试端口** |
| 目标站点是否可达 | `nslookup` + `curl -I` | ✅ `sif.com → 8.129.177.105`，HTTP 200，跳转 `https://www.sif.com/` |
| 能否用 Playwright 自建独立会话 | `npx playwright --version` | ✅ 可用（v1.63.0），Node v22.14.0 |

**核心结论：goal.md 假设的前提（"已在内置浏览器打开且处于已登录状态"）在当前环境不成立。**
无法通过浏览器 Network 面板抓取 XHR 响应，因此**策略 A 与策略 B 的阶段 A 均无法按原方案执行**。

### 1.2 实际采用策略：策略 C（静态资产逆向 + 并行分析）

在无法操作浏览器的前提下，我改用了一条信息量更大、且不依赖登录态的路径：**逆向前端 SPA 的构建产物**。

依据：`www.sif.com` 是 Vue 2 + Element UI + ECharts 的单页应用，官网与后台**共用同一套 bundle**
（`new.sif.com` / `old.sif.com` / `dev2.sif.com` 返回的 HTML 与 `www.sif.com` 完全一致，同一份 `app.13bf5aa7.js`）。
后台各功能页是懒加载 chunk，chunk 清单与 hash 全部明文写在 `manifest.b86ca6fb.js` 里。

执行步骤：

1. 拉取 `app.13bf5aa7.js`（1.0 MB）与 `manifest.b86ca6fb.js`（8.4 KB）
2. 从 manifest 解出 **117 个懒加载 chunk 的 id→hash 映射**，拼出 URL 全量并发下载（12 并发）→ `docs/raw/_probe/chunks/`，共 **14 MB**
3. 从 `app.js` 解出 **83 条路由定义**（path + name + component chunk 引用）→ `docs/routes.json`
4. 全量扫描 118 个 JS 文件，提取 **335 个去重后的 `/api/**` 端点** → `docs/api-all.txt`
5. 建立 **chunk → API 端点** 的归属指纹（48 个 chunk 含 API 调用）→ `docs/chunk-apis.json`

### 1.3 这条路径与浏览器抓包的对比

| 维度 | 浏览器 Network 抓包 | 本次采用的静态逆向 |
|---|---|---|
| 接口路径覆盖 | 只能拿到"我点过的操作"触发的请求 | ✅ **全量 335 个**，含未触达的分支、导出、错误路径 |
| 请求参数结构 | ✅ 真实 payload | ⚠️ 需从调用处代码反推参数名 |
| **响应 JSON 真实值** | ✅ 真实数据 | ❌ **拿不到**，只能从字段引用处反推字段名 |
| 是否依赖登录态 | 需要 | ✅ 不需要 |
| 字段语义 | 靠界面对照 | ⚠️ 靠列定义 / label / 中文文案对照 |

**关键取舍（必须让用户知情）**：这条路能给出**接口清单与字段名**，
但**给不出响应 JSON 的真实结构与样例值**。对数据字典而言，字段的
**类型、量纲、枚举取值范围**将有相当一部分只能标 ⚠️ 推断。
goal.md 明确要求"不许凭经验补全"，因此这些不确定项我会全部进「待确认」，不做脑补。

### 1.4 并行策略

素材已全部落盘且为静态文件，不存在会话串扰风险，因此**分析阶段可安全并行**：
- 按功能域切分为多个素材包，一个域派一个子 Agent
- 子 Agent 只读 `docs/raw/_probe/chunks/` 与 `docs/chunk-apis.json`，不碰网络
- 主 Agent 负责合并、统一命名、仲裁冲突

并发度：从 3 起步，稳定后提高。

### 1.5 待用户裁决（阻塞项）

1. **是否需要真实响应数据？** 若需要，请提供其中一项：
   - 用 `chrome.exe --remote-debugging-port=9222` 重启 Chrome 并登录 Sif，我用 Playwright 接管抓包
   - 或你手动在 Network 面板导出 HAR，放到 `docs/raw/` 我来解析
2. 若接受"仅凭静态逆向"，则数据字典中相当比例的字段类型为推断值，需你逐条核对。

---

## 一补、侦察能力升级（第二阶段，重要）

1.1 节的结论「无法抓真实响应」**在侦察中途被推翻**。经用户要求修复 preview 后：

我写了本地反向代理 `tools/sif-proxy.mjs`（`localhost` → `www.sif.com`），
用 `.claude/launch.json` 以本地服务器方式挂载，预览面板成功加载原站，
**且处于已登录状态**。自此可以以真实身份调用任意接口。

完整方法与全部实测结论见 **`docs/raw/LIVE_PROBE.md`**（本次侦察最重要的文件）。

因此实际执行的是**策略 C 增强版**：静态逆向（拿全量端点清单）+ 实时实测（拿真实字段与类型）。
两者互补：静态给广度（335 个端点，含未点到的分支），实测给准确度（真实类型、枚举、失效项）。

**实测推翻了 10 处我基于静态代码的判断**，明细见 `DATA_DICTIONARY.md` C4 节。
最危险的一处：分页参数是 `pageNum`，传 `page` 会被**静默忽略**（不报错、永远返回第一页）。

## 二、路由与页面清单

- **权威路由表**：`docs/ROUTES_TITLES.md` —— 81 条路由 + 中文页面标题
  （来源：`app.js` 的 `meta:{title}`，比凭路径名推测可靠）
- **与 goal.md 页面清单的映射**：见 `docs/fragments/_common.spec.md` 第 5 节
- 各页面区块拆解、控件、交互：见 `docs/fragments/<域>.spec.md`

### 关键修正

| 原站路由 | 实际功能 | 我最初的误判 |
|---|---|---|
| **`/search`** | 查流量结构 | 曾误判为 `/compare-structure` |
| `/compare-*` 系列 | **多产品对比**独立功能族 | 曾误判为单产品流量结构页 |
| `/reverse` | 反查流量词 | — |
| **`/keywords`** | **以词拓词**（不是反查流量词！） | goal.md 用同名路由指代不同功能 |

### 原站规模远超 goal.md 的 16 页清单

goal.md 完全未提的两个完整功能族：
- **拓词&筛查相关性**（7 页）：`/keywords`、`/category`、`/expand`、`/root-relatedness`、
  `/asin-relatedness`、`/niche-relatedness`、`/keyword-relatedness`
- **关键词竞争分析**（3 页）：`/compete`、`/amount`、`/conversion-rate`

另有排名监控（`/dailyrank`、`/hourlyrank`、`/snapshot`）、竞价查询（`/cpc-*`）、
我的关注（`/product`、`/words`）等。

反之，原站**没有** `/dashboard`、`/diagnosis`、独立供应商页 —— 这三个是 goal.md 的原创设计。

## 三、接口契约

- **端点全量**：`docs/API_INVENTORY.md`（335 个，按模块分组）
- **逐接口契约**（含请求参数、响应字段、实测状态）：各域 `*.spec.md` 的接口契约表
- **公共机制**（鉴权、错误码、全局参数）：`docs/fragments/_common.spec.md`

### 全站公共约定（实测确认）

| 项 | 值 |
|---|---|
| 鉴权 | 请求头 `authorization`（**小写、无 Bearer 前缀**），token 从 **localStorage** 取 |
| token 格式 | JWT HS256，payload 含 `userSalt` |
| 响应信封 | `{code, data, commonMsg}`，**`code:1` = 成功**（`0`/`-1` 失败，HTTP 恒 200） |
| 强制 query 参数 | `country`（站点）、`_t`（时间戳）、`_m`（设备指纹） |
| 时间参数 | ⚠️ **按域不同，见下表** |
| 分页 | **`pageNum`** + `pageSize`（⚠️ 传 `page` 静默失效） |

### ⚠️ 时间参数按域分裂（不要假设全站统一）

这是本次侦察踩过的最大的坑之一 —— 我盲试广告域参数 6 轮全失败，
最后靠**代理层抓包**（`tools/sif-proxy.mjs` 的 `CAPTURE` 能力）才拿到真实参数。

| 域 | 时间参数 | week 可用性 | 其他必填 |
|---|---|---|---|
| sales / keywords / traffic | `timePieceType` + `timePieceValue` | ❌ 报「服务异常」 | — |
| **广告域**（`asinAdCampaignView/*`） | **`granularity`** | ✅ **正常**（143 个周点） | `isAsinSearch` + 嵌套 `conditions` |
| 多变体自然位（`asinMultiNf/*`） | 无时间参数，直接返回 `dates[]` | — | — |

广告域真实请求体（抓包所得）：

```json
{"granularity":"week","asin":"B01N5IB20Q","pageNum":1,"pageSize":100,
 "conditions":{"from":null,"to":null,"asin":null,"campaignId":"","encryptCampaignId":""},
 "sortBy":"campaign","desc":true,"isAsinSearch":false}
```
| 后端 | Java / Spring Boot（404 时露出 Spring 标准错误体） |
| 导出 | `/api/updown/**` 与 `/api/search/**` 一一对应，返回 XLSX |

### ⚠️ 端点清单含已下线项

实测确认 404 的：`/api/search/asinKeywords`、`/api/search/keyword/months`、
`/api/search/rec/getVariantsInfoApi`。
**从 bundle 提取的端点必须实测验证后才能写进实现。**

## 四、交互细节

见各域 `*.spec.md`。此处仅记录跨页面的共性结论：

1. **页面间跳转只传 `asin` / `country` / `tabAd`**，不传上下文 ID。
   ads 域实测确认：三个广告页**不能真正下钻**，从架构点投放小组是**本页开抽屉**，不跳页
2. **图表库是 ECharts**，折线（趋势）/ 柱状（对比）/ 堆叠条（流量结构）/ 气泡（推测投放词）
3. **导出**：几乎每个列表都有导出，走 `/api/updown/**`，返回 XLSX
   （实测 `application/octet-stream` + `PK\x03\x04` + `_rels/.rels`）
4. **错误页跳转**：500/502/503 → `/maintain`，403 → `/blacklist`，
   504 → 弹窗「数据超时，请稍后重试！」
5. **`asinMagic` 是有损归一化**：会把输入 ASIN 静默替换成同组流量更大的变体
   （实测 2 个 ASIN 被折叠成 1 个）。复刻**必须保留用户确认环节**

## 五、权限模型

**会员三档已代码级确证**，明细见 `docs/fragments/system-suppliers.spec.md` §1.2。

| 层级 | 能力 |
|---|---|
| 未登录 | 官网营销页 + `/freetrial` 活动页。业务接口需 token |
| 登录（免费） | 有积分额度限制。实测响应带 `consumeIntegral` / `balanceIntegral` / `integralLimit` |
| 会员（三档） | 差异见 system 域片段 |
| 团队/子账号 | `isTeam` 标志 + `/api/team/**` 13 个端点。⚠️ 主子账号 vs 多人协作待确认 |
| 封禁 | 403 → `/blacklist` |

**积分机制**（实测）：扣费信息随业务响应返回，非独立接口。
`message: "不需要扣取积分。"` 说明重复查询有去重期。
积分是**浮点数**（`balanceIntegral: 100.0`）。

**API Key**：原站**无面向普通用户的通用自助管理功能** → goal.md 的 `api_keys` 表是新增设计。

## 六、不确定清单

汇总在 **`docs/DATA_DICTIONARY.md` D 节**（分阻塞项 / 系统表 / 范围 / 各域遗留 / 素材勘误）。

最需要你提供的两样东西：
1. **一个已知的父体 ASIN**（sales 域测了 5 个全是子体，`isParentAsin` 分支无法验证）
2. **积分扣费单价规则** —— 我拒绝为测扣费而消耗你账号的积分（余额 100）
