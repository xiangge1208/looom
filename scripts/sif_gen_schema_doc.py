#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
读 sif_schema_probe.py 产出的 _schemas.json + PG 统计，生成
docs/SIF_API_SCHEMA.md 的「逐 endpoint 字段表」部分。

字段表从实测数据生成，不手写 —— 避免文档与上游结构漂移。

用法：python scripts/sif_gen_schema_doc.py --schemas /tmp/sifout/_schemas.json \
         --out docs/SIF_API_SCHEMA.md
"""
import argparse
import io
import json
import sys
from collections import defaultdict

import psycopg2

# 数据库凭据从环境变量读取，不硬编码 —— 见 scripts/_dsn.py
from _dsn import pg_dsn

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8",
                                  errors="replace")


# endpoint -> (分组, 一句话用途)。分组顺序即文档章节顺序。
GROUPS = ["meta", "keyword", "asin", "compete", "monitor", "webapp", "virtual"]

META = {
    "user-info": ("meta", "当前 SIF 会员信息：vip 等级、有效期"),
    "login-user-info": ("meta", "登录用户基础资料"),
    "ranking-update-time": ("meta", "排名数据最近更新时间，判断数据新鲜度"),
    "user-group-product": ("meta", "该 ASIN 归属的自建商品分组"),
    "keyword-overview": ("keyword", "关键词概览：搜索量、真实产品数、各类广告产品数"),
    "keyword-aba-trend": ("keyword", "关键词搜索趋势 + ABA 排名逐期曲线"),
    "asins-search-exposure": ("asin", "一组 ASIN 在搜索结果中的曝光占比"),
    "asin-basic-info": ("asin", "标题/主图/价格/评分/评论数"),
    "asin-statistics": ("asin", "流量词总数、近月销量、是否被关注"),
    "listing-summary": ("asin", "Listing 各口径流量词数 + 变体横向对比"),
    "asin-keyword-list": ("asin", "反查流量词（核心）：流量分、占比、曝光位、排名"),
    "asin-keyword-detail": ("asin", "反查词精细版。已失效，用 asin-keyword-list 代替"),
    "asin-keyword-rank-history": ("asin", "某 ASIN 某词下的逐日排名曲线"),
    "asin-keyword-type-history": ("asin", "关键词分渠道（自然/广告）历史"),
    "traffic-trend": ("asin", "时光机：自然流 vs 广告流随时间变化"),
    "traffic-change-detail": ("asin", "某日 Listing 图片/标题/广告变更明细"),
    "asin-sales-history": ("asin", "近月销量 + 约 3 年逐月历史销量"),
    "asin-history-cache": ("asin", "BSR/价格历史缓存。已失效，从无成功记录"),
    "asin-history-repair-status": ("asin", "历史数据补齐进度。已失效，从无成功记录"),
    "asin-focus-status": ("asin", "一组 ASIN 是否已被当前账号关注"),
    "asin-bs-exposure": ("compete", "一组 ASIN 的畅销/曝光数据"),
    "monitor-keyword-query": ("monitor", "坑位监控快照（只读）"),
    "web-sales-asin": ("webapp", "一组 ASIN 的销量概览 + 父子体信息"),
    "web-sales-listing-history": ("webapp", "Listing 逐月历史销量（含父体）"),
    "web-compete-pattern": ("webapp", "竞争格局：竞品清单 + 近月销量"),
    "web-asin-variants": ("webapp", "变体关系：父 ASIN + 变体清单"),
    "web-sales-keyword": ("webapp", "某关键词下 ASIN 的近月销量"),
    "web-asin-flow-overview": ("webapp", "流量结构总览。已失效（2026-09-08 后全 404）"),
    "web-asin-detail": ("webapp", "ASIN 详情：标题/价格/评分"),
    "web-keyword-extend": ("webapp", "扩展词：由种子词扩展出的关键词清单"),
    "web-est-searches-history": ("webapp", "关键词逐期预估搜索量曲线"),
    "web-variant-ad-keywords": ("webapp", "变体投放词 + 广告位/活动计数"),
    "web-keywords-basic-info": ("webapp", "批量关键词基础字段"),
    "web-asin-head-keywords": ("webapp", "头部流量词 + 建议词"),
    "web-asin-core-keywords": ("webapp", "核心流量词 + 建议词"),
    "web-traffic-diagnose": ("webapp", "诊断流量：按词拆分的占比与归因"),
    "web-asin-traffic-detail": ("webapp", "某天流量变化归因明细"),
    "web-asin-keyword-overview": ("webapp", "分周期关键词概览：9 渠道 total/prev/in/out"),
    "web-asin-keyword-trend": ("webapp", "逐期 全部/自然/广告/SP 词数变化"),
    "web-asin-day-trend": ("webapp", "日粒度 ASIN 数/关键词数/评分趋势"),
    "web-compete-keyword": ("webapp", "关键词竞品分析：搜索量+排名+销量+竞品数"),
    "web-keyword-conversion": ("webapp", "ABA 转化漏斗：搜索/点击/购买 + 三种转化率"),
    "asin-overview": ("virtual", "CLI 虚拟接口：basic+stats+listing 三合一"),
}


def fetch_stats():
    conn = psycopg2.connect(**pg_dsn())
    cur = conn.cursor()
    cur.execute("""
        SELECT endpoint, count(*), count(*) FILTER (WHERE ok),
               round(avg(elapsed_ms)), min(fetched_at)::date, max(fetched_at)::date
        FROM sif_api_log GROUP BY 1""")
    out = {}
    for ep, n, nok, ms, first, last in cur.fetchall():
        out[ep] = {"n": n, "ok": nok, "ok_pct": round(nok / n * 100, 1) if n else 0,
                   "avg_ms": int(ms) if ms else None,
                   "first": str(first), "last": str(last)}
    cur.execute("""SELECT endpoint, params FROM sif_api_log
                   WHERE ok IS TRUE ORDER BY id DESC""")
    seen = {}
    for ep, params in cur.fetchall():
        seen.setdefault(ep, params)
    for ep, p in seen.items():
        if ep in out:
            out[ep]["params"] = p
    cur.close()
    conn.close()
    return out


def md_escape(s: str) -> str:
    return (s or "").replace("|", "\\|").replace("\n", " ")


# CLI 实测结论 -> 展示用标签。可用性看这个，不看日志成功率 ——
# 日志成功率低多半是历史调用传错参，不代表接口现在不能用。
VERDICT_BADGE = {
    "OK": "✅ CLI 实测可用",
    "OK_BUT_EMPTY": "⚠️ CLI 实测通但返回空",
    "OK_BUT_NULL": "⚠️ CLI 实测通但 data 为 null",
    "BAD_PARAMS": "🔴 CLI 实测入参错误",
    "DEAD_404": "❌ CLI 实测失效（HTTP 404）",
    "ERROR": "🔴 CLI 实测报错",
    "PARSE_FAIL": "🔴 CLI 返回无法解析",
}


def load_sweep(path):
    """读 sif_sweep.py 的 _sweep_summary.json，拿每个 endpoint 的实测结论。"""
    if not path:
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            return {r["endpoint"]: r for r in json.load(fh)}
    except FileNotFoundError:
        print(f"[gen] 找不到 {path}，字段表将不带 CLI 实测结论", file=sys.stderr)
        return {}


def fields_table(fields, dyn_maps, max_rows=0):
    """把 probe 的字段清单渲染成 Markdown 表。"""
    rows = fields if not max_rows else fields[:max_rows]
    out = ["| 路径 | 类型 | 填充率 | 取值范围 / 样例 |",
           "|---|---|---:|---|"]
    for f in rows:
        rng = " ".join(x for x in (f["range"], f["arr"]) if x)
        samp = " / ".join(f["samples"]) if f["samples"] else ""
        detail = md_escape("; ".join(x for x in (rng, samp) if x))
        star = " 🔑" if f["path"] in dyn_maps else ""
        out.append(f"| `{f['path']}`{star} | {f['type']} | "
                   f"{f['fill_pct']}% | {detail} |")
    if max_rows and len(fields) > max_rows:
        out.append(f"| … 另有 {len(fields) - max_rows} 个字段 | | | "
                   f"见 `_schemas.json` |")
    return "\n".join(out)


GROUP_TITLE = {
    "meta": "meta —— 会员与元信息",
    "keyword": "keyword —— 关键词维度",
    "asin": "asin —— ASIN 维度",
    "compete": "compete —— 竞品/曝光",
    "monitor": "monitor —— 坑位监控",
    "webapp": "webapp —— 网页版接口",
    "virtual": "virtual —— CLI 虚拟聚合接口",
}


def render_endpoint(r, stats, sweep, max_rows):
    ep = r["endpoint"]
    st = stats.get(ep)
    sw = sweep.get(ep)
    _, purpose = META.get(ep, ("webapp", ""))
    dyn = r.get("dynamic_maps") or {}
    dyn_paths = set(dyn)

    lines = [f"#### `{ep}`", "", purpose, ""]

    # 第一行永远是 CLI 实测结论 —— 这才是「能不能用」的依据
    if sw:
        badge = VERDICT_BADGE.get(sw["verdict"], sw["verdict"])
        note = f"｜{sw['note']}" if sw.get("note") else ""
        lines.append(f"- **可用性**：{badge}"
                     f"（{sw['secs']}s，{sw['bytes']:,} B）{note}")
        if sw.get("params"):
            p = json.dumps(sw["params"], ensure_ascii=False)
            lines.append(f"- **本次实调入参**：`{p}`")
    if st:
        # 日志统计只用来说明字段表的样本来源，不作可用性判断
        if r["sampled"] == 0:
            lines.append(
                f"- **字段表样本**：**无** —— 日志里 {st['n']} 次调用"
                f"全部失败（{st['first']} ~ {st['last']}），无成功响应可采样，"
                f"因此无法给出字段结构")
        else:
            lines.append(
                f"- **字段表样本**：{r['sampled']} 条历史成功响应"
                f"（日志共 {st['n']} 条，{st['first']} ~ {st['last']}），"
                f"打平 {len(r['fields'])} 个字段")
    if dyn:
        lines.append("- **⚠️ 动态 key**：以下路径是「以业务值为 key 的 map」，"
                     "不是数组，ETL 要先 `jsonb_each` 展开：")
        for path, kinds in dyn.items():
            shown = path or "(根)"
            lines.append(f"    - `{shown}` 的 key 是 {', '.join(kinds)}")
    if r["fields"]:
        lines += ["", fields_table(r["fields"], dyn_paths, max_rows), ""]
    else:
        lines += ["", "> 该接口无任何成功响应，字段结构未知。", ""]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--schemas", default="/tmp/sifout/_schemas.json")
    ap.add_argument("--sweep", default="/tmp/sifout/_sweep_summary.json",
                    help="sif_sweep.py 的实测结论，用于标注每个 endpoint 可用性")
    ap.add_argument("--out", default="docs/SIF_API_SCHEMA.md")
    ap.add_argument("--max-rows", type=int, default=60,
                    help="每个 endpoint 字段表最多几行（0=全部）")
    ap.add_argument("--body-only", action="store_true",
                    help="只输出逐 endpoint 章节，不回填文档")
    args = ap.parse_args()

    begin = "<!-- BEGIN GENERATED: 由 scripts/sif_gen_schema_doc.py 生成，勿手改 -->"
    end = "<!-- END GENERATED -->"

    with open(args.schemas, encoding="utf-8") as fh:
        results = {r["endpoint"]: r for r in json.load(fh)}
    stats = fetch_stats()
    sweep = load_sweep(args.sweep)

    # 从未成功过的 endpoint 在 _schemas.json 里没有条目（无样本可采），
    # 但它们仍是 43 个之一，必须在文档里出现并标明「无样本」，
    # 否则读者会以为漏了。
    for ep in sweep:
        if ep not in results:
            results[ep] = {"endpoint": ep, "sampled": 0, "fields": [],
                           "dynamic_maps": {}}

    by_group = defaultdict(list)
    for ep, r in results.items():
        g = META.get(ep, ("webapp", ""))[0]
        by_group[g].append(r)

    chunks = []
    for g in GROUPS:
        if not by_group.get(g):
            continue
        chunks.append(f"### {GROUP_TITLE[g]}\n")
        for r in sorted(by_group[g], key=lambda x: x["endpoint"]):
            chunks.append(render_endpoint(r, stats, sweep, args.max_rows))

    body = "\n".join(chunks)

    if args.body_only:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(body)
        print(f"[gen] wrote body-only {args.out} ({len(body)} chars)")
        return

    # 回填到文档的 GENERATED 区块之间，前言部分手写、不动。
    with open(args.out, encoding="utf-8") as fh:
        doc = fh.read()
    if begin not in doc or end not in doc:
        print(f"[gen] {args.out} 里找不到 GENERATED 标记，放弃回填", file=sys.stderr)
        sys.exit(1)
    head = doc[:doc.index(begin) + len(begin)]
    tail = doc[doc.index(end):]
    merged = f"{head}\n\n{body}\n{tail}"
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(merged)
    print(f"[gen] spliced {len(body)} chars into {args.out} "
          f"({len(results)} endpoints, total {len(merged)} chars)")


if __name__ == "__main__":
    main()
