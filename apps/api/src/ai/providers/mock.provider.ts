import { Injectable, Logger } from '@nestjs/common'
import type {
  AiProvider,
  ChatMessage,
  ChatOptions,
  StreamChunk,
} from './provider.interface'

/**
 * Mock Provider —— 开发环境默认
 *
 * 为什么需要：goal.md 要求开发环境不烧钱。
 * 它返回预置的假分析结果，并模拟真实的流式打字节奏，
 * 让前端 SSE、进度显示、取消、错误处理都能在不调真实模型的情况下跑通。
 */
@Injectable()
export class MockProvider implements AiProvider {
  readonly name = 'mock'
  private readonly logger = new Logger(MockProvider.name)

  async *chatStream(
    messages: ChatMessage[],
 options: ChatOptions,
  ): AsyncIterable<StreamChunk> {
    const userMsg = messages.filter((m) => m.role === 'user').pop()?.content ?? ''
    this.logger.debug(`mock 分析请求，输入长度 ${userMsg.length}`)

    const text = this.pickTemplate(options.insertPoint, userMsg)

    // 按字符切块，模拟真实模型的流式节奏
    const chunkSize = 6
    for (let i = 0; i < text.length; i += chunkSize) {
      // 模拟网络与推理延迟，让前端打字效果可见
      await new Promise((r) => setTimeout(r, 24))
    if (options.signal?.aborted) {
        this.logger.debug('mock 分析被取消')
        return
      }
    yield { delta: text.slice(i, i + chunkSize), done: false }
    }

    yield {
      delta: '',
      done: true,
      usage: {
        promptTokens: Math.ceil(userMsg.length / 4),
        completionTokens: Math.ceil(text.length / 4),
        totalTokens: Math.ceil((userMsg.length + text.length) / 4),
    },
    }
  }

  /**
   * 挑一份假结果。
   *
   * ⚠️ 按 insertPoint 精确匹配，**不要**按 prompt 文本里的关键词猜。
   * 早先的实现是关键词级联（`input.includes('销量')` …），
   * 结果「综合诊断」的提示词里含「销量」二字就命中了销量模板，
   * 返回完全不相干的内容 —— 这种 bug 在 mock 里特别难发现，
   * 因为输出看起来「像个正常的分析」。
   *
   * 以下都是自造的中文文案，不使用原站任何专有文案。
   */
  private pickTemplate(insertPoint: string | undefined, input: string): string {
    const T: Record<string, string[]> = {
      'sales-trend': [
        '## 销量趋势解读',
        '',
        '### 整体走势',
        '近 12 个月销量呈**阶梯式上升**，其中 3 月与 8 月出现两次明显跃升。',
        '',
        '### 异常点',
        '- **2026-03**：环比 +182%，同期价格未变，推测为进入新推荐位或广告加投',
        '- **2026-08**：环比 -34%，同期评分从 4.8 降至 4.6，需排查近期差评',
        '',
        '### 建议动作',
        '1. 复盘 3 月的流量结构变化，确认增量来自自然位还是广告位',
        '2. 排查 8 月差评内容，若集中在同一问题点应优先处理',
        '3. 主力变体贡献超过 60%，建议为其单独建广告活动',
      ],

      'keyword-recommend': [
        '## 关键词投放建议',
        '',
        '### 优先投放（高相关 + 有搜索量）',
        '| 关键词 | 建议理由 |',
        '| --- | --- |',
        '| 主类目核心词 | 自然位已进前 3 页，广告助推性价比最高 |',
        '| 场景长尾词 | 竞争度低，转化率高于均值 |',
        '',
        '### 暂不投放',
        '- 泛流量大词：搜索量高但相关性弱，点击成本会被拉高',
        '- 竞品品牌词：合规风险，且转化通常偏低',
        '',
        '### 说明',
        '以上结论基于当前时间片的流量数据，建议每两周复核一次。',
      ],

      'traffic-insight': [
        '## 流量构成诊断',
        '',
        '### 现状',
        '- 自然流量占比 **83%**，广告流量 **17%**',
        '- 广告内部 SP 常规占绝大部分，SB / SBV 几乎为零',
        '',
        '### 判断',
        '自然流量健康，但**广告结构过于单薄**。完全依赖 SP 常规，',
        '缺少品牌展示位，头部大词的曝光份额容易被竞品挤占。',
        '',
        '### 下一步',
        '1. 保持自然位优势，不要盲目加预算稀释 ROI',
        '2. 对已验证转化的核心词，补充 SB 投放抢占顶部展位',
        '3. 若有视频素材，SBV 的点击成本通常低于 SB',
      ],

      'supplier-evaluate': [
        '## 货源初步评估',
        '',
        '| 供应商 | 价格竞争力 | 起订量门槛 | 备注 |',
        '| --- | --- | --- | --- |',
        '| 深圳五金有限公司 | 本列表中偏高 | 低（5 件） | 适合打样与小批量试单 |',
        '| 东莞日用百货 | 本列表中最低 | 高（100 件） | 单价优势需压库存换取 |',
        '',
        '### 需要核实的风险点',
        '- **账期与付款方式**：数据未提供，需直接询价确认',
        '- **是否支持验厂 / 提供样品**：数据未提供',
        '- **交期与产能**：数据未提供，旺季前需提前确认',
        '- **资质与质检报告**：数据未提供，出口需确认合规文件',
        '',
        '### 说明',
        '以上仅为**本列表内的相对比较**，不代表市场行情。',
        '资质、评分、产能等维度数据未提供，无法评估。',
      ],

      'ad-optimize': [
        '## 广告结构分析',
        '',
        '### 结构现状',
        '- 活动数量少，类型集中在 **SBV 品牌视频**单一形态',
        '- 投放策略为「单广告组，单变体」，覆盖面窄',
        '- 流量得分集中在少数活动，存在**结构性偏斜**',
        '',
        '### 主要问题',
        '1. **类型单一**：缺少 SP 常规打底，自然位之外的承接能力不足',
        '2. **变体覆盖不均**：单变体投放意味着其他变体完全依赖自然流量',
        '3. **活动过于集中**：单点失效会直接影响整体广告流量',
        '',
        '### 调整动作（按优先级）',
        '1. 补 SP 常规活动覆盖核心词，作为流量基本盘',
        '2. 把高潜力变体纳入投放，避免只推单一变体',
        '3. 保留 SBV 做品牌展示，但不宜作为唯一形态',
        '',
        '> 注：本分析仅基于活动数量、类型分布与流量得分占比。',
        '> 竞品广告的花费、点击、转化数据无法获取，故不涉及 ACOS / ROI 判断。',
      ],

      diagnosis: [
        '## 综合诊断报告',
        '',
        '### 现状',
        '- **销量**：多变体结构，主力变体贡献集中',
        '- **流量**：自然流量占比约 83%，广告约 17%',
        '- **关键词**：核心词已有自然位，长尾覆盖尚可',
        '- **广告**：活动数量少，类型单一',
        '',
        '### 根因',
        '当前增长主要由自然流量驱动，广告只起补充作用。',
        '这在自然位稳固时表现良好，但**抗风险能力弱**：',
        '一旦核心词自然排名下滑，缺少广告承接，流量会快速衰减。',
        '',
        '### 行动计划',
        '| 优先级 | 动作 | 预期影响 |',
        '| --- | --- | --- |',
        '| 高 | 为核心词补 SP 常规投放 | 建立流量缓冲，降低排名波动风险 |',
        '| 中 | 扩大投放变体覆盖 | 分散单变体依赖 |',
        '| 低 | 补充 SB / SBV 品牌位 | 提升头部词曝光份额 |',
        '',
        '> 注：销量为分档区间值，未做精确增长率计算；',
        '> 广告数据不含花费与转化，未涉及 ACOS / ROI。',
      ],
    }

    const tpl = insertPoint ? T[insertPoint] : undefined
    if (tpl) return tpl.join('\n')

    // 未知插入点：明确说明是兜底，而不是随手返回另一份分析
    const which = insertPoint
      ? '，插入点 ' + insertPoint + ' 尚无预置模板'
      : ''
    return [
      '## 分析结果',
      '',
      '这是开发环境的模拟结果（AI_PROVIDER=mock）' + which + '。',
      '',
      '要接入真实模型，在 .env 里改这三项：',
      '',
      '- AI_PROVIDER=openai-compatible',
      '- AI_BASE_URL=<你的服务地址>',
      '- AI_API_KEY=<你的 key>',
      '',
      '（收到输入 ' + input.length + ' 字符）',
    ].join('\n')
  }
}
