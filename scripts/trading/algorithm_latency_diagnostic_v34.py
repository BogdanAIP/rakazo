#!/usr/bin/env python3
"""Secondary terminal-price diagnostic, never a replacement primary endpoint.

Compare optimistic zero-delay entry to the frozen one-minute entry at the SAME
terminal observation, on all originally selected alarms and comparators. No new
signals, fee choices or stops are fitted. Instantaneous fills are not certified.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
from statistics import mean


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def terminal(instant, delayed, exit_quote, direction):
    if direction not in (-1,1):
        raise ValueError("A frozen nonzero signal direction is required")
    entry_side, exit_side = ("ask","bid") if direction == 1 else ("bid","ask")
    e0, e1 = float(instant[entry_side]), float(delayed[entry_side])
    last = float(exit_quote[exit_side])
    zero = direction*10000*math.log(last/e0)-20
    lag = direction*10000*math.log(last/e1)-20
    return {"zero_delay_terminal_after20bp":zero,
            "one_minute_terminal_after20bp":lag,
            "entry_delay_loss_bps":zero-lag}


def analyze(root):
    journal = json.loads((Path(root)/"run-status.json").read_bytes())
    if journal.get("status") != "COMPLETE":
        raise ValueError("The frozen primary pipeline must complete first")
    original = Path(root)/"first-independent-v34.json"
    result = json.loads(original.read_bytes())
    if result.get("schema") != "v34_frozen_fresh_historical_pilot":
        raise ValueError("Require completed frozen pilot")
    outputs, checks = [], 0
    for case in result["cases"]:
        path = Path(root)/"features"/f"{case['symbol']}-{case['day']}-restoration-v32.json"
        if sha(path) != case["restoration_cache_sha"]:
            raise ValueError("Original quote cache changed")
        quotes = {int(t):q for t,q in json.loads(path.read_bytes())["quotes"].items()}
        for name,program in case["programs"].items():
            rows, missing = [], 0
            if len(program["records"]) != len(program["quoted_scenarios"]):
                raise ValueError("Primary alarm/scenario identity mismatch")
            for alarm, primary in zip(program["records"], program["quoted_scenarios"]):
                t = alarm["t"]
                q = [quotes.get(t+k*60000,{}) for k in (0,1,16)]
                if any(x.get("status") != "AVAILABLE" for x in q):
                    missing += 1
                    continue
                x = terminal(*q,alarm["direction"])
                if primary.get("outcome") == "CENSORED" and primary.get("exit_minutes_after_entry") == 15:
                    if abs(x["one_minute_terminal_after20bp"]-primary["after_20bp_fee_bps"]) > 1e-8:
                        raise ValueError("Diagnostic disagrees with frozen terminal scenario")
                    checks += 1
                rows.append({"t":t,"direction":alarm["direction"],**x})
            outputs.append({"day":case["day"],"symbol":case["symbol"],"program":name,
                            "original_alarms":len(program["records"]),"missing":missing,
                            "mean":{key:mean(row[key] for row in rows) if rows else None
                                    for key in ("zero_delay_terminal_after20bp",
                                                "one_minute_terminal_after20bp","entry_delay_loss_bps")},
                            "records":rows})
    return {"schema":"v34_secondary_latency_diagnostic","primary_result_sha":sha(original),
            "panels":outputs,"frozen_terminal_scenarios_reconciled":checks,
            "used_to_change_primary_verdict":False,"instantaneous_execution_certified":False,
            "secondary_design":"zero/one-minute entry, common T+16 terminal, fees fixed20bp"}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--root",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    a = p.parse_args()
    if a.out.exists():
        raise FileExistsError("Preserve first diagnostic output")
    result = analyze(a.root)
    with a.out.open("x",encoding="utf-8") as out:
        json.dump(result,out,sort_keys=True,allow_nan=False)
    print(json.dumps({"panels":[{k:v for k,v in x.items() if k != "records"}
                               for x in result["panels"]],
                      "reconciled":result["frozen_terminal_scenarios_reconciled"],
                      "output_sha":sha(a.out)}))


if __name__ == "__main__":
    main()
