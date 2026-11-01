"""Count funding NA among source rows, never strategy position-bars."""
import argparse
import collections
import csv
import datetime as dt
import json
import math
from pathlib import Path
import okx_bench_archive_v40 as a

def reason_for_day(day, symbol, patterns):
    interval = patterns.get((day, symbol))
    if interval is None:
        return "own_pattern_missing_or_irregular"
    before = patterns.get((day-dt.timedelta(days=1),symbol))
    after = patterns.get((day+dt.timedelta(days=1),symbol))
    if before is None or after is None:
        return "adjacent_pattern_missing_or_irregular"
    if before != interval or after != interval:
        return "adjacent_interval_different"
    return "known"

def summarize(rows, events, known):
    patterns = a.billing_day_patterns(events)
    counts = {}
    for row in rows:
        day = dt.datetime.fromtimestamp(int(row["ts"])/1000,dt.timezone.utc).date()
        month = day.isoformat()[:7]
        counter = counts.setdefault(month, collections.Counter())
        counter["all_rows"] += 1
        eligible = row["eligible"] == "1"
        counter["eligible_rows"] += int(eligible)
        key = (int(row["ts"]), row["symbol"])
        if row["funding"] != "NA":
            if row["funding"] == "":
                if (int(row["ts"]),row["symbol"]) in events:
                    raise ValueError("Blank funding on a bar with an observed settlement")
                if (day,row["symbol"]) not in known:
                    raise ValueError("Blank funding on a day whose absence is not inferred known")
            else:
                value = float(row["funding"])
                if not math.isfinite(value) or key not in events or value != events[key]:
                    raise ValueError("Numeric funding differs from original observed settlement")
            continue
        if key in events:
            raise ValueError("NA hides an observed settlement")
        reason = reason_for_day(day,row["symbol"],patterns)
        if reason == "known" or (day,row["symbol"]) in known:
            raise ValueError("NA on an inferred-known day")
        counter["unknown_rows"] += 1
        counter["all_unknown__"+reason] += 1
        if eligible:
            counter["eligible_unknown_rows"] += 1
            counter["eligible_unknown__"+reason] += 1
    result = {}
    for month,c in sorted(counts.items()):
        result[month] = dict(sorted(c.items()))
        result[month]["all_unknown_share"] = c["unknown_rows"]/c["all_rows"]
        result[month]["eligible_unknown_share"] = (c["eligible_unknown_rows"]/c["eligible_rows"]
                                                      if c["eligible_rows"] else None)
    return result

if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--root",type=Path,required=True)
    p.add_argument("--start",type=a.DATE,required=True)
    p.add_argument("--end",type=a.DATE,required=True)
    p.add_argument("--panel",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    args=p.parse_args()
    if args.out.exists():raise FileExistsError(args.out)
    dates=list(a.days(args.start,args.end))
    for day in dates:
        receipt=json.loads((args.root/"receipts"/(str(day)+".json")).read_text())
        if a.sha_file(a.file_at(args.root,"funding",day))!=receipt["funding"]["sha256"]:
            raise ValueError("Funding original differs from receipt")
    events,known,_=a.load_funding(args.root,dates)
    with args.panel.open(newline="",encoding="utf-8") as stream:
        months=summarize(csv.DictReader(stream),events,known)
    result={"schema":"funding_unknown_row_breakdown_v1","panel_sha256":a.sha_file(args.panel),
            "months":months,"strategy_evaluations":0,"unit":"source rows, not simulated position-bars"}
    a.atomic_bytes(args.out,(json.dumps(result,indent=2)+"\n").encode())
