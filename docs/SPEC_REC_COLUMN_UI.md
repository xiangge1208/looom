# 「查推荐专栏」原站高保真复刻规格

对标 `https://www.sif.com/recommend?country=US&asin=<ASIN>`。
抓样 ASIN `B07N7GDB6Q`，抓取日 2026-09-22，视口 1600×1000。

本文只记**实测**：DOM computed style、canvas 逐像素采样、CSSOM 全文解析、
接口真实请求/响应。凡推断均标注。配套文档：

- `PLAN_REC_COLUMN.md` —— 实现计划与范围
- `AUDIT_REC_COLUMN_DATA.md` —— 数据可支撑性核查（**先读这篇**，结论是当前不具备实现条件）

---

## 0. 技术栈判定

| 项 | 判定 | 依据 |
|---|---|---|
| 框架 | Vue 2 | SFC scoped hash `data-v-*`，无 `__vue_app__` |
| UI 库 | **Element UI 2.x**（非 Plus） | `el-*` 类名、`chunk-element.js` |
| 图表 | **ECharts 5** | `chunk-echarts` + `chunk-zrender` 独立分包；轴文本 `#6e7079` 是 v5 默认值 |
| 截图导出 | html2canvas 1.4.1 | CDN 引入，「下载图表」用 |
| 构建 | Webpack | `manifest.*.js` + 数字命名 chunk |
| CDN | `www-static.sif.com` | CSS 合计 1.58 MB |

**认证**：`Authorization: <裸 JWT>`，**不带 `Bearer` 前缀**。token 存
`localStorage.token`，载荷 `{userSalt, exp, userid, platform}`。实测四种写法只有
裸值返回 `code:1`，其余均 `code:-10 UNAUTHORIZED`。

> 探查期间我曾因自己的 `fetch` 漏掉这个头而误判"会话过期"，进而误推出
> "未授权会跳首页"。**该跳转行为未经验证**，是推断。

---

## 1. 设计 token

统计 2912 个可见元素的 computed style，按频次排序。

### 1.1 色彩

```css
:root {
  --primary-color: #009f52;   /* ★ 品牌主色：绿 */
  --warning-color: #fdcb02;
  --text-color:    #181818;
}
```

`--primary-color` 是从 CSSOM 取到的**实际值**。Element 主题已整体改绿：Tab 激活、
输入框 focus、loading spinner 全部走它。蓝色 `#3A58FF` 只是链接/数值高亮色。

| 语义 | 值 | 用量 | 用途 |
|---|---|---|---|
| text-primary | `#181818` | 843 | 正文（非纯黑） |
| text-secondary | `#5E5E5E` | 132 | 表头、次要说明 |
| text-tertiary | `#8B8B8B` | 33 | 弱化文本 |
| **brand** | **`#009F52`** | 39 | Tab 激活、次要按钮描边、spinner |
| link | `#3A58FF` | 72 | 链接、可点数值 |
| success-alt | `#26AD6C` / `#009E2C` | 12/8 | 上涨数值 |
| danger | `#D95140` | 23 | 下跌数值、插件安装按钮实底 |
| bg-page | `#F8F8FA` | 22 | 页面底色 + 表头底色 |
| bg-card | `#FFFFFF` | 54 | 卡片 |
| bg-tips | `#FFF5EE` | 1 | 提示条暖底 |
| border-card | `#F1F2F5` | 6 | 卡片描边 |
| border-table | `#EBEEF5` | 2 | 表格分隔线（Element 默认） |
| border-btn | `#D6DBE3` | 5 | 次要按钮描边 |
| border-input | `#C0C4CC` | 14 | 表单描边（Element 默认） |

### 1.2 图表分类色盘

主图 canvas 逐像素采样。与表格 badge 底色（同色 16% alpha）严格同源。

```js
const REC_COLUMN_PALETTE = [
  '#33B99D',  // 主青绿（占比最高系列，3185 px）
  '#73BE00',  // 黄绿   badge rgba(115,190,0,.16)
  '#F26AB0',  // 品红   badge rgba(242,106,176,.16)
  '#13BFE5',  // 天蓝   badge rgba(19,191,229,.16)
  '#846C04',  // 橄榄棕 badge rgba(132,108,4,.16)
  '#557DE8',  // 靛蓝   badge rgba(85,125,232,.16)
  '#8AB0F7', '#EC690D', '#AA7AEB', '#690E49', '#BC755D',
];
const AREA_TINTS = ['#E0E6F1', '#D1DAEE', '#C0D0F2'];  // 堆叠面积填充三层
const AXIS_LABEL = '#6E7079';   // ECharts 5 默认，勿改
```

### 1.3 排版

```css
--font-sans: system-ui, -apple-system, BlinkMacSystemFont, PingFangSC-Regular,
             "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;  /* 1135 元素 */
--font-display: SourceHanSans, sans-serif;  /* 109 元素：大数字/标题 */
```

`body` 声明的是 `"Noto Sans SC"`，但实际继承上面这条系统栈。

**13px 是主力字号（541 次），不是 14px。**

| token | 值 | 用量 | 行高 | 场景 |
|---|---|---|---|---|
| xs | 12px | 424 | 20px | 辅助信息、badge、ASIN 元数据 |
| **sm** | **13px** | **541** | 21px | 表格正文 + 表头 |
| base | 14px | 230 | 23px | 正文、Tab、tooltip |
| md | 16px | 76 | 28px | 区块小标题 |
| lg | 18px | 27 | — | 卡片标题 |
| xl | 20px | 7 | — | 统计数值 |
| 3xl | 32px | 3 | 42/46px | 页面主标题 |

字重 4 档：400(1095) / 500(158，表头) / 600(40，Tab 激活) / 700(21)。

### 1.4 圆角 / 阴影 / 布局常量

```css
--radius-sm:   3px;           /* 12次 小 badge */
--radius-md:   4px;           /* 35次 按钮、tooltip、tips 条 */
--radius-lg:   6px;           /* 5次  section 卡片 */
--radius-pill: 15px;          /* 27次 药丸下拉（是 15px，不是 999px） */
--radius-tab:  4px 4px 0 0;   /* 6次  Tab 头 */

--shadow-card:    0 2px 12px 0 rgba(182,181,177,.4);  /* 暖灰，非中性黑 */
--shadow-header:  0 0 10px 0 #DDDDDD;
--shadow-tooltip: 1px 2px 10px 0 rgba(0,0,0,.2);
```

```
页面左右留白     50px（section margin: 0 50px 30px）
内容区宽度       viewport − 100px（1600 视口 → 1485px）
顶栏             60px + 1px 投影 = 61px，内边距 0 50px
功能 Tab 条      48px，白底，通栏无留白
section 间距     margin-bottom 30px（统计条例外，10px）
section 内距     16px 0 25px（左右由子元素 20px 承担）
响应式           无。顶栏与主体均有 .need_min_width
```

---

## 2. 组件层级树

文档高 2923px，内容宽 1585px。

```
body.has-asin-search
└─ div.app-pc-mobile.sif-app-pc
   ├─ header.need_min_width ················ 1585×61   shadow-header
   │  └─ div.router-link  flex/center  pad:0 50px
   │     ├─ a > Logo ····················· 42×60
   │     ├─ nav 14 项主导航 ············· 1321×60
   │     │   查销量/查流量(词)/运营时光机/查广告打法/多产品对比/产品时光机/
   │     │   拓词&筛查/选词/查坑位·推排名/产品库·词库/AI工具/更多/下载插件/购买会员
   │     └─ div.user ····················· 用户名 +「YYYY-MM-DD到期」
   │
   └─ div.need_min_width  (pad-top:1px)
      ├─ div.recommend ··················· 1585×2596
      │  ├─ [A] div ····················· 1585×150  页标题「查推荐专栏」32px
      │  │
      │  ├─ [B] div.complex-asin-container.section_block.hor_padding
      │  │       1485×128 @50,212  flex/space-between/center
      │  │       pad:12px 20px  bg:#FFF  br:6px  bd:1px #F1F2F5  shadow-card
      │  │   ├─ 主图 + ASIN + 标题 + $16.89 4.6(219,053)
      │  │   ├─ 卖家 / 变体 / 品牌
      │  │   ├─ BSR 块「#1 in Pillow Inserts」「#15 in Home & Kitchen」+ [更新]
      │  │   └─ 6 指标格：变体16 / 30天销量10,000+ / 7天流量得分124,754(-3%)
      │  │        / 7天流量词917(+179) 自然899(+166) 广告122(+63)
      │  │        / 7天广告活动 6活跃 0新增 / 7天推荐专栏 5(+0)
      │  │
      │  ├─ [C] div.common_asin_search ··· 1585×48 @0,370  bg:#FFF 通栏
      │  │   9 功能 Tab（末项 is-active）
      │  │   查销量·查流量结构·反查流量词·运营时光机·查多变体自然位
      │  │   ·查广告架构·查广告组·查广告词·【查推荐专栏】
      │  │
      │  └─ [D] section ·················· 1585×2220 @0,438
      │     ├─ [D1] div.tips_wrap.tips_wrap_center.section_block
      │     │       1485×82 @50,438  bg:#FFF5EE  br:4px  pad:8px 6px
      │     │   ├─ div.tips_content ····· 3 行 ①②③，行高 20px
      │     │   └─ div.install ·········· button 184×29 bg:#D95140 br:4px
      │     │
      │     ├─ [D2] div.section_block ··· 1485×492 @50,550  ★主图表卡
      │     │   ├─ div.has_line (1483×47, pad:0 20px 16px, 底部分隔线)
      │     │   │   ├─ span.click_tip「图表可点击切换时间」(126×18)
      │     │   │   └─ div.downloadPolorBtn 70×30 bd:1px #D6DBE3「下载图表」
      │     │   └─ div.chart_container (1483×386, mar-top:16px)
      │     │        └─ canvas 1483×386 (dpr 1.0) ★ECharts #1
      │     │
      │     ├─ [D3] div.overview_container.section_block
      │     │       1485×83 @50,1072  flex/space-between  gap:20px
      │     │       mar:0 50px 10px   ← 此处 10px，非 30px
      │     │   └─ 3 × div (481×81, pad:20px)
      │     │        获得的推荐专栏 5 / 广告活动数量 3 / 广告词数量 35
      │     │
      │     ├─ [D4] div.section_block.recViewTable_container
      │     │       1485×661 @50,1165  pad:16px 0 0
      │     │   ├─ div (1483×46)「…获得了5个推荐专栏」+「下载搜索结果」
      │     │   └─ div.sif-table-wrap.simple.search-bar (1483×597)
      │     │        └─ el-table 8列×5行，行高 105px ★含 10 sparkline
      │     │
      │     └─ [D5] div.section_block.tab_pane
      │             1485×802 @50,1856  pad:0 0 25px
      │        └─ el-tabs.el-tabs--top (1483×775)
      │           ├─ header 高 60px
      │           │   ├─ tab「广告活动视角」114×60 is-active
      │           │   ├─ tab「广告词视角」  100×60
      │           │   └─ el-tabs__active-bar 84×2 bg:#009F52
      │           └─ content
      │              ├─「共有3个广告活动在推荐专栏有曝光，其中0个已备注名称」
      │              ├─ 筛选：el-select 筛选推荐专栏 / 筛选广告类型
      │              │    (el-input__inner 95×40, br:15px 药丸)
      │              ├─ el-table 7列×3行 ★含 3 sparkline
      │              └─ el-pagination「1 前往页」
      │
      ├─ div ····························· 1585×235 @0,2688  底部科普区
      │  ├─ p.explain-title「"查推荐位"有什么用？」
      │  ├─ ul.miaokeList > span.video「播放秒懂视频」← drawer 触发点
      │  └─ ul「推荐阅读与观看」→ 2 条 span.link
      │
      └─ div.retract ····················· 24×24 @1546,881  br:50%  侧边收起

  [惰性挂载 · display:none]
      ├─ el-dialog__wrapper ×54  含「出现在推荐专栏 xx 的广告词」「旗舰会员专享功能」
      ├─ el-drawer__wrapper  ×2  「秒懂视频 / 详解视频」
      └─ el-date-editor--week / --month  周/月选择器
```

---

## 3. 组件规格

| 组件 | 尺寸 | 样式 |
|---|---|---|
| 插件安装按钮 | 184×29 | `bg:#D95140 色:#FFF br:4px pad:6px 12px fs:13.33px` |
| 下载图表按钮 | 70×30 | `bd:1px #D6DBE3 br:4px 色:#4B4B4B fs:13px pad:0 8px` |
| Tab 项 | 114×60 / 100×60 | `色:#009F52 fs:14px fw:600 pad:0 15px` |
| Tab 指示条 | 84×2 | `bg:#009F52` |
| 筛选下拉 | 95×40 | `bg:#FFF br:15px pad:2px 8px 2px 0 cursor:pointer` |
| ASIN 信息卡 | 1485×128 | `bg:#FFF bd:1px #F1F2F5 br:6px shadow-card pad:12px 20px` |
| 提示条 | 1485×82 | `bg:#FFF5EE bd:1px #F1F2F5 br:4px pad:8px 6px` |
| 收起按钮 | 24×24 | `bg:#FFF br:50%` |
| 表头单元格 | 高 71 | `bg:#F8F8FA 色:#5E5E5E fs:13px fw:500 pad:12px 0 bd-b:1px #EBEEF5` |
| 表体单元格 | 行高 105 | `pad:12px 0 bd-b:1px #EBEEF5` |

### 3.1 主表格列定义（[D4]）

8 列，末列为 Element gutter 占位（0 宽）。

| # | 列名 | 宽 | 对齐 | 内容 |
|---|---|---|---|---|
| 1 | `#` | 80 | center | 序号 |
| 2 | 推荐专栏名称 | 179 | left | `recTitle` |
| 3 | 流量占比 | 119 | right | `ratio` → `70%` |
| 4 | 广告活动数量 | 129 | right | 蓝色 `.link`，**dialog 触发点** |
| 5 | 广告词数量 | 119 | right | 蓝色 `.link`，**dialog 触发点** |
| 6 | 广告活动类型占比(手动-自动) | 338 | center | 降级文案，见下 |
| 7 | 获得该推荐专栏的<br>广告活动数量及趋势 | 259 | center | 数值 + sparkline 200×80 |
| 8 | 获得该推荐专栏的<br>广告词数量及趋势 | 259 | center | 数值 + sparkline 200×80 |

第 6 列降级判定：实测 `campaignTypeEnable: true` 但 `manualRatio/autoRatio` 全为
`0.0`，**仍渲染占位文案**「需自动同步后台广告活动才能计算 + [一键自动同步]」。
所以条件是 `manualRatio + autoRatio === 0`，**不是那个 flag**。这是易踩点。

### 3.2 伪类状态（CSSOM 实测，1.58 MB 全文解析）

```css
/* Tab —— 默认态即为绿色，非灰 */
.el-tabs__item             { color:#009f52; }
.el-tabs__item:hover       { color:#009f52; cursor:pointer; }
.el-tabs__item.is-active   { color:#009f52; font-weight:600; }
.el-tabs__item.is-disabled { color:#c0c4cc; cursor:default; }

/* 表格行 hover —— 反直觉：原站主动关闭了高亮 */
.table[data-v-*] .el-table--enable-row-hover .el-table__body tr:hover>td { background:#fff; }
/* 未被 scoped 覆盖的表格才走 Element 默认 */
.el-table--enable-row-hover .el-table__body tr:hover>td { background:#f5f7fa; }

/* 输入框 focus */
.el-input__inner:focus { outline:none; border-color:#009f52!important; background:#fff!important; }

/* 下拉项 —— 选中态仍是 Element 默认蓝，未主题化 */
.el-select-dropdown__item:hover      { background:#f5f7fa; }
.el-select-dropdown__item.selected   { color:#409eff; font-weight:700; }
.el-select-dropdown__item.is-disabled{ color:#c0c4cc; cursor:not-allowed; }

/* 按钮 —— Element 默认，未主题化 */
.el-button:hover      { color:#409eff; border-color:#c6e2ff; background:#ecf5ff; }
.el-button:active     { color:#3a8ee6; border-color:#3a8ee6; }
.el-button.is-disabled{ color:#c0c4cc; cursor:not-allowed; background:#fff; border-color:#ebeef5; }

/* 本页专属 */
.downloadPolorBtn.is-disabled { color:#c5c5c5!important; cursor:not-allowed!important; }
```

**复刻要点**：这是"半主题化"——只把 `--primary-color` 换绿，下拉选中和按钮
hover 保持 Element 默认蓝。全改绿反而不像原站。

### 3.3 Loading / Empty / 遮罩

```css
.el-loading-mask { background:rgba(255,255,255,.9); z-index:900; }  /* 非骨架屏 */
.el-loading-spinner svg circle.path { fill:none; stroke:#009f52; stroke-width:2px; }
[data-v-*] .el-loading-spinner { height:200px; line-height:200px; margin:0; }
.el-table__empty-text { }   /* 文案「暂无数据」，Element 默认 */
```

遮罩挂载在 3 个具体容器上：`.complex-asin-container`、`.section_block`、
`.campaign_view_container`。

**弹窗遮罩被关闭**：dialog 打开时 `.v-modal` 数量为 **0**，
`el-dialog__wrapper` 自身 `background:rgba(0,0,0,0)`、`z-index:2005`。
即背景不变暗。复刻要显式 `:modal="false"` 或覆盖 `.v-modal{display:none}`。

---

## 4. 交互行为与状态机

### 4.1 首屏加载序列

统一 query：`?country=US&_t=<ms>&_m=<sessionId>`。

```
GET  /api/sys/modelIntroduce/search?model=asinAdRec   → [D1] 科普文案 ①②③
POST /api/search/rec/trends      {asin, timeDim:"week"}                 → [D2] 主图
POST /api/search/rec/overview    {asin, timePieceType, timePieceValue}  → [D3] 三统计
POST /api/search/rec/recView     {同上}                                  → [D4] 主表
POST /api/search/rec/campaignView{同上}                                  → [D5] Tab1
GET  /api/user/specialModel/status?model=asinAdRec    → 是否弹权限墙
```

响应统一信封 `{code:1, commonMsg:null, message:null, data:{...}}`；
未授权 `{code:-10, message:"UNAUTHORIZED"}`。

### 4.2 交互映射（★ = 实测纠正了先前的推断）

| 元素 | 事件 | 行为 |
|---|---|---|
| 主图柱体 | click | 切换时间上下文 → 局部刷新 `overview`+`recView`+`campaignView`，**主图不重取** |
| 主图 | mousemove | 6 列 × 22 行宽 tooltip（纯前端 `trigger:'axis'`） |
| 下载图表 | click | html2canvas 截 `.chart_container` → PNG |
| Tab 切换 | click | **局部刷新**，非跳转。切词视角时请求 `rec/keywordView` |
| 筛选下拉 | change | **纯前端过滤**（`recTitles` 已随 campaignView 返回，无请求） |
| ★ 表格蓝色数字 `.link` | click | 打开 dialog「出现在推荐专栏 xx 的广告词」 |
| ★ 「查看广告活动详情」 | click | **新标签页跳转**，非 drawer：<br>`/adxray-structure?country=US&campaignId=<id>&asins=<asin>&fromPage=webSnapshot&asin=<asin>` |
| ★ 「播放秒懂视频」`span.video` | click | 打开视频 drawer（页面里那 2 个 drawer 是视频，不是活动详情） |
| 手动备注名称 | click | 行内编辑 → 提交备注 |
| 9 功能 Tab | click | 整页路由跳转，保留 `asin` + `country` |
| `.retract` | click | 收起/展开侧边区 |

> 先前我把「推荐专栏名」当作 dialog 触发点、把「查看广告活动详情」当作 drawer，
> 两处都错了。实测触发 dialog 的是**第 4/5 列的蓝色数字**。

### 4.3 状态机

```
                    ┌─────────┐
       进入页面 ────▶│ loading │ el-loading-mask（非骨架屏）
                    └────┬────┘
        ┌────────────┬───┴────────┬──────────────┐
        ▼            ▼            ▼              ▼
   ┌────────┐  ┌────────┐  ┌────────┐  ┌────────────┐
   │ ready  │  │ empty  │  │ locked │  │unauthorized│
   │ 渲染   │  │无推荐位│  │会员墙  │  │ 行为未验证 │
   └───┬────┘  └────────┘  └────────┘  └────────────┘
       ├─ hover 图表  → tooltip
       ├─ click 图表  → 时间上下文变更 → 三区局部 reload
       ├─ switch tab  → campaignView ⇄ keywordView
       └─ click 数字  → dialog
```

`empty` 判定：`overview.recCnt === 0`。

### 4.4 Dialog 规格

```
触发：主表第 4/5 列 span.link
尺寸：900×732，margin-top:120px，br:8px
阴影：0 1px 3px 0 rgba(0,0,0,.3)   ← 很浅，只有 3px
标题：「出现在推荐专栏 <recTitle> 的广告词」
      h:54px pad:0 17px fs:16px fw:500 色:#000
      （覆盖了 Element 默认 18px/#303133/下边框）
Body：pad:0 24px，无 max-height，无滚动
表格：7 列（末列 0 宽 gutter），行数 = 该专栏 keywordCnt（实测 32）
      # [89,center] · 广告搜索词 [195,left] · 流量占比 [124,right]
      · 出现天数 [124,right] · 广告活动数量 [142,right] · 历史排名趋势 [178,center]
内嵌：5 个 sparkline，158×80（注意与主表的 200×80 不同）
      配色 #009f52(绿) + #ed912f(橙)
关闭：button.el-dialog__headerbtn > i.el-icon-close
      16×20，top:20px right:20px，fs:16px
```

### 4.5 Drawer 规格

```
触发：.video_explan_model span.video
类名：el-drawer btt          ← 自底向上
尺寸：1600×900 @y100（inline style: height:90%），全宽
圆角：0
阴影：0 8px 10px -5px rgba(0,0,0,.2),
      0 16px 24px 2px rgba(0,0,0,.14),
      0 6px 30px 5px rgba(0,0,0,.12)
Header：h:60px pad:16px bd-b:1px #F1F2F5
        内嵌标题 Tab：span.active「秒懂视频」+ span「详解视频」
        active: 色:#009f52 fw:600 bd-b:1px #009f52
Body：  pad:5px 50px 0
媒体：  <video src="https://gonglan-monitor.oss-cn-shenzhen.aliyuncs.com/Video/recommand.mov">
```

---

## 5. 图表还原指南

### 5.1 清单

| # | 位置 | 尺寸 | 类型 | 数据源 |
|---|---|---|---|---|
| 1 | [D2] 主图 | 1483×386 | 堆叠柱/面积，22 系列 × 144 周，双轴 | `rec/trends` |
| 2–11 | [D4] 表格内 | 200×80 | sparkline（无轴无网格），7 点 | `recView.*Trends` |
| 12–14 | [D5] 表格内 | 200×80 | 同上，多系列 | `campaignView[].recTrends` |
| 15–19 | dialog 内 | 158×80 | 同上 | dialog 数据 |

`dpr=1.0`（原站未做高清适配，复刻建议改用 `devicePixelRatio`）。

### 5.2 主图配置

```js
const option = {
  color: REC_COLUMN_PALETTE,
  grid: { left:60, right:60, top:60, bottom:40, containLabel:true },
  legend: { type:'scroll', top:0, icon:'circle', itemWidth:12, itemHeight:12,
            itemGap:16, textStyle:{ color:'#333', fontSize:12 } },
  tooltip: {
    trigger:'axis', axisPointer:{ type:'shadow' },
    backgroundColor:'#fff', borderColor:'#fff', borderWidth:1,
    borderRadius:4, padding:10,
    textStyle:{ color:'#666', fontSize:14, lineHeight:21 },
    extraCssText:'box-shadow:1px 2px 10px 0 rgba(0,0,0,.2);white-space:nowrap;z-index:9999999;',
    formatter: renderRecTooltip,      // 6 列 × 22 行宽表，见 5.4
  },
  xAxis: { type:'category', data:dates,
           axisLabel:{ color:'#6E7079', fontSize:12 },
           axisTick:{ alignWithLabel:true },
           axisLine:{ lineStyle:{ color:'#E0E6F1' } } },
  yAxis: [
    { type:'value', name:'流量得分',
      axisLabel:{ color:'#6E7079', fontSize:12 },
      splitLine:{ lineStyle:{ color:'#E0E6F1' } } },
    { type:'value', name:'流量占比', max:1,
      axisLabel:{ color:'#6E7079', formatter:v=>`${(v*100).toFixed(0)}%` },
      splitLine:{ show:false } },
  ],
  series: Object.entries(recTrends).map(([name, pts], i) => ({
    name, type:'bar', stack:'total', barMaxWidth:14,
    itemStyle:{ color: REC_COLUMN_PALETTE[i % REC_COLUMN_PALETTE.length] },
    data: pts.map(p => p ? p.score : null),   // ★ null 保留断点，不可填 0
  })),
};

chart.on('click', ({ dataIndex }) => {
  setTimeCtx({ timePieceType:'week', timePieceValue: dates[dataIndex] });
});
```

### 5.3 Sparkline 配置

```js
const sparkOption = (data, color) => ({
  grid: { left:2, right:2, top:8, bottom:8 },   // 200×80，几乎无留白
  xAxis: { type:'category', show:false, boundaryGap:false },
  yAxis: { type:'value', show:false },
  tooltip: { trigger:'axis' /* 样式同主图 */ },
  series: [{
    type:'line', smooth:false, symbol:'circle', symbolSize:4,
    connectNulls: false,                       // ★ null 必须断开
    lineStyle: { width:2, color },
    areaStyle: { color: hexToRgba(color, .12) },
    data,
  }],
});
```

> 本库的 `Sparkline.vue` 是手写 SVG（不用 ECharts），因为每行一个实例、
> 几十个 ECharts 会掉帧。复用它即可，无需按上面这份 option 实现。

### 5.4 Tooltip 结构（实测 DOM）

```html
<div class="tooltip_wrap">
  <div class="tooltip_date">2026-01-18 → 2026-01-24（美西时间）</div>
  <ul class="tooltip_content">          <!-- display:flex，6 个列容器 -->
    <div class="tooltip_column_name" style="text-align:left">   <!-- 228px -->
      <div class="header_title">推荐专栏名称</div>
      <div class="no-highlight">
        <i class="el-icon-success"
           style="color:#F26AB0;background:#F26AB0;border-radius:15px;
                  font-size:12px;margin-right:5px"></i>
        <span class="correct_direction inline_block">4 stars and above</span>
      </div>
      <!-- × 22 行 -->
    </div>
    <div style="text-align:right">本期流量占比  </div>  <!-- 85px  "0.02%" / "-" -->
    <div style="text-align:right">本期流量得分  </div>  <!-- 85px  "2.3" / "1,239" -->
    <div style="text-align:right">相比上期变化  </div>  <!-- 85px  "+2.3" / "+1,023" -->
    <div style="text-align:right">相比上期变化率</div>  <!-- 97px  "+473%" -->
    <div style="text-align:right">变化贡献度    </div>  <!-- 72px  "+0.02%" -->
  </ul>
</div>
```

规格：`.tooltip_date` 12px `#666`，`margin:0 0 10px`，无下边框。
图例圆点是用 `el-icon-success` 同时设 `color` 与 `background` + `border-radius:15px`
伪装成实心圆点（取巧写法）。空值统一 `-`。数值带 `+/-` 前缀与千分位。
**22 行永远全渲染**，不按有值过滤。

---

## 6. 接口契约（5 个，全部实测响应体）

公共入参 `{asin, timePieceType, timePieceValue}`，`trends` 例外。

### 6.1 `rec/trends` → [D2] 主图

```ts
// POST /api/search/rec/trends   { asin, timeDim: 'week' }   ← 独立签名
interface RecTrendsData {
  dates: string[];                                      // 144 项，周起始日（周日）
  recTrends: Record<string, (RecTrendPoint | null)[]>;   // 22 专栏 → 144 长定长数组
}
interface RecTrendPoint {
  recTitle: string;               // 冗余回写
  score: number;                  // 200.63     本期流量得分
  ratio: number;                  // 0.73642154 本期流量占比
  scoreChangePre: number;         // -1098.06   相比上期变化
  ratioChangePre: number | null;  // 首期/上期为 0 时 null
  changeContri: number;           // -0.70075211 变化贡献度
}
// null = 该周该专栏无曝光。必须留空，填 0 会把折线拉到基线
```

实测 `dates` 覆盖 `2023-12-24` → `2026-09-20`；单专栏 137/144 周非零。

22 个专栏名（固定枚举，字典序）：
`4 stars and above` · `4+ star picks` · `Black Friday deals` ·
`Customers frequently viewed` · `Customers mention` · `Cyber Monday deals` ·
`Discover Indoor Home Essentials` · `Explore Amazon Influencer picks` ·
`Explore Decorative Home Accents` · `From frequently shopped brands` ·
`Highly rated` · `Inspired By Your Views` · `Other items to consider` ·
`Picks from Amazon Influencers` · `Popular with shoppers` · `Prime Day Deals` ·
`Rated 4+ stars by customers` · `Recently bought and rated` ·
`Seen on social media` · `Shop by positive mentions` · `Today's deals` · `Trending now`

### 6.2 `rec/overview` → [D3] 三统计

```ts
{ recCnt: 5, campaignCnt: 3, keywordCnt: 35 }
```

### 6.3 `rec/recView` → [D4] 主表

```ts
interface RecViewData { dates: string[7]; list: RecViewRow[]; campaignTypeEnable: boolean }
interface RecViewRow {
  recTitle: string;
  ratio: number;                       // 0.69986335
  manualRatio: number; autoRatio: number;   // 实测全 0 → 触发降级文案
  campaignCnt: number; keywordCnt: number;
  campaignCntTrends: (number|null)[];  // 与 dates 等长，如 [1,2,2,null,1,1,null]
  lastCampaignCnt: number;             // ★ 行尾当前数取这个，不是数组末位（末位可能 null）
  keywordCntTrends: (number|null)[];
  lastKeywordCnt: number;
}
```

### 6.4 `rec/campaignView` → [D5] Tab1（活动 → 专栏 → 词）

```ts
interface CampaignViewData {
  total: number; remarked: number;
  list: CampaignRow[]; recTitles: string[]; dates: string[];
}
interface CampaignRow {
  campaignId: string;        // 'A06879789JMT7B98FI2T'
  maskCampaignId: string;    // 'FI2T'  ← 界面显示「FI2T (未备注名称)」
  campaignName: string|null; campaignColor: string|null;
  campaignProductType: string|null; campaignType: string|null;
  ratio: number; recCnt: number;
  recDetail: {
    recTitle: string; keywordCnt: number;
    appearDays: number; totalDays: number;   // → "7 / 7"
    ratio: number;
    keywordDetails: KeywordDetail[];
  }[];
  recTrends: Record<string, { keywordCnt: number|null; ratio: number|null }[]>;
}
interface KeywordDetail {
  keyword: string; translateKeyword: string|null; ratio: number;
  appearDays: number; totalDays: number;
  campaignCnt: number; campaignDetails: unknown|null;
}
```

### 6.5 `rec/keywordView` → [D5] Tab2（词 → 专栏 → 活动）

**嵌套方向与 campaignView 完全镜像**，且独有搜索量维度。

```ts
interface KeywordViewData {
  total: number;              // 35
  list: KeywordRow[]; recTitles: string[5]; dates: string[7];
}
interface KeywordRow {
  keyword: string;                 // '12 x 20 pillow insert'
  translateKeyword: string|null;   // '12 x 20枕头插入物'
  ratio: number; recCnt: number;
  recDetail: {
    recTitle: string; campaignCnt: number;
    appearDays: number; totalDays: number; ratio: number;
    campaignDetails: {             // ★ 方向与 campaignView 相反
      campaignId: string; maskCampaignId: string;
      campaignName: string|null; campaignColor: string|null;
      campaignProductType: string|null; campaignType: string|null;
      ratio: number; appearDays: number; totalDays: number;
      keywordCnt: number; keywordDetails: null;
    }[] | null;
  }[];
  recTrends: Record<string, { campaignCnt: number|null; ratio: number|null }[]>;
  //                          ↑ ★ 键名是 campaignCnt，campaignView 里是 keywordCnt
  estSearchesNum: number;          // 8404   ABA 预估搜索量
  searchesRank: number;            // 34981  ABA 排名
  estSearchesNumHistory: SearchHistory;      // 本期 38 周
  estSearchesNumHistoryPrev: SearchHistory;  // 去年同期 53 周
}
interface SearchHistory {          // 平行数组，按下标对齐
  date: string[];
  estSearchesNum: number[];
  searchesRank: number[];
  searchesNumChangeRatio: number[];   // Prev 里恒为 []
  searchesRankChangeRatio: number[];
  festivals: ({ name:string; startDate:string; endDate:string }[] | null)[];
  selectDate: string | null;
}
```

`festivals` 是现成运营日历，实测含：情人节 / 妇女节 / 春季大促 / 母亲节 /
父亲节 / Prime Day会员日 / 返校季 / Prime秋季大促会员日 / 万圣节 / 黑五网一 /
感恩节 / 圣诞节。

分页参数（原站实际发送，唯一真分页接口）：

```json
{"asin":"...","timePieceType":"latelyDay","timePieceValue":"7",
 "recTitle":"","campaignType":"","pageNum":1,"pageSize":100,
 "desc":true,"sortBy":"ratio"}
```

> **易踩点**：两接口 `recTrends` 的内层键名不一致——`campaignView` 用
> `keywordCnt`，`keywordView` 用 `campaignCnt`。照抄字段名，别假设对称。

---

## 7. 复刻代码要点

```ts
// 认证注入（实测：裸 token，非 Bearer）
http.interceptors.request.use(cfg => {
  const t = localStorage.getItem('token');
  if (t) cfg.headers.Authorization = t;      // ★ 不加 Bearer
  cfg.params = { ...cfg.params, country:'US', _t: Date.now() };
  return cfg;
});
```

```css
/* 主题覆盖：只换主色，其余留 Element 默认 */
:root { --primary-color: #009f52; }
/* 表格行 hover：原站主动关闭高亮 */
.rec-table .el-table--enable-row-hover .el-table__body tr:hover>td { background:#fff; }
/* 关闭弹窗遮罩变暗 */
.el-dialog__wrapper { background:transparent; }
.v-modal { display:none !important; }
```

```ts
// 蓝色数字 → dialog（不是专栏名）
function openKeywordDialog(recTitle: string) { /* 过滤 campaignView 的 recDetail */ }
// 「查看广告活动详情」是跳转，不是抽屉
function openCampaignDetail(campaignId: string) {
  window.open(`/adxray-structure?country=US&campaignId=${campaignId}`
    + `&asins=${asin}&fromPage=webSnapshot&asin=${asin}`, '_blank');
}
```

**与本库现状的差异**（实现前须知）：

| 项 | 原站 | 本库 |
|---|---|---|
| 主色 | `#009f52` 绿 | `--brand-500: #4f46e5` 靛蓝（`main.css:1-7` 明示"不抄原站配色"） |
| 样式 | scoped CSS + Element UI 2 | scoped CSS + Element **Plus**，无 Tailwind |
| Sparkline | ECharts | 手写 SVG（`Sparkline.vue`，性能考量） |
| DataZoom | 主图带缩放条 | `BaseChart.vue` **未注册** `DataZoomComponent`，需补 |

---

## 8. 验证状态

| 项 | 状态 |
|---|---|
| 5 个接口契约（含 keywordView 四层嵌套） | ✅ 实测响应体 |
| 设计 token（色/字/圆角/阴影） | ✅ 2912 元素 computed style |
| 主色 `#009f52` | ✅ CSSOM 取值（曾误判为蓝，已纠正） |
| 伪类规则 hover/active/disabled | ✅ 1.58 MB CSS 全文解析 |
| 主图配置 + 调色板 | ✅ canvas 逐像素采样 |
| Tooltip 6 列 × 22 行 | ✅ 完整 DOM |
| Dialog 900×732 / 7 列 / 158×80 spark | ✅ 实际打开 |
| Drawer `btt` 全宽 90% | ✅ 实际打开 |
| 「查看广告活动详情」= 新标签跳转 | ✅ 实测（曾误判为 drawer） |
| Loading / Empty / `.v-modal`=0 | ✅ 实测 |
| **JWT 真实过期后的 UI 行为** | ❌ 未验证，`exp` 在 2026-09-27 |

### 探查过程中自我纠正的 4 处

1. **主色**：先判定 `#3A58FF` 蓝，实为 `#009f52` 绿。蓝只是链接色。
2. **dialog 触发点**：先判定"推荐专栏名"，实为第 4/5 列蓝色数字。
3. **「查看广告活动详情」**：先判定打开 drawer，实为新标签页跳转。
4. **"会话过期"**：先判定登录态失效，实为我自己的 `fetch` 漏了
   `Authorization` 头。由此误推的"未授权跳首页"至今未验证。

共性是**只凭一次观察就下结论**。第 2、3 条都是因为看到 DOM 里有
`el-dialog__wrapper` / `el-drawer__wrapper` 就假设了触发关系，没去点。

