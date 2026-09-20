# 公共机制（主 Agent 自查产出）

来源：`docs/raw/_probe/app.js`（主 bundle）。这部分不属于任何单一页面，是全站共享约定。

## 1. 鉴权机制

### 1.1 Token 传递

axios 请求拦截器（`app.js > interceptors.request.use`）：

```js
if (cookie.get("token")) {
  config.headers.common.authorization = cookie.get("token")
}
```

- 请求头名：**`authorization`**（全小写）
- **没有 `Bearer ` 前缀**，直接放裸 token
- token 存在 **cookie** 里，键名 `token`
- 另有 cookie 键：`loginType`（登录方式）、`redirect`（登录后回跳地址）、`advisorGuideShown`（引导弹窗是否已显示）、`_murmur`（设备/访客指纹）

> 复刻时的决策：goal.md 要求 JWT access + refresh token。原站看不到 refresh token 机制
> （只看到单个 token + 401 直接踢回首页），因此 **refresh token 属于我们新增的设计**，不是复刻。

### 1.2 全局参数自动注入

每个请求的 query 参数会被自动补上：

| 参数 | 来源 | 用途 |
|---|---|---|
| `_t` | `Date.now()` | 防缓存时间戳 |
| `_m` | cookie `_murmur` | ⚠️ 设备指纹，推测用于风控/防刷 |
| `country` | Vuex `state.countryCode` | **站点（marketplace）代码** |
| `bd_vid` / `qz_gdt` / `gdt_vid` | URL query | 广告投放归因参数（百度/广点通），复刻不需要 |

**`country` 是重点**：拦截器逻辑是「若 URL 未包含 `country=` 则强制追加」，
说明**几乎所有业务接口都按站点隔离数据**。

### 1.3 站点（country）枚举

从 `app.js` 与 chunks 中提取到的站点代码，共 13 个：

```
US, UK, DE, FR, IT, ES, JP, CA, MX, AU, IN(⚠️未在此次匹配中出现), AE, SA, BR
```

实际匹配到：`AE, AU, BR, CA, DE, ES, FR, IT, JP, MX, SA, UK, US`（13 个）

> **对数据字典的影响（重要）**：所有业务数据表都必须带 `country` 字段，
> 且它应进入 **Doris Unique Key 主键组合**，否则不同站点的同一 ASIN 会互相覆盖。
> 例：ASIN 主表主键应为 `(asin, country)` 而非仅 `asin`。
> 各子 Agent 的 dict 片段若遗漏 country，由主 Agent 在合并阶段统一补上并在合并日志说明。

## 2. 错误处理与状态码约定

响应拦截器（`app.js`）的行为：

| 状态码 | 行为 |
|---|---|
| **401** | 仅当请求 URL 以 `/api/user/basic/info` 开头时：清空 cookie `token`、删除 `loginType` / `advisorGuideShown`、Vuex `commit("updateToken","")`、把当前 URL 存进 cookie `redirect`、跳转 `/` |
| **500 / 502 / 503** | 跳转 `/maintain`（维护页） |
| **403** | 跳转 `/blacklist`（黑名单页 —— 账号被封禁） |
| **504** | 标记 `isTimeout=true`，弹 warning 提示：**「数据超时，请稍后重试！」** |

逃逸开关：请求配置里带 `skipGlobalErrorRedirect` 时，跳过全局错误跳转，交调用方自行处理。

> 说明：401 的处理**只对 `/api/user/basic/info` 生效**，其他接口返回 401 不会自动登出。
> 推测 `/api/user/basic/info` 是启动时的「取当前用户」探针，用它判断登录态。

> 复刻时的决策：goal.md 要求「401 自动刷新 token」。原站是 401 直接登出，无刷新。
> 这是我们的**改进项**，不是复刻项。

## 3. 技术栈（原站实测）

| 项 | 原站 | 我们的目标栈（goal.md 已定） |
|---|---|---|
| 框架 | **Vue 2**（webpack 构建，`chunk-vue`） | Vue 3 |
| UI 库 | **Element UI**（`chunk-element`） | Element Plus |
| 图表 | **ECharts + zrender**（`chunk-echarts`、`chunk-zrender`） | ECharts（vue-echarts） |
| 轮播 | Swiper（`chunk-swiperLess`） | 按需 |
| 日志/监控 | 阿里云 SLS（`chunk-sls`）+ 百度统计（hm.baidu.com） | 不复刻 |
| 截图 | html2canvas（CDN 引入） | ⚠️ 原站有「导出图片」类功能，见各页面片段 |
| 图标 | iconfont（at.alicdn.com，4 套字体库） | 不复刻，用 Element Plus 图标 |
| 静态资源 | `www-static.sif.com`（CDN）+ 阿里云 OSS（`gonglan-monitor.oss-cn-shenzhen`） | 本地/占位图 |
| 网关 | **openresty/1.21.4.3**（nginx） | 不涉及 |
| 后端风格 | ⚠️ 推测 Java 系。路径风格 `/api/<模块>/<资源>/<动作>`，驼峰命名 | NestJS |

OSS 域名 `gonglan-monitor` 透出原站早期项目名「**观澜**（gonglan）」。

## 4. 接口路径命名规律

335 个端点按一级模块分布：

| 模块前缀 | 端点数 | 用途 |
|---|---|---|
| `/api/search/**` | 115 | **核心业务查询**（销量、流量、关键词、广告、竞品等） |
| `/api/user/**` | 74 | 用户账户、资料、收藏、备注、订阅 |
| `/api/updown/**` | 44 | **导出下载**。与 `/api/search/**` 一一对应，字段结构相同 |
| `/api/mcp/**` | 18 | MCP 集成（goal.md 明确不做） |
| `/api/property/**` | 15 | 会员、积分、订单、优惠码 |
| `/api/team/**` | 13 | 团队/子账号 |
| `/api/compare/**` | 10 | 竞品对比 |
| `/api/focus/**` | 9 | 关注/收藏 |
| `/api/sym/**` | 7 | 官网营销内容（首页、落地页），非后台 |
| `/api/struct/**` | 6 | 流量结构 |
| `/api/wx/**` + `/api/wxqy/**` | 6 | 微信登录/企业微信（goal.md 改邮箱密码，不复刻） |
| `/api/monitor/**` + `/api/monitorSnapshot/**` | 6 | 监控与快照 |
| 其他 | 12 | sys / invoice / internal / yearreport / campaign / amazon(SP-API 授权) |

**规律**：`/api/updown/X/download` 必然对应一个 `/api/search/X` 查询接口。
复刻时导出接口可复用查询逻辑，只换序列化输出，不必单独设计字段。

## 5. 路由清单（原站 83 条，从 app.js 解出）

完整数据见 `docs/routes.json`。与 goal.md 页面清单的对应关系由主 Agent 在 SPEC.md 汇总。

**权威来源**：`app.js` 里每条路由都带 `meta:{title:"..."}` 中文标题，
已全量提取 81 条到 `docs/ROUTES_TITLES.md`。这是页面语义最可靠的依据（优于凭路径名猜）。

### 5.1 与 goal.md 页面清单的映射（已用 meta.title 校准）

| 原站路由 | 原站 meta.title | goal.md 目标路由 |
|---|---|---|
| `/Sales` | 查销量 | `/sales` |
| **`/search`** | **查流量结构** | `/traffic` |
| `/reverse` | 反查流量词 | `/keywords` |
| `/old_reverse` | 反查流量词（旧版） | 不做 |
| `/timemachine-traffic` | 运营时光机 | `/timeline` |
| `/timemachine-product` | 产品时光机 | ⚠️ 与上者是**两个不同页面**，goal.md 只列了一个 |
| `/multi-variants` | 查多变体自然位 | `/variations` |
| `/adxray-structure` | 查广告架构-广告透视仪 | `/ads/campaigns` |
| `/adxray-adgroup` | 查广告组-广告透视仪 | `/ads/groups` |
| `/adxray-searchterm` | 查广告词-广告透视仪 | `/ads/keywords` |
| `/recommend` | 查推荐专栏 | `/recommendations` |
| `/compete` | 流量位竞争格局-关键词竞争分析 | `/competitors` |
| `/member` | 购买会员/子账号 | `/settings` |
| `/mcp` `/mcp-console` | MCP服务 / 控制台 | **不做**（goal.md 明确） |

### 5.2 重要修正

我最初凭路径名初判 `/compare-structure` 是流量结构页，**这是错的**。
按 meta.title：
- **`/search` = 查流量结构**（单产品）
- `/compare-structure` = 对比流量结构-**多产品对比**
- `/compare-traffic` = 对比流量词-多产品对比
- `/compare-sales` = 对比销量-多产品对比

即 `compare-*` 系列是**「多产品对比」独立功能族**，与单产品页并列，不是同一页面。

### 5.3 原站有、goal.md 未列的页面（需你裁决是否纳入）

「广告透视仪」产品族比 goal.md 列的 3 个页面更完整，还有：
- `/adxray-productTarget` 查ASIN定位广告
- `/adxray-variation` 查投放变体
- `/ad-multiNotes-submit` 批量备注广告活动 / `/ad-multiNotes-view` 查看已备注的广告活动
- `/analysis-report` 各营销日广告投放分析报告

「拓词&筛查相关性」产品族（goal.md 完全未提，是原站一大功能块）：
- `/keywords` 以词拓词-拓展流量词
- `/category` 品类定制词库-拓展流量词
- `/expand` 通过竞品拓词-拓展流量词
- `/root-relatedness` 以词拓词并筛查
- `/asin-relatedness` 多竞品拓词并自动筛查
- `/niche-relatedness` 细分品类拓词并筛查
- `/keyword-relatedness` 批量导入关键词筛查

> ⚠️ **注意**：goal.md 的 `/keywords` 指「反查流量词」，
> 但原站 `/keywords` 实际是「以词拓词」，是**完全不同的功能**。命名冲突需你确认。

「关键词竞争分析」族：
- `/compete` 流量位竞争格局 / `/amount` 关键词竞品数量 / `/conversion-rate` 关键词转化率

排名监控族：`/dailyrank` 每日排名、`/hourlyrank` 小时排名、`/snapshot` 坑位快照

竞价查询族：`/cpc-realtime` 实时查产品竞价、`/cpc-browsetree` 查关键词竞价

「我的关注」族：`/product` 产品库-我的关注、`/words` 关键词库-我的关注

### 5.4 系统/辅助页

`/maintain` 维护页（500/502/503 跳转）、`/blacklist` 封禁页（403 跳转）、`/404`、
`/layout` 帮助中心、`/integral` 积分、`/recharge` 充值、`/vipInfor` 会员信息、
`/infor` 个人信息、`/experiencecard` 体验卡信息、`/team` 团队、`/invite` 邀请、
`/purchaseRecords` 购买记录、`/datacenter` API数据服务、`/freetrial` 活动页

> `/maintain`、`/blacklist`、`/404` goal.md 未列，但错误处理需要，建议补。

### 5.5 原站没有的页面（goal.md 的新增设计）

原站**无** `/dashboard`、无 `/diagnosis`（AI 综合诊断）、无独立供应商页面
（供应商仅有 3 个 `/api/search/1688/*` 接口，可能是内嵌功能）。
这三个是 goal.md 的原创设计，实现时无原站可参照。

## 6. 不确定清单（公共部分）

1. ⚠️ `_murmur` 设备指纹的生成算法未追（murmurhash？），复刻不需要，但若原站用它做防刷，我们的配额设计需另想办法
2. ⚠️ token 的实际格式（JWT 还是不透明串）无法确认 —— 拿不到真实响应
3. ⚠️ 统一响应信封格式（`{code,message,data}` 还是别的）**无法从压缩代码确认**。
   goal.md 已指定我们用 `{code,message,data}`，按 goal.md 执行即可
4. ⚠️ `IN`（印度站）是否支持：枚举匹配未命中，但不排除在未下载的 chunk 里
5. ⚠️ 原站是否有「未登录可试用」模式：`/freetrial` `/experiencecard` 路由存在，需系统域子 Agent 确认
