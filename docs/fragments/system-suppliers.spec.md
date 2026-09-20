# 系统域 + 供应商域 规格片段

素材：`docs/raw/_probe/app.js`（API 定义层）、`docs/raw/_probe/chunks/*.js`（页面实现）。
方法与纪律见 `docs/raw/RECON_METHOD.md`。**分析对象是 webpack 压缩后的前端源码，不是接口响应样例**，
因此字段名可信、字段类型基本无证据（均标 ⚠️）。

---

## 一、系统域

### 1.1 用户账户体系

#### 登录 / 注册方式

原站有**两条**登录通道，`/infor` 页「登录方式」区块直接列出：

| 方式 | 证据 | 相关接口 |
|---|---|---|
| 手机号 + 密码 | `64.80eb203b.js > "手机号+密码"`、`"登录方式二：微信扫码"`（59 号 chunk 同文案） | `/api/user/login`（payload `{phone, password}`，见 app.js `{phone:e.phone,password:e.password}`） |
| 微信扫码 | `59.32608c5f.js > "登录方式二：微信扫码"` | `/api/wx/getQr`、`/api/wx/checkeTicketStatus`、`/api/wx/getWechatQrImg`、`/api/wx/bindWechatStatus` |

**没有看到邮箱注册/登录接口。** `/api/user/login` 的 payload 里只有 `phone`，
邮箱字段仅出现在**发票接收邮箱**（`66.bd7049c1.js > label:"电子邮箱",prop:"email"`）。
→ goal.md 要求的「邮箱密码注册登录」在原站**无对应实现**，属于本期自行设计，
只能复用原站的密码强度规则（见下）。

密码规则（直接看到的正则，可复用）：
```
/^(?=.*[a-zA-Z])(?=.*[0-9])[a-zA-Z0-9]{6,20}$/
```
来源 `64.80eb203b.js`，配套文案 `"密码格式不正确，需6-20位数字和字母的组合"`。

姓名规则：`"只支持中文、字母、数字和_（2-20 字符）"`（同文件）。
手机号规则：`/^1[3-9]\d{9}$/`（同文件），验证码固定 **4 位**（`"请输入4位验证码"`）。

#### 用户资料字段（`/api/user/sys/info` 返回体，前端 `userInfo`）

从多个 chunk 的 `userInfo.xxx` 访问点聚合（`70`/`71`/`77`/`64`/`78`/`59`/`120`）：

`userid`、`username`、`showName`、`phone`、`hasPassword`、`hasPw`、`hasWechat`、
`teamid`、`isSubAccount`、`vipLevel`、`vipLevelSec`、`showVip`、`isValidVip`、`isVipTrial`、
`expirationDate`、`isRenewal`、`vipRenewalInfo{vipNum,vipNumHigh,vipNumShark,beginDay,endDay}`、
`integral`、`voucher`、`integralTotalAmount`、`integralTeam`、`estIntegral`、`pricingAb`。

> `/api/user/sys/info` 在 app.js 里带**请求去重缓存**（`u||(u=Object(s.a)(...))`），说明它是全站高频基础接口。

#### 账户设置页 `/infor`（chunk 64）

区块：基本信息（用户ID / 姓名 / 手机号 / 密码 / 登录方式 / 绑定微信）、注销账号。

字段级权限开关来自 `/api/user/fieldPermission`，返回 4 个布尔：
`allowName`、`allowPhone`、`allowPassword`、`allowWechat`（默认全 `true`）。
关闭时文案 `"管理员已禁止该项修改"` / `"管理员已限制修改，如需修改请联系管理员"`。
→ **这是团队管理员对子账号的字段级管控**，goal.md 未提及，需主 Agent 裁决是否实现。

注销流程（三步，chunk 64）：
1. `/api/user/cancel/verifyPassword`（或微信扫码验证）→ 身份验证
2. `/api/user/cancel/assets` → 展示账户剩余资产，要求勾选「自愿放弃剩余资产和权益」
3. `/api/user/cancel/apply` → 提交注销

团队约束文案：`"团队管理员账号暂无法注销"`、`"团队成员账号暂无法注销"`，
出口是「转让管理身份」或「解散整个团队」（后者需联系运营顾问）。

账号找回（独立路由 `/recover-user-account`）：
`/api/user/recover/sendAuthCode` → `/api/user/recover/verifyPhone` → `/api/user/recover/merge`。
密码重置三段式：`/api/user/password/reset/sendCode` → `/verify` → `/confirm`。

---

### 1.2 会员体系（重点）

#### 会员等级枚举 —— 三档，代码级确证

`59.32608c5f.js` 的团队成员筛选下拉（`sortOptions`）是**最直接的枚举定义**：

```js
sortOptions:[
  {groupid:"",       groupName:"全部"},
  {groupid:"shark",  groupName:"旗舰会员"},
  {groupid:"high",   groupName:"基础会员"},
  {groupid:"integral",groupName:"积分会员"}
]
```

`77.cd355b4e.js` / `59.32608c5f.js` 里 `vipLevel` → 中文名 + 全局态的映射同样明确：

```js
userInfo.isValidVip
  ? (vipLevel=="high"  ? (showVip=1, version="基础会员")
   : vipLevel=="shark" ? (showVip=2, version="旗舰会员") : ...)
  : (showVip=0, version="积分会员")
```

| `vipLevel` | 名称 | `showVip` | 判定 |
|---|---|---|---|
| `shark` | 旗舰会员 | 2 | `isValidVip=true` |
| `high` | 基础会员 | 1 | `isValidVip=true` |
| （无值 / `integral`） | 积分会员 | 0 | `isValidVip=false`，即**非会员，按积分付费查询** |

辅助字段：
- `vipLevelSon` —— 增购子账号时的目标档位，取值同为 `"high"` / `"shark"`（`70.3804a6bc.js`）
- `vipLevelSec` —— 二级会员形态，看到取值 `"piece"`（单件/散购）与 `"trial"`（试用），
  判据 `["piece","trial"].includes(userInfo.vipLevelSec)`（`70`/`71`）
- `isVipTrial` —— 试用标记，`/vipInfor` 显示后缀 `"-试用"`
- `vipLevelName` / `vipLevelEnum` —— 后端下发的展示名与筛选值（`59.32608c5f.js`）
- `banned` —— 成员行上的封禁态（class `vip-level-banned`）

试用领取：`/api/property/vip/claimTrial` + `/api/property/vip/claimTrial/status`。

#### 各等级权限差异（goal.md「权限模型」章节依据）

**注意：素材里没有一张完整的权限矩阵表。** `/member` 页的对比表是从
`/api/property/menu/search` 动态渲染的（`70.3804a6bc.js > getMenuList → property/menu/search`），
所以静态代码里只留下了**部分硬编码差异点**。已确证的如下：

| 差异点 | 规则 | 来源 |
|---|---|---|
| 历史数据（反查流量词等） | 仅旗舰会员可看 | `26`/`27`/`28`/`34`/`36`/`37`/`39`/`42` chunk 共有文案 `"历史数据仅旗舰会员可查看"` |
| 关键词点击转化率 | 仅 `vipLevel==="shark"` 显示真值，否则渲染 `"旗舰会员可见"` 遮罩 | `33.e0652200.js > "shark"===e.vipLevel ? ... : "旗舰会员可见"` |
| 查竞品竞价（多个） | 旗舰专属；基础会员与积分会员**仅免费查 N 次**（N 由 `limitNum` 动态下发） | `63.a6cfa9ac.js > "查竞品竞价为旗舰会员专属功能，基础会员和积分会员仅支持免费查询 {limitNum} 次"` |
| 对比流量词-变体对比 | 会员专属 | `98.54adc2c3.js > "变体对比-会员专属"` |
| 每日排名「申请9点前更新」 | 基础会员 + 旗舰会员免费使用 | `41.f781c26c.js > "基础会员和旗舰会员可免费使用"` |
| 非会员整体 | 走积分付费查询 | `59.32608c5f.js > "非会员(使用积分查询)"` |

档位定位文案（`/member` 页，`70.3804a6bc.js`）：
- 基础会员：`"包含查销量、流量结构、反查流量词等常用基础功能，适合铺货型卖家或运营模式比较简单的卖家"`
- 旗舰会员：`"包含全网独家的查竞品广告架构+运营打法、关键词竞价、词库搭建等高阶功能，适合运营精细化程度较高的精铺/精品/品牌型卖家"`

另有一份**非会员试用配额**常量（`70.3804a6bc.js`，变量名 `k`，注入到对比表「相同项」）：
```js
{ sales:{num:2,asin:true,keyword:true},
  search:{num:1,source:true,single:{weekOrMonth:true}},
  cpcRealtime:{single:{onceSearch:true}},
  reverse:{num:1,compare:true,single:{weekOrMonth:true}},
  asinRelatedness:{num:1,batch:true},
  product:{num:1,index:true},
  amount:{num:1,traffic:true,single:{onceSearch:true}},
  dailyRank:{num:1,hourRank:true},
  plugin:{num:3,detailKeepa:true,bestSellersTraffic:true,searchKeyword:true} }
```
⚠️ `num` 的语义（免费次数？还是可选站点数？）**代码里无注释，未确证**，进不确定清单。
唯一旁证是 `70.3804a6bc.js` 的 `"仅支持查询2次"`、`"支持最多50个产品"`、`"只支持最新1个月"`。

#### 计价与订阅

- 计费周期：**按年订阅**。`"均为按年订阅，一次支付、全年使用"`、`"元/年"`、`"按年付费"`（`70`）
- 席位规格：`groupList:[{groupid:0,"单人版"},{groupid:1,"3人版"},{groupid:2,"6人版"}]`（`70`）
- 价格由后端下发：`priceListHigh[]` / `priceListShark[]`，元素含
  `id`、`price`、`showPrice`（原价）、`appendPrice`（子账号单价）、`model`、`active{isValid,price}`
- 增购子账号：`"每个{appendVipPrice}元/年"`，`vipLevelSon` 决定档位
- 最终价公式（页面显式渲染）：`(curPrice + appendVipPrice * 子账号数) * discount = finalPrice`
- 支付方式：支付宝 / 微信 / 对公转账。**微信有金额上限**：`finalPrice < 3000` 才显示微信按钮
  （`70.3804a6bc.js`），MCP 页文案 `"微信最高限额3,000，请使用其他方式"`
- 优惠码：`/api/property/discountCode/check`，命中后 `codeMsg=1`、`discount=折扣`，
  文案 `"优惠码有效，享{discount}折优惠"`

订单链路：`/api/property/vip/calcPrice`（试算）→ `/api/property/order/producer`（下单）
→ `/api/property/order/getQrImg`（`responseType:"blob"`，支付二维码）
→ `/api/property/order/payStatus`（轮询，前端 `orderTimer` 定时器）。

---

### 1.3 积分体系（重点）

#### 换算比与获得途径

**1 元 = 10 积分**，直接文案：`120.ca90d5d5.js > "个（1元=10个积分）"`、`"请输入积分限额，1元=10积分"`。

获得途径（枚举来自 `71.aa5862cd.js` 的 `formatSence` switch 分支，是**积分流水的 scene 字段取值**）：

| `scene` | 中文 | 说明 |
|---|---|---|
| `presentNewUser` | 新用户注册赠送 | 注册即送 |
| `presentMember` | 购买会员赠送 | 买会员附赠。**限制**：`"会员期内赠送的积分，会员到期后仅支持在小时监控中使用"`（`98`） |
| `exchange` | 兑换 | 代金券兑积分，`/api/property/voucher/exchangeIntegral` |
| `present` | 赠送 | 运营手工赠送 |
| `refund` | 退费 | 退款回冲 |
| `receive` / `allocate` | 接受者(入) / 分配者(出) | 团队内分配 |
| `presentToUser` / `presentToTeam` / `receiveFromUser` / `receiveFromTeam` | 赠送积分给成员 / 给团队 / 成员转入团队 / 团队转入个人 | 团队积分调拨 |
| `autoProceed` | 自动续费 | |
| `search` / `download` / `stop` / `delete` / `update` / `updateAdd` / `updateDelete` | 查询 / 下载 / 停止监控 / 删除 / 更新 / 修改时添加 / 修改时删除 | 消耗侧动作 |

充值：`/api/property/menu/search` 返回 `data.menu[]`，元素为 `{id, integralNum, price, discount, isValid}`
（`120.ca90d5d5.js`）—— 即**充值档位由后端配置，不是前端硬编码**。
代金券：`userInfo.voucher` 是元金额，文案 `"您有价值{voucher}元的代金券"` → `"兑换成积分"`。

#### 积分扣费规则 —— 完整表，来自 `/rule` 页（`98.54adc2c3.js`，路由 `/rule`）

**不重复计费规则（原文）**：
1. 所有要收费的只在当天第一次操作时收费，当天内重复操作不收费
2. 搜索框查询触发并收费后，当天内所有筛选或其他组合条件搜索都不再额外收费
3. 所有查询如果没有结果不收费
4. 插件和查流量结构功能暂时不收费
5. 会员期内赠送的积分，会员到期后仅支持在小时监控中使用

**功能点对应积分消耗**（表格原样，单位「元」需 ×10 换成积分）：

| 功能页 | 功能点 | 积分消耗 |
|---|---|---|
| 查产品销量 | ASIN查产品 | 免费 |
| 查产品销量 | 关键词查产品 | 免费 |
| 查流量结构 | 单个ASIN查询 | 免费 |
| 查流量结构 | 多个ASIN查询 | 免费 |
| 反查流量词 | 反查流量词 | **1元/ASIN**（=10积分） |
| 反查流量词 | 查看单个关键词排名趋势 | 免费 |
| 反查流量词 | 对比多词排名 | 免费 |
| 广告透视仪 | 查广告架构 / 查广告组 / 查广告词 / 查 ASIN 定位广告 | 不支持（会员专属，不能用积分买） |
| 流量时光机 | 流量时光机 | 不支持 |
| 拓词&筛查相关性 | 多竞品拓词 | 不支持 |
| 拓词&筛查相关性 | 以词拓词 | **2元/词**（=20积分） |
| 拓词&筛查相关性 | 细分品类拓词 | 不支持 |
| 拓词&筛查相关性 | 批量导入 | **1元/词** |
| 多产品对比 | 对比销量 / 对比流量结构 | 免费 |
| 多产品对比 | 对比流量词 | 原输入 **1元/ASIN/词**；变体对比-会员专属 |
| 产品时光机 | 产品时光机 | 免费 |
| 选词 | 关键词转化率 | 不支持 |
| 选词 | 关键词竞品数量(单个) | **1元/词** |
| 选词 | 关键词竞品数量(拓展) | 不支持 |
| 选词 | 流量位竞争格局 | **2元/词** |
| 查关键词竞价 | 单个 | **1元/词** |
| 查关键词竞价 | 多个 | 不支持 |
| 词频统计 | 词频统计 | 不支持 |
| 历史反查 | 历史反查 | 不支持 |
| 坑位监控 | 每日排名 | 不支持 |
| 坑位监控 | 小时排名 | 以一个 ASIN 在一个关键词下的自然和广告排名为监控对象，每 2 小时一次，每次抓 3 页，连续 7 天为一个收费单位，收 **1元**；更改频率、抓取页数和监控时长成比例增减积分 |
| 产品库/词库 | 产品库/词库 | 免费 |
| 插件 | 子体订单量（搜索页）等 10 项 | 限时免费 |
| 插件 | 运营时光机-流量趋势（详情页） | 不支持 |

> ⚠️ 表内单位写「元」，与「1元=10积分」并用。也就是说**查一次反查流量词 = 10 积分**。
> 但小时监控的实际扣费是 **42 积分/次**（见下），而规则表按 1元=10积分 只推出 10 积分。
> 两者对不上，是因为监控的实际参数（每 1 小时抓、持续 15 天）比规则表基准（每 2 小时、7 天）翻倍。
> 主 Agent 需注意：**规则表是基准价，实际扣费必须由服务端按参数计算**。

**小时监控实际扣费 = 42 积分**，两处硬编码文案确证：
- `41.f781c26c.js` / `76.9f161512.js`：`"每次持续时间15天，消耗42个积分"`、
  `"监控后关键词每1小时抓取前3页数据，持续15天，消耗42个积分"`
- `41.f781c26c.js`：`"监控成功，已扣除42个积分"`

#### `calcMonitor` / `calcBatchMonitor` 核实结论

**已核实：这两个接口确实是「预估本次操作需要多少积分」，不是扣费接口。**

`41.f781c26c.js` 与 `55.dde418e6.js` 的 `add-monitor` 组件里，打开弹窗即调用：
```js
i = { type: 2, asinKeywords: {} };
i.asinKeywords[this.asin] = this.keyword;   // {asin: [关键词数组]}
res = await calcMonitor(i);                  // p.i → /api/property/integral/calcMonitor
if (res.code === 1) this.curScore = res.data.integral;
```
`curScore` 随后只用于展示，以及积分不足弹窗：
`"{您|团队}目前仅剩{balance}积分，不足以支付本次监控的{|curScore|}积分，请先充值。"`
（`41.f781c26c.js` / `55.dde418e6.js`）

- `calcMonitor`：单个 ASIN 维度预估，请求 `{type, asinKeywords:{[asin]:[keyword...]}}`，响应 `data.integral`
- `calcBatchMonitor`：批量版本。⚠️ **在 chunk 里没找到调用点**（app.js 有定义、导出别名 `i`），
  请求结构未确证，仅按命名推断为多 ASIN 批量预估。

#### 积分限额（配额）

有两级限额，**都是团队管理员设的自然月消耗上限**（`59.32608c5f.js`）：

| 字段 | 语义 | 文案 |
|---|---|---|
| `teamInfo.defaultIntegralLimit` | 团队默认限额，作用于全体成员 | `"设置成员每个自然月默认的积分使用限额，防止用超"`、按钮「设置默认限额」 |
| `teamInfo.integralLimit` | 当前成员自己的限额 | `"您每个自然月的积分消耗限额是：{n}个积分/月"`，为 0/空显示 `"不限制"` |
| 成员行 `integralTeamLimit` | 该成员的月限额（表格列「每月限额」） | 为空显示 `"不限制"`；有特殊值时表头提示 `"(部分成员已特殊处理)"`、`"跟随默认限额"` / `"的特殊限额"` |

限额触达的用户侧表现：所有查询页的「无结果原因」列表里都带一条 `"积分不足、积分限制"`
（`26`/`32`/`33`/`41`/`46`/`58`/`61` 等），以及 `limitScore` 弹窗（标题 `"个人积分限制"`，
引导跳 `/recharge`）。**没有看到「查询次数配额」这类独立于积分的配额接口** —— 配额就是积分月限额。

`/api/user/search/consumeIntegralHistory` 是消耗历史（`/integral` 页），
`120.ca90d5d5.js` 的历史筛选：`全部历史 / 只看充值 / 只看消费`，
请求 `{pageNum, pageSize, module, scene}`。

---

### 1.4 API Key 管理

**结论：原站没有面向普通用户的通用 API Key 自助管理功能。**

排查过程与结果：

1. 全量 grep `apikey|api_key|accessKey|secretKey`（app.js + 117 chunk），
   只命中 `secretKey` 系列 **7 处，全部在 MCP 控制台 chunk（`56.58ba8dfe.js` / `60.08575d4a.js`）内**。
2. `/member` 页顶部有三个 tab：`会员账号` / `MCP服务`（→ `/mcp-console?tab=purchase`）/ `API接口`（→ `/datacenter`）。
3. `/datacenter`（chunk `75.ad11a47c.js`）**是纯营销落地页**：标题「Sif API 数据服务」，
   一句「支持商品搜索、商品详情、反查流量词、关键词详情、排名趋势、销量等 API 接口」「支持企业定制化」，
   唯一交互是弹二维码「联系运营顾问（请备注API咨询）」。**没有任何密钥列表、创建、撤销 UI。**
4. `/recharge` 页同样把 API 归到人工渠道：`"更多数量或API请求" → "请联系运营顾问"`（`120`）。

**唯一存在的密钥功能在 MCP 控制台**（本期不做）：
- `/api/mcp/secret-key/rotate`（POST，空 body）→ 返回新的 `{maskSecretKey, maskIntegrationUrl}`
- `/api/mcp/integration-url`（GET）/ `/api/mcp/integration-url/copy`（POST `{fieldName}`，复制埋点）
- UI 组件 `SecretKeyCard`，props `maskSecretKey` / `maskIntegrationUrl` / `integrationDoc`，
  操作只有「复制密钥」和「立即更换」，**单密钥、掩码展示、只能轮换、不能多把**
- 文案 `"密钥管理"`、`"密钥使用规范与风控政策声明"`、`"密钥更换成功"`

→ 给主 Agent：goal.md 的 `api_keys` 表**原站无对应实现**，须标注「按 goal.md 要求自行设计」。
若要蹭一点原站语义，MCP 那套（掩码展示 + rotate 轮换 + 集成 URL）是唯一可参考的形态，
但它是单密钥模型，与「多把 API Key 管理」不同。

---

### 1.5 团队功能

**性质：既是子账号体系，也是协作 + 资产（会员席位/积分）共享池。** 两者同一套模型。

证据：
- 「子账号」侧：`"创建子账号"`、`"增购基础版子账号"`、`userInfo.isSubAccount`、
  `fieldPermission` 让管理员禁止子账号改姓名/手机/密码/微信
- 「共享池」侧：`"团队积分"`（tooltip `"团队内所有成员共享的积分"`）、
  `"会员额度总共{vipNum}个，已使用{usedVipNum}个"`、「分配会员」

#### 角色 —— 只有两个

`teamInfo.status` / `teamInfo.isManager` 决定，`59.32608c5f.js`：

| 值 | 名称 | 能力（看到的） |
|---|---|---|
| `manager` (`isManager=true`) | 管理员 / 管理人员 | 邀请成员、创建/编辑/移出子账号、分配会员席位、设默认与单人积分限额、改团队名、转让管理权、看全员积分流水（成员列多一列「姓名」） |
| `member` (`isManager=false`) | 成员 | 只看自己；退出团队需联系管理员（`"如需退出，请联系管理员"`）；看不到成员筛选和限额设置按钮 |

→ **原站没有多角色/自定义角色/权限组。** goal.md 的 `roles` / `user_roles` 表在原站无依据；
若要建，只需 owner/manager + member 两值，或直接用 `is_manager` 布尔。
真正细粒度的那层是 `fieldPermission`（4 个布尔字段级开关），不是角色表。

`joinTeamPreInfo` 的加入态机器（`78.071f0c8b.js`，`teamInfor.status`）：
`none`（可加入）/ `applyJoin`（已申请待管理员同意）/ `member`（已加入）/ `otherMember`（已属其他团队）。
成员侧还有 `isAgreeJoin`（是否已同意入团）、`"待激活"` 计数（`status:"pending"`）。

会员资格转移风险提示（`78`）：`"您目前的账号是会员，加入团队后，会员资格所有权将转移到团队，
管理员有权取消您的会员资格并删除您的账号。"` —— 这是一条重要业务规则。

移出成员是**异步长任务**：`/api/team/member/remove` → `/removeProgress` 轮询进度
→ `/removeMonitorPreview` 预览将被停掉的监控。文案 `"账号已锁定，数据删除中"`、
`"数据留在账号内"` vs `"删除数据"` 二选一，两条 API 都带 `skipAccountLocked:true`。

#### 团队接口契约（13 个）

| 方法 | 路径 | 请求参数 | 响应字段 | 触发场景 |
|---|---|---|---|---|
| GET | `/api/team/search/teamInfo` | `pageNum, pageSize, vipLevelEnum, name, status, sortField, sortOrder` | `teamid, name, managerName, status, isManager, memberNum, total, vipNum, vipNumShark, usedVipNum, usedVipNumShark, vipExpirationDate, isRenewal, vipRenewalInfo, integralTeam, integralLimit, defaultIntegralLimit, memberInfos[]` | `/team` 页加载、筛选、搜索、翻页 |
| GET | `/api/team/search/joinTeamPreInfo` | ⚠️ 未确证（推测团队标识/邀请码） | `name, managerName, status` | `/invite` 邀请落地页 |
| POST | `/api/team/manager/handle` | ⚠️ 未确证 | ⚠️ | 转让管理权 |
| GET | `/api/team/transfer/memberIntegral` | ⚠️ 未确证 | ⚠️ | 个人↔团队积分互转 |
| POST | `/api/team/user/handle` | ⚠️ 未确证 | ⚠️ | 创建团队 / 加入 / 退出 |
| POST | `/api/team/member/create` | `username, phone, password`（据创建子账号表单） | ⚠️ | 创建子账号 |
| GET | `/api/team/member/checkPhone` | `phone` | 冲突标记（前端 `phoneConflict` / `phoneConflictMsg`） | 编辑成员时校验手机号占用 |
| POST | `/api/team/member/edit` | `memberid, username, phone, password, authCode` | ⚠️ | 编辑账号（支持手机号留空） |
| POST | `/api/team/member/remove` | `memberid` + 数据处理方式 | ⚠️ | 移出团队 |
| GET | `/api/team/member/removeProgress` | `memberid` | 删除进度 | 移出后轮询 |
| GET | `/api/team/member/removeMonitorPreview` | `memberid` | 受影响监控 | 移出前预览 |
| POST | `/api/team/member/wechatUnbind` | `memberid` | ⚠️ | 解绑成员微信 |
| POST | `/api/team/member/phoneUnbind` | `memberid` | ⚠️ | 清空成员手机号 |

成员列表列（`el-table-column` label → row 字段，含金量最高的直接对照）：

| 列名 | 字段 |
|---|---|
| 姓名 | `username` |
| 会员版本 | `vipLevelName`（`isAgreeJoin` 决定是否可点，`banned` 决定样式） |
| 手机号 | `phone` |
| 微信 | `hasWechat`（已绑定 / 未绑定） |
| 每月限额 | `integralTeamLimit`（空 = 不限制） |
| 本月积分消耗 | `integralConsumeMonth` |
| 累计积分消耗 | `integralConsumeTotal` |
| 最近登录 | `lastLoginAt` |
| 操作 | — |

---

### 1.6 其他系统接口契约（按功能分组）

#### 账户

| 方法 | 路径 | 请求参数 | 响应字段 | 触发场景 |
|---|---|---|---|---|
| GET | `/api/user/sys/info` | 无（带前端去重缓存） | 见 1.1 `userInfo` 全量 | 全站基础态，登录后各页 |
| GET | `/api/user/basic/info` | 无 | ⚠️ | 鉴权探针；**401 时前端清 token 并跳首页**（app.js 拦截器专门判这条 URL） |
| POST | `/api/user/login` | `{phone, password}` | `token` ⚠️ | 登录 |
| GET | `/api/user/loginout` | 无 | — | 登出 |
| GET | `/api/user/send/authCode` | `{phone}` | — | 发短信验证码（4 位） |
| POST | `/api/user/info/handle` | `{username}` ⚠️ | — | 改姓名 |
| GET | `/api/user/commit/phone` | `{phone, authCode}` | — | 改手机号 |
| POST | `/api/user/commit/password` | `{password}` ⚠️ | — | 改密码 |
| POST | `/api/user/commit/phonePw` | `{phone, authCode, password}` | — | 首次同时设置手机号+密码 |
| POST | `/api/user/password/reset/sendCode` | `{phone}` | — | 忘记密码-发码 |
| POST | `/api/user/password/reset/verify` | `{phone, authCode}` | — | 忘记密码-验码 |
| POST | `/api/user/password/reset/confirm` | `{phone, authCode, newPassword}` | — | 忘记密码-改密 |
| GET | `/api/user/fieldPermission` | 无 | `allowName, allowPhone, allowPassword, allowWechat` | `/infor` 加载 |
| GET | `/api/user/cancel/assets` | 无 | 资产列表（前端 `assets[]`） | 注销第 2 步 |
| POST | `/api/user/cancel/verifyPassword` | `{phone, password}` ⚠️ | — | 注销身份验证 |
| POST | `/api/user/cancel/apply` | 无 | — | 提交注销 |
| GET | `/api/user/recover/sendAuthCode` / `verifyPhone` / POST `recover/merge` | ⚠️ | ⚠️ | `/recover-user-account` |
| POST | `/api/user/search/isNewUser` | ⚠️ | ⚠️ | 新人引导判定 |
| GET | `/api/user/invitationalInfo` | ⚠️ | ⚠️ | 邀请信息（`inviter` query 参数会带进下单请求） |

#### 会员 / 订单

| 方法 | 路径 | 请求参数 | 响应字段 | 触发场景 |
|---|---|---|---|---|
| GET | `/api/user/vip/info` | 无（`ignoreSetCountry`） | ⚠️ | 会员详情 |
| GET | `/api/user/vip/overview` | 无 | `vipLevel, vipNum, vipNumHigh, vipNumShark, isManager, isRenewal, period, typeAppendPrice` | `/member` 页头部 |
| GET | `/api/property/vip/piece/list` | ⚠️ | ⚠️ | 单件（piece）会员列表 |
| POST | `/api/property/vip/calcPrice` | `{chargeType, vipLevel, chargeid, typeAppendNum:{shark,high}, typeVipids, period, discountCode?}` | `finalPrice, finalMonthlyPrice, eggPrice1/2, exceptPrice1/2` ⚠️ | 购买弹窗改任一选项即试算 |
| POST | `/api/property/order/producer` | `{platform:"wechatpay"\|"alipay", chargeType, vipLevel, chargeid, typeAppendNum, typeVipids, period, inviter, discountCode?}` | 订单号 + 支付信息 ⚠️ | 点「立即支付」 |
| GET | `/api/property/order/getQrImg` | 订单标识 ⚠️（`responseType:"blob"`） | 二维码图片流 | 展示支付码 |
| POST | `/api/property/order/payStatus` | 订单标识 ⚠️ | 支付状态 | 定时轮询 |
| GET | `/api/property/discountCode/check` | `{discountCode}` | `discountCode, discount` | 输入优惠码 |
| GET | `/api/property/userDiscountCode/search` | ⚠️ | ⚠️ | 我的优惠码 |
| GET | `/api/property/menu/search` | `ignoreSetCountry` | `menu[]{id,integralNum,price,discount,isValid}`；`/member` 页也用它渲染功能对比表 | `/recharge`、`/member` |
| GET | `/api/property/popup/vip` / `popup/search` | ⚠️ | `needPopup, type`（看到 `"sys_u_vr"`） | 续费/开通弹窗 |
| GET | `/api/property/vip/claimTrial` / `claimTrial/status` | ⚠️ | ⚠️ | 领试用 |

#### 积分

| 方法 | 路径 | 请求参数 | 响应字段 | 触发场景 |
|---|---|---|---|---|
| POST | `/api/user/search/consumeIntegralHistory` | `{pageNum, pageSize, module, scene}` | `historyList[]{createdAt, memberName, amount, module, scene}`, `total` | `/integral`、`/recharge` 历史 |
| POST | `/api/property/integral/calcMonitor` | `{type, asinKeywords:{[asin]:[keyword...]}}` | `integral`（本次所需积分） | 添加监控弹窗打开时 |
| POST | `/api/property/integral/calcBatchMonitor` | ⚠️ 未找到调用点 | ⚠️（推测同上） | 批量添加监控 |
| GET | `/api/property/voucher/exchangeIntegral` | 无 | `isSuccess` | 代金券兑积分 |

#### 发票 / 购买记录（`/purchaseRecords`，chunk 66）

| 方法 | 路径 | 请求参数 | 响应字段 | 触发场景 |
|---|---|---|---|---|
| GET | `/api/invoice/orderHistory` | 无 | `[]{orderId, orderDesc, amount, platform, payTime, invoiceStatus}` | 页面加载 |
| GET | `/api/invoice/searchCompany` | `{keyword}` | 公司名候选 | 发票抬头联想 |
| POST | `/api/invoice/requestInvoice` | `{invoiceLine:"pc", invoiceTitleType:1\|2, buyerName, buyerTaxNum, email}` + 订单标识 ⚠️ | — | 提交开票 |

枚举（直接看到的常量）：
- `invoiceStatus`：`0` 未开票 / `1` 开票中 / `2` 已成功开票 / `3` 开票失败 / `4` 过期
- `platform`：`alipay` 支付宝支付 / `wechatpay` 微信支付 / `transfer` 对公转账
- `invoiceTitleType`：`1` 企业（税号必填）/ `2` 个人/非企业性单位
- 发票类型文案：增值税专用发票、增值税普通发票
- 规则：付款后 **365 天**内未开票即过期；税号 15/18/20 位数字或大写字母；邮箱 ≤50 位

---

### 1.7 MCP 与微信登录（各一句话，不深挖）

- **MCP（`/api/mcp/*` 18 个，`/mcp-console`，chunk 56/60）**：把 Sif 数据能力包装成 MCP 服务对外提供，
  控制台有点数总览（`points/overview`、`usage-daily`、`usage-detail`）、单把密钥轮换（`secret-key/rotate`）、
  集成 URL、订阅与加量包定价购买（`pricing/*`、`purchase/*`）、折扣码、赠送领取、运营顾问二维码。
  **goal.md 明确不做。**
- **微信（`/api/wx/*` 4 个 + `/api/wxqy/*` 2 个）**：`wx` 是公众号/开放平台扫码——用于**登录方式二（微信扫码）**
  以及账号绑定/解绑与注销时的身份验证；`wxqy` 是企业微信扫码（`getQyqr`、`checkeUserWechatQyStatus`），
  用于加运营顾问企微。**goal.md 用邮箱密码，不抄。**
- `/api/internal/*` 3 个（`addUserCountryLimit`、`addUserPrePayInfo`、`getWechatInfos`）
  看名字是**内部运营接口**，chunk 里没有调用点，非用户侧功能。
- `/api/sym/*`、`/api/sys/*` 是官网首页/视频/模型介绍等内容位，不属于账户体系。
- `/blacklist`（chunk 79）是一个静态提示页，没有任何接口调用。

---

## 二、供应商域

本期只做**入口 + 占位 UI + 表结构**，以下只反推实体字段，不涉及任何采集逻辑。

### 2.1 原站形态

**不是独立页面，是一个弹窗组件**，标题「1688 找货源」，
挂在公共 chunk `3.ba8c09db.js`（被 18 个查询页 chunk 共享）。
入口是产品图片上的「找货源」动作 —— 触发方式是 `show(img, asin)`，**以图搜货**。
说明文案：`"已为您甄选出优质的1688跨境货源，仅供参考，您可以点击右侧按钮前往1688找货源"`。

### 2.2 三个端点

| 方法 | 路径 | 前端别名 | 请求参数 | 响应字段 | 触发场景 |
|---|---|---|---|---|---|
| POST | `/api/search/1688/searchByPicture` | `p.Cb` | `{img, pageNum, pageSize, sortBy, desc}` | `{total, url, products[]}` | 打开弹窗、翻页、切排序 |
| POST | `/api/search/1688/detail` | `p.S` | `{productIds:[...]}` | `{products[]}`，前端按 `productId` 与列表行**合并补全**（`correlateArraysById`） | 列表拿到后立刻二次补全 |
| POST | `/api/search/1688/track` | `p.Eb` | 点整个列表链接：`{asin, url}`；点单个货品：`{asin, img, subject, price, monthSold, score, productId, productPage, location, minOrderQuantityStr}` | — | 点击跳转 1688 时埋点 |

三个接口都在 `3.ba8c09db.js` 里，导出别名映射已用
`"Cb",(function(){return Tt})` / `"Eb"→Nt` / `"S"→Vt` 逐一核对确认。

### 2.3 筛选条件

**只有以图搜（`img`）+ 排序 + 分页，没有关键词、类目、地区筛选。**
排序三档（`selSort` 的 `selType` 与 `sortBy`）：

| selType | sortBy | 文案 |
|---|---|---|
| 1 | `""` | 综合排序 |
| 2 | `monthSold` | 月订单量 |
| 3 | `price` | 价格 |

`desc` 布尔，同字段再点一次即翻转。提示 `"(排序仅支持当前页)"`。
分页 `pageNum` / `pageSize`（默认 10），空结果显示 `"暂无货源"`。

### 2.4 结果列表列（弹窗卡片渲染的字段）

| 展示位 | 字段 | 渲染 |
|---|---|---|
| 缩略图 | `img` | `<img :src>`，点击跳 `productPage` |
| 标题 | `subject` | |
| 价格 | `price` | 前缀 `¥` |
| 起批量 | `minOrderQuantityStr` | 后缀 `"条起批"` |
| 产地 | `location` | |
| 月订单量 | `monthSold` | 前缀 `"月订单量:"` |
| （不展示，仅埋点/关联） | `productId` | 列表→detail 的关联键 |
| （不展示，仅埋点） | `score` | 只在 `track` payload 里出现 |
| （列表级） | `url` | 「去1688查看」跳原站搜索结果页 |

### 2.5 不确定清单（供应商域）

1. `/api/search/1688/detail` 的响应体除 `products[].productId` 外具体补了哪些字段 —— 无证据。
   前端用 `Object.assign` 整体合并，**推测**是补 `score`、库存、回头率等列表接口没返的字段。
2. `score` 的量纲（评分？0-5？百分比？）无证据。
3. `price` 是单价还是价格区间字符串无证据（`minOrderQuantityStr` 带 `Str` 后缀，
   暗示同组字段可能有格式化字符串版本，但 `price` 直接参与 `¥` 拼接）。
4. `monthSold` 单位（件？笔？）无证据。
5. 是否扣积分 —— 积分规则表（`/rule`）里**没有 1688 找货源这一行**，扣费与否未覆盖。
6. 供应商（卖家/店铺）本身**没有实体**。原站只有「货品」维度，
   没有店铺名、旺旺、认证年限、回头率这类供应商字段。
   → goal.md 的 `suppliers` 表若按「供应商」建，原站无依据；按「货源商品」建才对得上。

---

## 三、系统域不确定清单

1. **邮箱注册登录在原站不存在**，`/api/user/login` 只有 `phone`。goal.md 的邮箱方案无原站参照。
2. `vipLevelSec` 完整取值域未知，只确证 `"piece"`、`"trial"` 两值，是否还有别的分支无证据。
3. `pricingAb`（A/B 定价实验开关）与 `pricingAbReady`、`useMonthlyEntryPrice()`、
   `monthlyPriceOf()`、`eggPrice1/2`、`exceptPrice1/2` 是一套灰度定价逻辑，**语义未确证**。
4. 完整权限矩阵在原站是**后端下发**（`/api/property/menu/search`），静态代码只留了 1.2 表里那几条硬编码差异。
   要做完整权限模型，主 Agent 必须自行补齐或降级为「基础/旗舰/积分三档 + 已确证差异点」。
5. `70.3804a6bc.js` 的常量 `k`（`sales:{num:2,...}`）里 `num` 的语义未确证。
6. `calcBatchMonitor` 无调用点，请求/响应结构未确证。
7. 「1元=10积分」与规则表「1元/ASIN」并存，实际扣费应为 10 积分/次，
   但小时监控实测 42 积分与基准表推不出来。**扣费必须服务端按参数计算**，不能照抄常量。
8. 团队接口里 8 个（`manager/handle`、`user/handle`、`transfer/memberIntegral`、
   `member/create|edit|remove|wechatUnbind|phoneUnbind`）的 payload 只能从表单字段推断，
   压缩代码里没有集中的 payload 字面量。
9. 所有字段的**类型、量纲、可空性**均无证据（压缩产物不含类型信息），dict 里统一标 ⚠️。
10. `/api/user/conch/info`、`/api/user/web/skip`、`/api/user/specialModel/*`、
    `/api/user/reserve/addModle`、`/api/yearreport/getMy`、`/api/campaign/track`、
    `/api/user/getCustomerCode|getCustomerTicket|updateCustomerTicket`（客服系统）、
    `/api/user/label/collectError`、`/api/user/userVideoRecord/add`、
    `/api/user/discountCodePopup*` —— **均为埋点/运营辅助/客服接入类，与账户核心模型无关**，未深挖。
11. `system.txt` 里的 `/api/user/adNote/*`（8 个）、`/api/user/focus*`（10 个）、
    `/api/user/group/*`、`/api/user/tag/*`、`/api/user/keyword*`、`/api/user/asins*`
    虽在 `/api/user/` 路径下，**实际属于业务域（广告笔记、关注词、分组、标签、词库）**，
    不是系统账户功能。主 Agent 注意这批端点归属可能与别的子 Agent 重叠。
