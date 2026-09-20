/**
 * Prompt 注册表
 *
 * goal.md 要求每个 AI 插入点有独立的 prompt 文件且带版本号。
 * 版本号进 ai_tasks.prompt_version，参与缓存键计算 ——
 * 改 prompt 就换版本号，旧缓存自动失效，不会返回按老提示词生成的结果。
 *
 * P2 实现插入点 1-3，P3 补 4-6。骨架先把 6 个都占位。
 */

export interface PromptTemplate {
  /** 插入点标识，写进 ai_tasks.insert_point */
  insertPoint: string
  version: string
  /** 系统提示词 */
  system: string
  /** 用户提示词构造函数。入参是该插入点的业务数据 */
  build: (input: Record<string, any>) => string
}

const COMMON_RULES = [
  '你是亚马逊运营分析助手。请遵守：',
  '1. 用中文回答，输出 Markdown 格式',
  '2. 结论先行，再给依据，最后给可执行的动作建议',
  '3. 只基于提供的数据下结论，数据不足就明确说「数据不足」，不要编造数字',
  '4. 不要输出寒暄和免责声明，直接给分析',
].join('\n')

/** 插入点 1：销量趋势解读（P2） */
export const salesTrendV1: PromptTemplate = {
  insertPoint: 'sales-trend',
  version: 'v1',
  system: COMMON_RULES,
  build: (input) =>
    [
      '请解读以下 ASIN 的销量趋势，并标注异常点。',
      '',
      `ASIN：${input.asin ?? '未提供'}`,
   `站点：${input.country ?? 'US'}`,
      '',
      '月度销量序列（月份 → 销量分档）：',
      JSON.stringify(input.monthlySales ?? [], null, 2),
      '',
      '要求：',
      '- 概述整体走势',
      '- 找出环比变化异常的月份，并推测可能原因',
      '- 给出 2~3 条可执行建议',
    ].join('\n'),
}

/** 插入点 2：关键词投放推荐（P2） */
export const keywordRecommendV1: PromptTemplate = {
  insertPoint: 'keyword-recommend',
  version: 'v1',
  system: COMMON_RULES,
  build: (input) =>
    [
   '请从以下反查流量词结果中，挑出最值得投放的关键词并排序。',
      '',
      `ASIN：${input.asin ?? '未提供'}`,
      `站点：${input.country ?? 'US'}`,
      '',
      '关键词数据（含搜索量、自然位排名、流量占比）：',
      JSON.stringify(input.keywords ?? [], null, 2),
      '',
      '要求：',
      '- 按「值得投放」程度排序，说明每个词的理由',
      '- 单独列出不建议投放的词及原因',
      '- 用表格呈现',
    ].join('\n'),
}

/** 插入点 3：流量结构诊断（P2） */
export const trafficInsightV1: PromptTemplate = {
  insertPoint: 'traffic-insight',
  version: 'v1',
  system: COMMON_RULES,
  build: (input) =>
    [
      '请诊断以下 Listing 的流量构成，判断是自然流量弱还是广告依赖过重。',
  '',
      `ASIN：${input.asin ?? '未提供'}`,
      `站点：${input.country ?? 'US'}`,
      '',
      '分渠道流量数据：',
      JSON.stringify(input.channels ?? [], null, 2),
    '',
      '要求：',
      '- 判断当前流量结构是否健康',
      '- 指出最薄弱的环节',
      '- 给出下一步动作，说明优先级',
].join('\n'),
}

/**
 * 插入点 4：供应商初步评估（P3）
 *
 * 字段：supplierName / title / price / minOrder / location。
 * 这些是 seed 的自造数据，**不是真实 1688 货源**，
 * 所以要求模型只做列表内相对比较，不得输出绝对采购结论。
 */
export const supplierEvaluateV1: PromptTemplate = {
  insertPoint: 'supplier-evaluate',
  version: 'v2',
  system: COMMON_RULES,
  build: (input) =>
    [
      '请对以下货源做初步评估，每个一行摘要。',
      '',
      '字段说明：supplierName 供应商名 / title 货源标题 / price 价格(元) /',
      'minOrder 起订量 / location 地区。',
      '',
      JSON.stringify(input.suppliers ?? [], null, 2),
      '',
      '要求：',
      '- 每个货源一行，说明价格竞争力（与本列表其他货源相比）和起订量门槛',
      '- 单独列出需要向供应商核实的风险点（账期、验厂、样品、交期）',
      '- 只做列表内相对比较，不要推断市场行情或给绝对采购建议',
      '- 数据未提供的维度（资质、评分、产能）直接说「数据未提供」，不要假设',
    ].join('\n'),
}

/**
 * 插入点 5：广告结构优化（P3）
 *
 * 字段来自 ads.listCampaigns 的实测结构：
 * fakeCampaignId 前台短码 / adTypeName / strategy（后端算好的中文串）/
 * involvedAdNum 涉及投放小组数 / totalScore 流量得分。
 *
 * ⚠️ 没有花费、点击、转化数据 —— 这是竞品广告结构透视，
 * 拿不到对方后台数据。prompt 必须明令禁止模型谈 ACOS/ROI/预算，
 * 否则它一定会编出数字。
 */
export const adOptimizeV1: PromptTemplate = {
  insertPoint: 'ad-optimize',
  version: 'v2',
  system: COMMON_RULES,
  build: (input) =>
    [
      '请分析以下广告架构，指出结构性问题并给出优化动作。',
      '',
      `ASIN：${input.asin ?? '未提供'}`,
      `站点：${input.country ?? 'US'}`,
      '',
      '活动数据（fakeCampaignId 活动短码 / adTypeName 广告类型 /',
      'strategy 投放策略 / involvedAdNum 涉及投放小组数 / totalScore 流量得分）：',
      JSON.stringify(input.campaigns ?? [], null, 2),
      '',
      '要求：',
      '- 判断活动结构是否合理（过多过散、类型单一、变体覆盖不均）',
      '- 指出流量得分集中在哪些活动，是否存在结构性偏斜',
      '- 给出具体调整动作，按优先级排序',
      '',
      '⚠️ 严格约束：数据中**没有花费、点击、转化、ACOS**。',
      '绝对不要提及或估算预算金额、ACOS、ROI、CPC —— 没有任何依据。',
      '只能基于活动数量、类型分布、投放策略和流量得分占比分析。',
    ].join('\n'),
}

/**
 * 插入点 6：全站综合诊断（P3）
 *
 * 入参是 DiagnosisService.summarize() 的返回值：
 * 各块带 available 标记，缺失的域列在 missingDomains。
 *
 * 销量是**分档字符串**（「100+」）而非精确值，
 * prompt 必须讲清楚，否则模型会拿档位做精确加减算增长率。
 */
export const diagnosisV1: PromptTemplate = {
  insertPoint: 'diagnosis',
  version: 'v2',
  system: COMMON_RULES,
  build: (input) =>
    [
      '请对该 ASIN 做综合根因分析，输出诊断报告。',
      '',
      `ASIN：${input.asin ?? '未提供'}`,
      `站点：${input.country ?? 'US'}`,
      ...(Array.isArray(input.missingDomains) && input.missingDomains.length
        ? [
            '',
            `⚠️ 以下数据域缺失，请在报告中明确说明分析受限：${input.missingDomains.join('、')}`,
          ]
        : []),
      '',
      '综合数据（每块 available=false 表示该域无数据）：',
      JSON.stringify(input.summary ?? input, null, 2),
      '',
      '要求：',
      '- 用「现状 / 根因 / 行动计划」三段式',
      '- 行动计划按优先级排序，标注预期影响',
      '- 只对 available=true 的域下结论；缺失的域明说「数据不足」，不要推测',
      '',
      '⚠️ 数据口径：',
      '- boughtLabel 是销量**分档**（「100+」是区间），不是精确值，',
      '  不要把档位当数字做加减或算增长率',
      '- ratio 类字段是 0-1 小数占比',
      '- 广告数据不含花费与转化，不要谈 ACOS/ROI',
    ].join('\n'),
}

/** 所有插入点的注册表，按 insertPoint 查找 */
export const PROMPTS: Record<string, PromptTemplate> = {
  [salesTrendV1.insertPoint]: salesTrendV1,
  [keywordRecommendV1.insertPoint]: keywordRecommendV1,
  [trafficInsightV1.insertPoint]: trafficInsightV1,
  [supplierEvaluateV1.insertPoint]: supplierEvaluateV1,
  [adOptimizeV1.insertPoint]: adOptimizeV1,
  [diagnosisV1.insertPoint]: diagnosisV1,
}

export type InsertPoint = keyof typeof PROMPTS
