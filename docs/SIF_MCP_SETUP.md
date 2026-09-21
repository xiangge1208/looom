# Sif MCP 接入（Looom 数据获取新通道）

> 2026-09-21 实测建档。来源：公开网关探测 + 前端 bundle 逆向（详见 `docs/audit/more-menu.md` §MCP服务）。
> 定位：**Looom 无源功能的真实数据通道**——M12 品类拓词、M11 历史畅销榜、M13 竞价等 seed 项，
> 可改走 sif MCP 按次取数（消耗点数）。

## 连接参数（已实测验证）

| 项 | 值 | 依据 |
|---|---|---|
| 端点 | `https://mcp.sif.com/mcp` | `GET /mcp` + `Accept: text/event-stream` → 200 `{}`；`/sse` → 404 |
| 传输 | **Streamable HTTP**（JSON-RPC 2.0，响应为 SSE 流） | 无 key POST initialize → 401 JSON |
| 鉴权 | `Authorization: Bearer <密钥>` | 密钥在控制台生成；`/api/mcp/secret-key/rotate` 可轮换（旧钥立即失效） |
| 密钥获取 | https://www.sif.com/mcp-console?tab=secret | 接入文档 |
| 赠点 | 注册赠 **20,000 点**（控制台「立即领取」） | 落地页 chunk 60 |
| 配置位置 | `~/.zcode/cli/config.json` → `mcp.servers.sif`（用户级，密钥不进 git） | zcode-configuration-guide |

## 工具目录（34 个，schema 全量在 `.playwright-mcp/sif-tool-schema.json`）

| 类 | 数量 | 代表工具 |
|---|---:|---|
| 场景应用 | 1 | `analyze_traffic_anomaly` 流量下跌根因诊断（5 层推理链） |
| 查关键词 | 8 | 需求生命周期 / ABA 历史(含 **Top3 集中度**) / 词根趋势 / 竞争格局 / **机会筛选** / 竞对发现 / 推广评估 |
| 查 ASIN | 2 | 市场定位画像 / 采购成本上限反推 |
| 反查关键词 | 3 | Listing 词分布 / 关键词信号 / **ABA top3 卡位地图** |
| 查运营数据 | 6 | 流量趋势(周/月) / 明细拆分 / Listing 全景 / **销量趋势** / 销量排行 |
| 查广告 | 12 | ASIN 层 7 个（结构/趋势/画像/历史对比/贡献/变更）+ Campaign 层 3 + Ad Group 层 2 |

## 对 ROADMAP 的直接影响（候选，未裁决）

1. **M13 `/amount` 的 ABA Top3 集中度两列**——`market_get_keyword_history` 直接返回
   `top3_click_shares[]` / `top3_conversion_shares[]`，**不用 seed 也不用探源字段名了**
2. **M12 品类拓词 / M11 历史畅销榜**——目录里无一一对应工具，但
   `market_screen_keyword_opportunities`（机会筛选）与 `ops_get_listing_traffic_structure` 可组合替代部分场景；或继续 seed
3. **M14 每日排名回溯**——MCP 无排名监控类工具（那是订阅制爬虫），**不受影响**

⚠️ 每工具点数消耗不同（目录不含单价，控制台可见）；20,000 点用完需订阅或加量包。

## 状态

- [x] 网关/协议/鉴权头实测
- [x] `~/.zcode/cli/config.json` 已加 `sif` 服务器（密钥已配好）
- [x] 验证握手（2026-09-21）：initialize 200（`sif-mcp-server` v0.0.1，无状态会话）
  → tools/list **34 个工具** → 真实调用 `market_get_keyword_history("travel gifts", US, week)` 成功
- [x] **M13 Top3 集中度数据源确认**：返回 313 周完整序列（2020-09 起），
  `top3_click_shares[]`/`top3_conversion_shares[]` + `latest.top3_asins` 全齐
  （响应还带 `_formatted` 预制分析摘要——锚点结论+要点+趋势表）

⚠️ 响应不含点数扣减元数据，用量在控制台「点数」页查看。
新会话启动时 ZCode 会自动连上 `sif` 服务器（本会话内用 curl 验证，配置已生效）。
