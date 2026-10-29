"""Public-only source, strict source payload and as-of no-lookahead regression."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from algorithm_microstructure_capture_v7 import (
    analyze_book, analyze_trades, book_url, capture, joint_asof,
    read_public, save, trade_url, verify,
)
T=1_793_311_200_000
SYMBOLS=[f"T{i:02}-USDT-SWAP" for i in range(50)]
UNIVERSE={"members":[{"rank":i+1,"symbol":s} for i,s in enumerate(SYMBOLS)]}


def orderbook(symbol,ts):
    return json.dumps({"code":"0","data":[{"seqId":42,"ts":str(ts),
        "bids":[[str(100-i),"2","0","1"] for i in range(5)],
        "asks":[[str(101+i),"1","0","1"] for i in range(5)]}],
        "msg":""}).encode()


def trades(symbol,ts):
    return json.dumps({"code":"0","data":[{
        "instId":symbol,"tradeId":str(1000-i),"px":"100",
        "sz":"1" if i<5 else "2",
        "side":"buy" if i<5 else "sell",
        "ts":str(ts-i*100),"source":"0",
    } for i in range(10)],"msg":""}).encode()


def run_capture():
    now=[T]
    def clock():
        now[0]+=250
        return now[0]
    def read(url):
        if url.endswith("/time"):
            raw=json.dumps({"code":"0","data":[{"ts":str(now[0])}]}).encode()
        elif "market/books?" in url:
            raw=orderbook(url.split("instId=")[1].split("&")[0],now[0]-100)
        elif "market/trades?" in url:
            raw=trades(url.split("instId=")[1].split("&")[0],now[0]-100)
        else:
            raise ValueError("unexpected URL")
        return raw
    return capture(UNIVERSE,"f"*64,1,read=read,clock=clock)


class MicrostructureTests(unittest.TestCase):
    def test_taker_side_and_book_metrics_do_not_identify_person(self):
        b=analyze_book(orderbook(SYMBOLS[0],T),T+100)
        t=analyze_trades(trades(SYMBOLS[0],T),SYMBOLS[0],T+100)
        self.assertEqual(b["top5_depth_imbalance"],"0.3333333333333333333333333333")
        self.assertEqual(t["last100_taker_imbalance"],"-0.3333333333333333333333333333")
        self.assertTrue(t["only_truncated_last100_not_interval_complete"])
        self.assertFalse(b["rpi_depth_included"])

    def test_public_allowlist_blocks_accounts_and_paths(self):
        for url in ("https://www.okx.com/api/v5/trade/order",
                    "https://www.okx.com/api/v5/account/balance",
                    "https://evil.example/api/v5/market/books"):
            with self.assertRaises(ValueError):
                read_public(url)
        with self.assertRaises(ValueError):
            book_url("../../../etc/passwd")
        self.assertIn("limit=100",trade_url("BTC-USDT-SWAP"))

    def test_bad_orderbook_price_ladder_and_bad_trade_identity(self):
        b=json.loads(orderbook(SYMBOLS[0],T))
        b["data"][0]["asks"][1][0]="100"
        with self.assertRaises(ValueError):
            analyze_book(json.dumps(b).encode(),T+100)
        b=json.loads(orderbook(SYMBOLS[0],T))
        b["data"][0]["bids"][0][0]="105"
        with self.assertRaises(ValueError):
            analyze_book(json.dumps(b).encode(),T+100)
        t=json.loads(trades(SYMBOLS[0],T))
        t["data"][0]["side"]="unknown"
        with self.assertRaises(ValueError):
            analyze_trades(json.dumps(t).encode(),SYMBOLS[0],T+100)
        t=json.loads(trades(SYMBOLS[0],T))
        t["data"][1]["tradeId"]=t["data"][0]["tradeId"]
        with self.assertRaises(ValueError):
            analyze_trades(json.dumps(t).encode(),SYMBOLS[0],T+100)

    def test_full_batch_roundtrip_and_tampering(self):
        doc,evidence=run_capture()
        self.assertEqual(len(evidence),12)
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"sample"
            digest=save(folder,doc,evidence)
            _,other=verify(folder,UNIVERSE,"f"*64,1)
            self.assertEqual(digest,other)
            with self.assertRaises(FileExistsError):
                save(folder,doc,evidence)
            (folder/evidence[1][0]["raw_file"]).write_bytes(b"BAD")
            with self.assertRaises(ValueError):
                verify(folder,UNIVERSE,"f"*64,1)

    def test_asof_is_not_exchange_ts_and_no_paper_signal(self):
        doc,_=run_capture()
        sym=SYMBOLS[0]
        book=next(x for x in doc["records"] if x["kind"]=="book" and x["symbol"]==sym)
        trade=next(x for x in doc["records"] if x["kind"]=="trades" and x["symbol"]==sym)
        decision=max(book["received_ms"],trade["received_ms"])
        self.assertEqual(joint_asof(doc,sym,decision-1)["status"],"ABSTAIN_UNRECEIVED")
        ready=joint_asof(doc,sym,decision)
        self.assertEqual(ready["status"],"DESCRIPTIVE_ONLY")
        self.assertIsNone(ready["observation"]["live_trade_or_paper_action"])
        self.assertEqual(ready["observation"]["asof_not_before_ms"],decision)
        self.assertEqual(joint_asof(doc,sym,decision+61_000)["status"],"ABSTAIN_STALE")
        bad=copy.deepcopy(doc)
        x=next(x for x in bad["records"] if x["kind"]=="book" and x["symbol"]==sym)
        x["observed"]["stale"]=True
        self.assertEqual(joint_asof(bad,sym,decision)["status"],"ABSTAIN_SOURCE_QUALITY")


if __name__=="__main__":
    unittest.main()
