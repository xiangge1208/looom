#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把一个 ASIN 过一遍 sif-cli 的全部 endpoint，逐个落盘到 out/<endpoint>.json。

用法：python scripts/sif_sweep.py B0FVNPKGJ8 [--country US] [--out /tmp/sifout]
"""
import argparse
import json
import pathlib
import subprocess
import sys
import time

CLI = [sys.executable, "-m", "sif_cli"]


def build_jobs(asin: str, keyword: str, day: str, month: str):
    """(endpoint, params) 列表。params=None 表示该 endpoint 不需要入参。"""
    return [
        # ---- meta：与 ASIN 无关，但要验证连通与返回结构 ----
        ("user-info", {}),
        ("login-user-info", {}),
        ("ranking-update-time", {}),
        ("user-group-product", {"asin": asin, "sortBy": ""}),
        # ---- keyword ----
        ("keyword-overview", {"keyword": keyword}),
        ("keyword-aba-trend", {"keyword": keyword, "granularity": "month"}),
        # ---- asin ----
        ("asins-search-exposure", {"asins": [asin]}),
        ("asin-basic-info", {"asins": [asin]}),
        ("asin-statistics", {"asin": asin}),
        ("listing-summary", {"asin": asin}),
        ("asin-keyword-list", {"asin": asin, "pageNo": 1, "pageSize": 20}),
        # 文档示例只给 asin，实测要带排序+分页（入参从日志里历史成功调用复刻）
        ("asin-keyword-detail", {"asin": asin, "desc": True,
                                 "sortBy": "scoreInfo.scoreRatio",
                                 "pageNum": 1, "pageSize": 80}),
        ("asin-keyword-rank-history", {"asin": asin, "keyword": keyword}),
        ("asin-keyword-type-history", {"asin": asin, "keyword": keyword}),
        ("traffic-trend", {"asin": asin}),
        ("traffic-change-detail", {"asin": asin, "day": day}),
        ("asin-sales-history",
         {"asin": asin, "variantInfo": {"asin": asin}, "dimension": 1}),
        ("asin-history-cache", {"asin": asin}),
        ("asin-history-repair-status", {"asin": asin}),
        ("asin-focus-status", {"asins": [asin]}),
        # ---- compete ----
        ("asin-bs-exposure", {"asins": [asin]}),
        # ---- monitor ----
        ("monitor-keyword-query", {"asin": asin, "keywords": [keyword]}),
        # ---- webapp ----
        ("web-sales-asin", {"asins": [asin]}),
        ("web-sales-listing-history", {"asins": [asin], "dimension": 1}),
        # 文档示例只给 asin，实测必须带分页，否则「参数错误」
        ("web-compete-pattern", {"asin": asin, "pageNum": 1, "pageSize": 20}),
        ("web-asin-variants", {"asin": asin}),
        ("web-sales-keyword", {"keyword": keyword}),
        ("web-asin-flow-overview",
         {"asin": asin, "timePieceType": "latelyDay", "timePieceValue": "30"}),
        ("web-asin-detail", {"asin": asin}),
        # 同样：文档示例缺分页
        ("web-keyword-extend", {"keyword": keyword, "pageNum": 1,
                                "pageSize": 50}),
        ("web-est-searches-history", {"keywords": [keyword]}),
        # 分页 + timePiece 都得给
        ("web-variant-ad-keywords",
         {"asin": asin, "pageNum": 1, "pageSize": 100,
          "timePieceType": "latelyDay", "timePieceValue": "30"}),
        ("web-keywords-basic-info", {"keywords": [keyword]}),
        # 文档示例漏了 timePiece 两个必填字段
        ("web-asin-head-keywords",
         {"asin": asin, "timePieceType": "latelyDay", "timePieceValue": "7"}),
        ("web-asin-core-keywords",
         {"asin": asin, "timePieceType": "latelyDay", "timePieceValue": "7"}),
        ("web-traffic-diagnose", {
            "asin": asin, "granularity": "month", "endDay": month,
            "pageNum": 1, "pageSize": 20, "sortBy": "",
        }),
        ("web-asin-traffic-detail",
         {"asin": asin, "date": day, "listingSearch": False}),
        ("web-asin-keyword-overview",
         {"asin": asin, "timePieceType": "latelyDay", "timePieceValue": "7"}),
        ("web-asin-keyword-trend", {"asin": asin, "granularity": "week"}),
        ("web-asin-day-trend", {"asin": asin}),
        ("web-compete-keyword", {"keywords": [keyword], "trendType": "week"}),
        ("web-keyword-conversion", {"keywords": [keyword]}),
        # ---- 虚拟聚合接口（sif asin 子命令落库用的 endpoint）----
        ("asin-overview", {"asin": asin}),
    ]


def unwrap(payload):
    """剥掉 CLI 信封和上游信封，拿到真正的业务数据。

    CLI 返回 {status, data:{code, data, message}}，有的接口还少一层。
    """
    d = payload.get("data")
    if isinstance(d, dict) and "code" in d and "data" in d:
        return d.get("data")
    return d


def verdict(payload):
    """判定这个 endpoint 到底能不能拿到数据。

    只看 status=ok 是不够的 —— 有的接口 ok 但 data 是 {} / [] / 全 null，
    那对 ETL 来说和拿不到没区别，要单独标出来。
    """
    if payload.get("status") != "ok":
        cls = payload.get("error_class") or ""
        msg = payload.get("message") or payload.get("error") or ""
        if "404" in msg:
            return "DEAD_404", msg
        if "参数" in msg or "must not be blank" in msg:
            return "BAD_PARAMS", msg
        return "ERROR", msg

    biz = unwrap(payload)
    if biz is None:
        return "OK_BUT_NULL", "data 为 null"
    if isinstance(biz, (dict, list)) and len(biz) == 0:
        return "OK_BUT_EMPTY", "data 为空容器"
    if isinstance(biz, dict):
        # 每个值都是 None / 空容器 => 空壳
        vals = list(biz.values())
        if vals and all(v is None or (isinstance(v, (dict, list, str))
                                      and len(v) == 0) for v in vals):
            keys = ",".join(list(biz)[:4])
            return "OK_BUT_EMPTY", f"所有字段均空（{keys}）"
    return "OK", ""


def run_one(endpoint: str, params: dict, country: str, outdir: pathlib.Path,
            fresh: bool):
    cmd = CLI + ["call", endpoint, "--country", country]
    if params:
        cmd += ["--query", json.dumps(params, ensure_ascii=False)]
    if fresh:
        cmd += ["--fresh"]
    started = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=300)
    took = time.time() - started
    raw = proc.stdout or ""
    (outdir / f"{endpoint}.json").write_text(
        raw or (proc.stderr or ""), encoding="utf-8")

    # CLI 出错时会在 JSON 前面打一行 "[sif-cli] error：..."，要跳过
    body = raw[raw.index("{"):] if "{" in raw else ""
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return {"endpoint": endpoint, "verdict": "PARSE_FAIL",
                "secs": round(took, 2), "log_id": None, "bytes": len(raw),
                "note": (proc.stderr or raw)[:150], "params": params}

    v, note = verdict(payload)
    return {
        "endpoint": endpoint,
        "verdict": v,
        "note": note[:120],
        "secs": round(took, 2),
        "log_id": payload.get("log_id"),
        "bytes": len(raw),
        "attempts": payload.get("attempts"),
        "params": params,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("asin")
    ap.add_argument("--country", default="US")
    ap.add_argument("--keyword", default="pink sweatsuit")
    ap.add_argument("--day", default="2026-09-19")
    ap.add_argument("--month", default="2026-09")
    ap.add_argument("--out", default="/tmp/sifout")
    ap.add_argument("--fresh", action="store_true",
                    help="跳过缓存强制重爬，判定接口是否真失效时用")
    ap.add_argument("--retry-fresh", action="store_true",
                    help="对非 OK 的 endpoint 自动用 --fresh 再试一次")
    args = ap.parse_args()

    outdir = pathlib.Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)

    jobs = build_jobs(args.asin, args.keyword, args.day, args.month)
    print(f"[sweep] {args.asin} / {args.country} / {len(jobs)} endpoints "
          f"-> {outdir}", flush=True)

    results = []
    for i, (ep, params) in enumerate(jobs, 1):
        r = run_one(ep, params, args.country, outdir, args.fresh)
        # 非 OK 的再用 --fresh 打一次：区分「缓存里是旧的失败」和「真拿不到」
        if args.retry_fresh and r["verdict"] != "OK" and not args.fresh:
            r2 = run_one(ep, params, args.country, outdir, True)
            r2["retried_fresh"] = True
            r2["first_verdict"] = r["verdict"]
            r = r2
        results.append(r)
        flag = "" if r["verdict"] == "OK" else "  <<<"
        print(f"[{i:2d}/{len(jobs)}] {ep:32s} {r['verdict']:14s} "
              f"{r['secs']:6.2f}s {r['bytes']:>9d}B "
              f"{r.get('note','')}{flag}", flush=True)

    (outdir / "_sweep_summary.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    buckets = {}
    for r in results:
        buckets.setdefault(r["verdict"], []).append(r["endpoint"])

    print(f"\n[sweep] {args.asin} 实测结果（共 {len(results)} 个 endpoint）")
    for v in ("OK", "OK_BUT_EMPTY", "OK_BUT_NULL", "BAD_PARAMS",
              "DEAD_404", "ERROR", "PARSE_FAIL"):
        if v in buckets:
            print(f"\n  {v}  ({len(buckets[v])} 个)")
            for ep in buckets[v]:
                note = next(x["note"] for x in results if x["endpoint"] == ep)
                print(f"      {ep:34s} {note}")


if __name__ == "__main__":
    main()
