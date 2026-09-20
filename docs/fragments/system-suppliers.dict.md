# 系统域 + 供应商域 数据字典片段

**纪律说明**：本文件只列**我从压缩前端代码里实际看到的字段名**。
goal.md 里列的通用字段（`id`、`created_at` 等）一律不抄。
类型列几乎全部为 ⚠️ —— webpack 压缩产物不含类型信息，这是诚实结果，不是遗漏。

图例：
- ⚠️ = 类型/量纲无代码证据，仅按字段名和渲染方式推断
- 🆕 = **原站有、goal.md 未提及**的字段或概念，需主 Agent 决定是否纳入
- 来源格式：`文件名 > 依据`

---

## 1. 用户账户（原站 `/api/user/sys/info` 返回体，前端 `userInfo`）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `userid` | ⚠️ | 用户 ID，`/infor` 页「用户ID」直接展示且可复制 | `64.80eb203b.js > "用户ID"` + `userInfo.userid` |
| `username` | ⚠️ string | 姓名。规则「只支持中文、字母、数字和_（2-20 字符）」 | `64.80eb203b.js > "只支持中文、字母、数字和_（2-20 字符）"` |
| `showName` | ⚠️ string 🆕 | 展示名，与 `username` 并存 | `70`/`71` `userInfo.showName` |
| `phone` | ⚠️ string | 手机号，正则 `/^1[3-9]\d{9}$/`。**原站主登录标识** | `64.80eb203b.js` |
| `hasPassword` | ⚠️ bool | 是否已设密码 | `64`/`70` `userInfo.hasPassword` |
| `hasPw` | ⚠️ bool 🆕 | 与 `hasPassword` 并存的第二个同义标记 | `70.3804a6bc.js > userInfo.hasPw` |
| `hasWechat` | ⚠️ bool | 是否绑定微信 | `64.80eb203b.js > "已绑定"/"未绑定"` |
| `teamid` | ⚠️ | 所属团队 ID，为空即个人账号 | `70.3804a6bc.js > userInfo.teamid ? "团队" : "个人"` |
| `isSubAccount` | ⚠️ bool 🆕 | 是否为子账号 | `64.80eb203b.js > isSubAccount:{type:Boolean}` |
| `pricingAb` | ⚠️ 🆕 | A/B 定价实验分组标记，语义未确证 | `70.3804a6bc.js > userInfo.pricingAb` |

密码强度正则（可直接复用）：`/^(?=.*[a-zA-Z])(?=.*[0-9])[a-zA-Z0-9]{6,20}$/`，
来源 `64.80eb203b.js`，配套文案「需6-20位数字和字母的组合」。

> 🆕 **原站无 email 字段**。`email` 仅出现在发票模块（接收邮箱）。
> goal.md 要求邮箱登录 → 无原站参照，须自行设计。

---

## 2. 字段级权限（`/api/user/fieldPermission`）🆕

goal.md 完全未提及这一层。它不是角色，是管理员对子账号的四个开关。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `allowName` | ⚠️ bool | 允许改姓名，默认 `true` | `64.80eb203b.js > fieldPermission:{allowName:!0,...}` |
| `allowPhone` | ⚠️ bool | 允许改手机号 | 同上 |
| `allowPassword` | ⚠️ bool | 允许改密码 | 同上 |
| `allowWechat` | ⚠️ bool | 允许绑定/解绑微信 | 同上 |

关闭时文案：「管理员已禁止该项修改」/「管理员已限制修改，如需修改请联系管理员」。

---

## 3. 会员（VIP）

### 3.1 会员等级枚举 —— 三档

| 值 | 名称 | `showVip` | 来源 |
|---|---|---|---|
| `shark` | 旗舰会员 | 2 | `59.32608c5f.js > sortOptions:[{groupid:"shark",groupName:"旗舰会员"},...]` |
| `high` | 基础会员 | 1 | 同上 |
| `integral` | 积分会员（非会员，按积分付费） | 0 | 同上 + `59` `"非会员(使用积分查询)"` |

### 3.2 会员相关字段

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `vipLevel` | ⚠️ enum | 当前等级，见 3.1 | `77.cd355b4e.js > "high"==vipLevel?version="基础会员"` |
| `vipLevelName` | ⚠️ string | 后端下发的等级展示名（团队列表列「会员版本」直接渲染） | `59.32608c5f.js > label:"会员版本" → a.vipLevelName` |
| `vipLevelEnum` | ⚠️ enum | 筛选用等级值（请求参数） | `59.32608c5f.js > getTeamInfo({vipLevelEnum,...})` |
| `vipLevelSon` | ⚠️ enum 🆕 | 增购子账号的目标档位，取值 `high`/`shark` | `70.3804a6bc.js > "high"==e.vipLevelSon` |
| `vipLevelSec` | ⚠️ enum 🆕 | 二级会员形态。确证取值 `piece`（单件）、`trial`（试用） | `70`/`71` `["piece","trial"].includes(userInfo.vipLevelSec)` |
| `showVip` | ⚠️ int | 全局会员态 0/1/2，写入 Vuex | `77.cd355b4e.js` |
| `isValidVip` | ⚠️ bool | 会员是否有效 | `70.3804a6bc.js > userInfo.isValidVip` |
| `isVipTrial` | ⚠️ bool 🆕 | 是否试用中，`/vipInfor` 展示后缀「-试用」 | `77.cd355b4e.js > isVipTrial?"-试用":""` |
| `expirationDate` | ⚠️ date | 到期日，页面取 `.substring(0,10)` → **前 10 位是日期**，故为日期时间字符串 | `70.3804a6bc.js > expirationDate.substring(0,10)+"到期"` |
| `isRenewal` | ⚠️ bool | 是否已配置续费 | `77`/`70` |
| `vipRenewalInfo.vipNum` | ⚠️ int | 续费总席位数 | `77.cd355b4e.js > vipRenewalInfo.vipNum` |
| `vipRenewalInfo.vipNumHigh` | ⚠️ int | 续费基础会员数 | 同上 |
| `vipRenewalInfo.vipNumShark` | ⚠️ int | 续费旗舰会员数 | 同上 |
| `vipRenewalInfo.beginDay` | ⚠️ date | 续费期起 | 同上 |
| `vipRenewalInfo.endDay` | ⚠️ date | 续费期止 | 同上 |
| `period` | ⚠️ int 🆕 | 购买/续费周期数（年） | `70.3804a6bc.js > overviewInfo.period → periodNum` |
| `banned` | ⚠️ bool 🆕 | 成员会员资格被封禁（class `vip-level-banned`） | `59.32608c5f.js` |

### 3.3 `/api/user/vip/overview` 返回体（前端 `overviewInfo`）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `vipLevel` | ⚠️ enum | 等级 | `70.3804a6bc.js > overviewInfo.vipLevel` |
| `vipNum` | ⚠️ int | 会员席位总数 | `70` `"当前总共{vipNum}个会员账号"` |
| `vipNumHigh` | ⚠️ int | 基础会员席位数 | `70` `"其中基础会员{vipNumHigh}个"` |
| `vipNumShark` | ⚠️ int | 旗舰会员席位数 | `70` `"旗舰会员{vipNumShark}个"` |
| `isManager` | ⚠️ bool | 是否团队管理员 | `70` `overviewInfo.isManager` |
| `isRenewal` | ⚠️ bool | 是否续费单 | `70` |
| `period` | ⚠️ int | 周期 | `70` |
| `typeAppendPrice` | ⚠️ 🆕 | 各档子账号增购单价映射 | `70` `overviewInfo.typeAppendPrice` |

### 3.4 价格档位（`priceListHigh[]` / `priceListShark[]`，来自 `/api/property/menu/search`）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `id` | ⚠️ | 档位 ID，下单时作为 `chargeid` | `70.3804a6bc.js > this.chargeid=e.id` |
| `price` | ⚠️ number | 现价（元/年） | `70` `moneyFormat(e.price) + "元/年"` |
| `showPrice` | ⚠️ number | 划线原价 | `70` `class="show_price"` |
| `appendPrice` | ⚠️ number | 子账号增购单价（元/年） | `70` `appendVipPrice=c.appendPrice` |
| `model` | ⚠️ string 🆕 | 档位型号标识 | `70` `buyVipModel=c.model` |
| `active.isValid` | ⚠️ bool 🆕 | 是否有活动价生效 | `70` `c.active.isValid?curPrice=c.active.price` |
| `active.price` | ⚠️ number 🆕 | 活动价 | 同上 |

席位规格（前端硬编码）：`groupid:0` 单人版 / `1` 3人版 / `2` 6人版
（`70.3804a6bc.js > groupList:[{groupid:0,groupName:"单人版"},...]`）。

---

## 4. 积分

### 4.1 余额与统计字段

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `integral` | ⚠️ int | 个人积分余额 | `120.ca90d5d5.js > scoreBalance=a.data.integral` |
| `integralTeam` | ⚠️ int | 团队共享积分。tooltip「团队内所有成员共享的积分」 | `71.aa5862cd.js > teamInfo.integralTeam` |
| `voucher` | ⚠️ number | 代金券余额，**单位是元**（「您有价值{voucher}元的代金券」） | `120.ca90d5d5.js > ticket=a.data.voucher` |
| `integralTotalAmount` | ⚠️ number | 累计充值金额，**单位元**（「您在Sif充值过的积分总额为{n}元」） | `120.ca90d5d5.js` |
| `estIntegral` | ⚠️ int 🆕 | 预估积分（充值页 `userInfo.estIntegral`） | `120.ca90d5d5.js` |
| `integralLimit` | ⚠️ int | 当前用户每自然月消耗限额，0/空 = 不限制 | `59.32608c5f.js > "您每个自然月的积分消耗限额是：{n}个积分/月"` |
| `defaultIntegralLimit` | ⚠️ int | 团队默认月限额 | `59.32608c5f.js > teamInfo.defaultIntegralLimit` |

**换算比：1 元 = 10 积分**（`120.ca90d5d5.js > "个（1元=10个积分）"`、`"请输入积分限额，1元=10积分"`）。

### 4.2 充值档位（`/api/property/menu/search` → `data.menu[]`）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `id` | ⚠️ | 档位 ID，下单用 | `120.ca90d5d5.js > chargeid=n[0].id` |
| `integralNum` | ⚠️ int | 该档给多少积分 | `120.ca90d5d5.js > inteList:[{integralNum:0,price:0,discount:0}]` |
| `price` | ⚠️ number | 该档价格（元） | 同上 |
| `discount` | ⚠️ number | 折扣 | 同上 |
| `isValid` | ⚠️ bool | 档位是否可选（不可选的档在前置位，用 `cur.index` 偏移跳过） | `120` `e.isValid&&n.push(e)` |

### 4.3 积分流水（`/api/user/search/consumeIntegralHistory` → `historyList[]`）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `createdAt` | ⚠️ datetime | 时间（列「时间」） | `71.aa5862cd.js > _l(e.historyList,...) t.createdAt` |
| `memberName` | ⚠️ string | 成员名，仅管理员可见此列 | `71` `isManager?td(t.memberName\|\|"-")` |
| `amount` | ⚠️ int | 变动量，**带符号**（正数前端补 `+`） | `71` `t.amount>0?"+"+t.amount...` |
| `module` | ⚠️ enum | 功能模块，见 4.4 | `71` `formatModule(t.module)` |
| `scene` | ⚠️ enum | 场景/动作，见 4.5 | `71` `formatSence(t.scene,t.module)` |

请求参数：`{pageNum, pageSize, module, scene}`（`120.ca90d5d5.js > params:{pageNum:1,pageSize:10,module:null,scene:null}`）。

### 4.4 `module` 枚举（12 值，`71.aa5862cd.js` switch 分支）

| 值 | 中文 |
|---|---|
| `sys` | 系统 |
| `charge` | 收款 |
| `voucher` | 代金券 |
| `integral` | 积分分配 |
| `user` | 个人 |
| `monitor` | 坑位监控 |
| `summary` | 查流量结构 |
| `asinKeywords` | 反查流量词 |
| `compare` | 拓展流量词 |
| `keywordSearchKeyword` | 以词拓词 |
| `variantsSearchKeyword` | 竞品拓词 |
| `competeAsinAssay` | 竞品数量拓词 |
| `compete` | 竞争格局 |

### 4.5 `scene` 枚举（17 值，同上）

| 值 | 中文 |
|---|---|
| `search` | 查询 |
| `download` | 下载 |
| `present` | 赠送 |
| `presentNewUser` | 新用户注册赠送 |
| `presentMember` | 购买会员赠送 |
| `exchange` | 兑换 |
| `refund` | 退费 |
| `stop` | 停止监控 |
| `delete` | 删除 |
| `update` | 更新 |
| `updateAdd` | 修改时添加 |
| `updateDelete` | 修改时删除 |
| `autoProceed` | 自动续费 |
| `receive` | 接受者(入) |
| `allocate` | 分配者(出) |
| `receiveFromUser` | 成员积分转入团队 |
| `receiveFromTeam` | 团队积分转入个人 |
| `presentToUser` | 赠送积分给成员 |
| `presentToTeam` | 赠送积分给团队 |

### 4.6 积分预估（`/api/property/integral/calcMonitor`）

请求：`{type: 2, asinKeywords: {[asin]: [keyword, ...]}}`
（`41.f781c26c.js > (i={type:2,asinKeywords:{}}).asinKeywords[a.asin]=a.keyword`）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `type` | ⚠️ int | 请求参数，看到常量值 `2`（语义未确证） | `41.f781c26c.js` |
| `asinKeywords` | ⚠️ map | 请求参数，`{asin: [关键词]}` | 同上 |
| `data.integral` | ⚠️ int | **响应：本次操作需消耗的积分** | `41` `a.curScore=s.data.integral` |

---

## 5. 团队

### 5.1 `/api/team/search/teamInfo` 返回体（前端 `teamInfo`）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `teamid` | ⚠️ | 团队 ID | `59.32608c5f.js > teamInfo.teamid` |
| `name` | ⚠️ string | 团队名 | `59` `teamInfo.name`，「修改团队名称」 |
| `managerName` | ⚠️ string | 管理员姓名 | `59` `teamInfo.managerName` |
| `status` | ⚠️ enum | 我在团队中的身份：`manager` / `member` | `59` `"manager"==teamInfo.status` |
| `isManager` | ⚠️ bool | 是否管理员（控制全部管理 UI 显隐） | `59` `teamInfo.isManager` |
| `memberNum` | ⚠️ int | 成员数（「{n}名团队成员」） | `59` `teamInfo.memberNum` |
| `total` | ⚠️ int | 成员分页总数 | `59` `total=teamInfo.total` |
| `vipNum` | ⚠️ int | 会员席位总额（「会员额度总共{n}个」） | `59` |
| `vipNumShark` | ⚠️ int | 旗舰席位数 | `59` |
| `usedVipNum` | ⚠️ int | 已用席位（「已使用{n}个」） | `59` |
| `usedVipNumShark` | ⚠️ int | 已用旗舰席位 | `59` |
| `vipExpirationDate` | ⚠️ date | 团队会员到期时间 | `59` `teamInfo.vipExpirationDate` |
| `isRenewal` | ⚠️ bool | 是否有续费单 | `59` |
| `vipRenewalInfo` | ⚠️ obj | 同 3.2（`vipNum`/`vipNumHigh`/`vipNumShark`） | `59` |
| `integralTeam` | ⚠️ int | 团队共享积分 | `71` |
| `integralLimit` | ⚠️ int | 我的月限额 | `59` |
| `defaultIntegralLimit` | ⚠️ int | 团队默认月限额 | `59` |
| `memberInfos` | ⚠️ array | 成员列表，见 5.2 | `59` `memberList=teamInfo.memberInfos` |

请求参数：`{pageNum, pageSize, vipLevelEnum, name, status, sortField:"username", sortOrder}`
（`59.32608c5f.js > getTeamInfo`），`status` 传 `"pending"` 表示只看待激活。

### 5.2 团队成员（`memberInfos[]`，即成员列表表格行）

| 字段名 | 类型 | 列名 | 来源 |
|---|---|---|---|
| `memberid` | ⚠️ | — | `59.32608c5f.js > memberInfo.memberid`（所有成员操作的入参） |
| `username` | ⚠️ string | 姓名 | `59 > label:"姓名" → a.username` |
| `vipLevelName` | ⚠️ string | 会员版本 | `59 > label:"会员版本" → a.vipLevelName` |
| `vipLevel` | ⚠️ enum | —（内部判定） | `59 > "high"==e.vipLevel?"基础会员":""` |
| `phone` | ⚠️ string | 手机号 | `59 > label:"手机号" → a.phone` |
| `hasWechat` | ⚠️ bool | 微信（已绑定/未绑定） | `59 > label:"微信" → a.hasWechat` |
| `integralTeamLimit` | ⚠️ int | 每月限额（空 = 不限制） | `59 > label:"每月限额" → a.integralTeamLimit` |
| `integralConsumeMonth` | ⚠️ int | 本月积分消耗 | `59 > label:"本月积分消耗" → a.integralConsumeMonth` |
| `integralConsumeTotal` | ⚠️ int | 累计积分消耗 | `59 > label:"累计积分消耗" → a.integralConsumeTotal` |
| `lastLoginAt` | ⚠️ datetime | 最近登录 | `59 > label:"最近登录" → a.lastLoginAt` |
| `isManager` | ⚠️ bool | —（管理员不进可分配列表） | `59 > !t.isManager&&t.isAgreeJoin&&allMember.push(t)` |
| `isAgreeJoin` | ⚠️ bool 🆕 | 是否已同意入团（否则「待激活」） | 同上 |
| `banned` | ⚠️ bool 🆕 | 会员资格封禁态 | `59 > class:{"vip-level-banned":a.banned}` |
| `vipid` | ⚠️ 🆕 | 分配给该成员的会员席位 ID | `70.3804a6bc.js > push(e.vipid)`、`vipIdInfo.vipid` |
| `username`（分配视角） | ⚠️ | 「账号使用人」，空显示「未分配使用者」 | `70 > e.username\|\|"未分配使用者"` |

### 5.3 入团状态（`/api/team/search/joinTeamPreInfo` → 前端 `teamInfor.status`）🆕

| 值 | 含义 | 来源 |
|---|---|---|
| `none` | 未加入，可点「加入团队」 | `78.071f0c8b.js > "none"==teamInfor.status` |
| `applyJoin` | 已申请，等待管理员同意 | `78 > "applyJoin"==...` |
| `member` | 已加入 | `78 > "member"==...` |
| `otherMember` | 已属于其他团队 | `78 > "otherMember"==...` |

> 🆕 **原站只有 manager / member 两个角色**，无角色表、无自定义权限组。
> goal.md 的 `roles` / `user_roles` 在原站无依据。细粒度控制走 `fieldPermission`（见 §2）+ 积分月限额。

---

## 6. 订单与发票

### 6.1 购买记录（`/api/invoice/orderHistory`）

| 字段名 | 类型 | 列名 | 来源 |
|---|---|---|---|
| `orderId` | ⚠️ string | 订单号 | `66.bd7049c1.js > label:"订单号",prop:"orderId"` |
| `orderDesc` | ⚠️ string | 购买详情 | `66 > label:"购买详情",prop:"orderDesc"` |
| `amount` | ⚠️ number | 金额 | `66 > label:"金额"` + `r.amount` |
| `platform` | ⚠️ enum | 支付方式，见 6.3 | `66 > PLATFORM_LABEL[i.platform]` |
| `payTime` | ⚠️ datetime | 购买时间 | `66 > label:"购买时间",prop:"payTime"` |
| `invoiceStatus` | ⚠️ int enum | 开票状态，见 6.3 | `66 > STATUS_CONFIG[r.invoiceStatus]` |

### 6.2 开票申请（`/api/invoice/requestInvoice` 请求体）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `invoiceLine` | ⚠️ string | 固定值 `"pc"` | `66 > form:{invoiceLine:"pc",...}` |
| `invoiceTitleType` | ⚠️ int | `1`=企业（税号必填）/ `2`=个人/非企业性单位 | `66 > 1===form.invoiceTitleType?historyData.enterprise:...personal` |
| `buyerName` | ⚠️ string | 发票抬头，必填 | `66 > label:"发票抬头",prop:"buyerName"` |
| `buyerTaxNum` | ⚠️ string | 税号，企业必填。规则「15/18/20位数字或大写字母」 | `66 > label:"税号",prop:"buyerTaxNum"` |
| `email` | ⚠️ string | 接收邮箱，≤50 位 | `66 > label:"电子邮箱",prop:"email"` |

### 6.3 枚举

`invoiceStatus`（`66.bd7049c1.js > STATUS_CONFIG`，**代码原样**）：

| 值 | 标签 |
|---|---|
| `0` | 未开票 |
| `1` | 开票中 |
| `2` | 已成功开票 |
| `3` | 开票失败 |
| `4` | 过期 |

`platform`（`66.bd7049c1.js > PLATFORM_LABEL`）：

| 值 | 标签 |
|---|---|
| `alipay` | 支付宝支付 |
| `wechatpay` | 微信支付 |
| `transfer` | 对公转账 |

规则：付款后 **365 天**内未开票即过期（`66 > "该订单未在付款后365天期限内完成开具发票，已过期"`）。
微信支付上限 **3000 元**（`70.3804a6bc.js > finalPrice<3e3` 才渲染微信按钮）。

### 6.4 下单请求体（`/api/property/order/producer`）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `platform` | ⚠️ enum | `wechatpay` / `alipay`（`3` = 对公转账走线下） | `70.3804a6bc.js > 1==t?platform="wechatpay":2==t&&(platform="alipay")` |
| `chargeType` | ⚠️ enum | 订单类型。看到取值 `vip`（购买）、`vipRenewal`（续费）、`vipAppend`（增购子账号） | `70 > middleType="vipRenewal"` / `"vipAppend"` / `"vip"` |
| `vipLevel` | ⚠️ enum | `high` / `shark`；续费场景为 `"mix"` | `70 > t.vipLevel="mix"` |
| `chargeid` | ⚠️ | 价格档位 ID | `70` |
| `typeAppendNum` | ⚠️ obj | `{shark: n, high: n}` 增购数量 | `70 > typeAppendNum:{shark:t.sharkNum,high:t.highNum}` |
| `typeVipids` | ⚠️ obj 🆕 | 席位 ID 映射（续费/升级指定席位） | `70 > typeVipids:t.typeVipids` |
| `period` | ⚠️ int | 周期数 | `70` |
| `inviter` | ⚠️ | 邀请人（取 URL query `inviter`） | `70 > inviter:u.j.qs("inviter")\|\|null` |
| `discountCode` | ⚠️ string | 优惠码（`codeMsg==1` 时才带） | `70 > 1==e.codeMsg&&(s.discountCode=...)` |

---

## 7. 供应商 / 1688 货源（业务表）

**重要**：原站**没有「供应商/店铺」实体**，只有「货源商品」。
没有店铺名、旺旺号、认证年限、回头率、主营类目等任何供应商属性。

### 7.1 货源商品（`/api/search/1688/searchByPicture` → `data.products[]`）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `productId` | ⚠️ | 1688 商品 ID。**列表与 detail 的关联键** | `3.ba8c09db.js > ids.push(e.productId)`、`correlateArraysById(...,"productId")` |
| `img` | ⚠️ string(url) | 商品图 URL | `3 > <img :src="e.img">` |
| `subject` | ⚠️ string | 商品标题 | `3 > class="title" → e.subject` |
| `price` | ⚠️ number | 价格，渲染为 `¥{price}` | `3 > "¥"+e.price` |
| `minOrderQuantityStr` | ⚠️ string | 起批量，渲染为 `{n}条起批`。带 `Str` 后缀，**是格式化字符串而非数字** | `3 > e.minOrderQuantityStr+"条起批"` |
| `location` | ⚠️ string | 产地/所在地 | `3 > class="location" → e.location` |
| `monthSold` | ⚠️ number | 月订单量，渲染为 `月订单量:{n}`。也是排序字段之一 | `3 > "月订单量:"+e.monthSold` |
| `score` | ⚠️ number | 评分/分值。**列表 UI 不展示，只出现在 track 埋点 payload** | `3 > track({...score:e.score,...})` |
| `productPage` | ⚠️ string(url) | 1688 商品详情页链接，点卡片时 `window.open` | `3 > openLink(e.productPage,e)` |

### 7.2 列表级返回字段

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `total` | ⚠️ int | 结果总数，0 时显示「暂无货源」 | `3 > t.total=n.data.total\|\|0` |
| `url` | ⚠️ string(url) | 1688 搜索结果页链接，「去1688查看」用 | `3 > t.linkUrl=n.data.url` |
| `products` | ⚠️ array | 货源列表 | `3 > t.goodsList=n.data.products` |

### 7.3 搜索请求参数（`params`）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `img` | ⚠️ string(url) | **以图搜货的图片地址**（唯一检索条件） | `3 > params:{img:"",...}`、`show(t,e){this.params.img=t}` |
| `pageNum` | ⚠️ int | 页码，默认 1 | `3 > params:{...pageNum:1,...}` |
| `pageSize` | ⚠️ int | 每页条数，默认 10 | 同上 |
| `sortBy` | ⚠️ enum | `""`（综合）/ `monthSold`（月订单量）/ `price`（价格） | `3 > selSort(2,"monthSold")` / `selSort(3,"price")` |
| `desc` | ⚠️ bool | 降序，默认 `true`，同字段再点翻转 | `3 > params.sortBy===e&&(params.desc=!params.desc)` |

### 7.4 点击埋点（`/api/search/1688/track` 请求体）

- 点「去1688查看」（整个列表）：`{asin, url}`
- 点单个货源卡片：`{asin, img, subject, price, monthSold, score, productId, productPage, location, minOrderQuantityStr}`

来源 `3.ba8c09db.js > linkOne()` 与 `openLink()`。
→ 这份 payload 是**货源实体字段的完整闭包**，可直接当表结构参照。

### 7.5 `/api/search/1688/detail` 请求/响应

- 请求：`{productIds: [productId, ...]}`（`3 > p.S({productIds:t.ids})`）
- 响应：`{products: [...]}`，前端按 `productId` 与列表行 `Object.assign` 合并
- ⚠️ **具体补了哪些字段无证据**。合并动作说明它返回列表接口没给的字段，但代码里看不出是哪些。

---

## 8. 需主 Agent 裁决 —— 原站有但 goal.md 未提及

| 序号 | 项 | 我的观察 |
|---|---|---|
| 1 | `fieldPermission`（4 个布尔字段级开关） | 原站细粒度权限的**真正载体**，比角色表更贴近实际。goal.md 未提。 |
| 2 | `vipLevelSec` = `piece` / `trial` | 除三档主等级外还有「单件」「试用」两种二级形态。 |
| 3 | 积分**自然月**限额（`integralLimit` / `defaultIntegralLimit` / `integralTeamLimit`） | 原站的「配额」就是这个，不是查询次数。三级：团队默认 → 成员特殊 → 我的当前。 |
| 4 | 团队席位模型（`vipid` / `usedVipNum` / 「未分配使用者」） | 会员是**可分配的席位资产**，不是用户属性。goal.md 无对应概念。 |
| 5 | 会员资格加入团队即转移 | 强业务规则：`"会员资格所有权将转移到团队，管理员有权取消您的会员资格并删除您的账号"`。 |
| 6 | 移出成员是异步长任务 | `remove` → `removeProgress` 轮询 → `removeMonitorPreview`，且账号会「锁定」。 |
| 7 | 代金券（`voucher`，元）→ 积分 | 独立于充值的第二种积分来源。 |
| 8 | 发票模块（`invoiceStatus` 5 值 + 365 天窗口 + 抬头历史） | goal.md 未提发票。若不做，购买记录页也要相应简化。 |
| 9 | 优惠码（`discountCode` / `discount` / 用户券包） | 下单链路的一环。 |
| 10 | A/B 定价（`pricingAb` / `useMonthlyEntryPrice` / `eggPrice`） | 灰度定价实验，建议本期直接不做。 |
| 11 | `showName` 与 `username` 并存、`hasPw` 与 `hasPassword` 并存 | 原站有历史冗余，新库不必照抄。 |
| 12 | 「供应商」应建为「货源商品」 | 见 §7 开头。按 goal.md 字面建 `suppliers` 会与原站语义错位。 |
| 13 | `api_keys` 表无原站依据 | 详见 spec §1.4。原站唯一密钥功能在 MCP（单密钥 + rotate），`/datacenter` 是营销页。 |
| 14 | 邮箱字段无原站依据 | 原站以 `phone` 为登录标识，`email` 只用于发票收件。 |
