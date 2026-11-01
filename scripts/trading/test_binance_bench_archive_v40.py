"""Offline tests for the Binance USD-M archive builder. No network."""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import tempfile
import unittest
import zipfile
from pathlib import Path

import algorithm_bench_v40 as bench
import binance_bench_archive_v40 as bn

HOUR = 3_600_000


def put(root: Path, kind: str, sym: str, month: str, rows, header=None):
    path = bn.archive_path(root, kind, sym, month)
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.StringIO(newline="")
    w = csv.writer(buf, lineterminator="\n")
    if header:
        w.writerow(header)
    w.writerows(rows)
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as z:
        z.writestr(path.name.replace(".zip", ".csv"), buf.getvalue())
    payload = data.getvalue()
    path.write_bytes(payload)
    path.with_name(path.name + ".CHECKSUM").write_text(f"{hashlib.sha256(payload).hexdigest()}  {path.name}\n")


def month_start(month: str) -> int:
    y, m = map(int, month.split("-"))
    return int(dt.datetime(y, m, 1, tzinfo=dt.timezone.utc).timestamp() * 1000)


def kline_rows(month: str, quote_per_hour: float, stop_ms=None):
    t0 = month_start(month)
    y, m = map(int, month.split("-"))
    nxt = month_start(f"{y + (m == 12):04d}-{1 if m == 12 else m + 1:02d}")
    rows = []
    t = t0
    while t < nxt and (stop_ms is None or t < stop_ms):
        rows.append([t, "1.0", "1.1", "0.9", "1.05", "100", t + HOUR - 1, quote_per_hour, 10, "50", quote_per_hour / 2, "0"])
        t += HOUR
    return rows


def funding_rows(month: str, skip_day=None, every=8):
    t0 = month_start(month)
    y, m = map(int, month.split("-"))
    nxt = month_start(f"{y + (m == 12):04d}-{1 if m == 12 else m + 1:02d}")
    out, t = [], t0
    while t < nxt:
        day = dt.datetime.fromtimestamp(t / 1000, tz=dt.timezone.utc).date()
        if day != skip_day:
            out.append([t + 3, every, "0.0001"])  # Binance clocks a few ms after the hour
        t += every * HOUR
    return out


class TestBinanceBuilder(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        months = ["2020-01", "2020-02", "2020-03"]
        gap = dt.date(2020, 3, 10)
        for i, mth in enumerate(months):
            # BIG: liquid, header-less klines; SMALL: illiquid, with header; GONE: delisted mid-February
            put(self.root, "klines", "BIGUSDT", mth, kline_rows(mth, 400_000))
            put(self.root, "klines", "SMALLUSDT", mth, kline_rows(mth, 1_000),
                header=["open_time", "open", "high", "low", "close", "volume", "close_time", "quote_volume", "count",
                        "taker_buy_volume", "taker_buy_quote_volume", "ignore"])
            put(self.root, "fundingRate", "BIGUSDT", mth, funding_rows(mth, skip_day=gap),
                header=["calc_time", "funding_interval_hours", "last_funding_rate"])
            put(self.root, "fundingRate", "SMALLUSDT", mth, funding_rows(mth),
                header=["calc_time", "funding_interval_hours", "last_funding_rate"])
            if i < 2:
                stop = month_start("2020-02") + 10 * 24 * HOUR if mth == "2020-02" else None
                put(self.root, "klines", "GONEUSDT", mth, kline_rows(mth, 500_000, stop))
        self.symbols = ["BIGUSDT", "SMALLUSDT", "GONEUSDT", "BTCUSDT_230331"]

    def tearDown(self):
        self.tmp.cleanup()

    def test_panel_matches_bench_rules(self):
        out = self.root / "panel.csv"
        audit = bn.build(self.root, self.symbols, "2020-01", "2020-03", out)
        self.assertEqual(audit["contracts"], 3)  # delivery contract ignored
        p = bench.load_panel(out)
        self.assertEqual(p.bar_ms, HOUR)
        check = bench.audit_panel(p, HOUR, 5_000_000, 30)
        self.assertEqual(check["eligibility_check"]["mismatched_rows"], 0)
        self.assertEqual(sum(p.eligible["SMALLUSDT"]), 0)
        self.assertGreater(sum(p.eligible["BIGUSDT"]), 0)
        self.assertEqual(sum(1 for x in p.series["close"]["GONEUSDT"] if x == x), (31 + 10) * 24)
        # funding billed to the bar ending at the settlement; ms jitter tolerated
        jan2_0700 = (month_start("2020-01") + (24 + 7) * HOUR - p.times[0]) // HOUR
        self.assertAlmostEqual(p.series["funding"]["BIGUSDT"][jan2_0700], 0.0001)
        # a missing settlement day and its neighbours are unknown, never zero
        gap_bar = (month_start("2020-03") + 9 * 24 * HOUR + 12 * HOUR - p.times[0]) // HOUR
        self.assertNotEqual(p.series["funding"]["BIGUSDT"][gap_bar], p.series["funding"]["BIGUSDT"][gap_bar])
        with open(out) as fh:
            rows = list(csv.reader(fh))[1:]
        keys = [(int(r[0]), r[1]) for r in rows]
        self.assertEqual(keys, sorted(keys))

    def test_single_letter_base_symbol_not_silently_dropped(self):
        self.assertTrue(bn.SYMBOL.fullmatch("TUSDT"))
        self.assertFalse(bn.SYMBOL.fullmatch("BTCUSDT_230331"))
        put(self.root, "klines", "TUSDT", "2020-01", kline_rows("2020-01", 250_000))
        put(self.root, "fundingRate", "TUSDT", "2020-01", funding_rows("2020-01"),
            header=["calc_time", "funding_interval_hours", "last_funding_rate"])
        audit = bn.build(self.root, ["TUSDT"], "2020-01", "2020-01", self.root / "single.csv")
        self.assertEqual(audit["contracts"], 1)
        self.assertTrue(any(",TUSDT," in row for row in (self.root / "single.csv").read_text().splitlines()))

    def test_checksum_mismatch_stops(self):
        path = bn.archive_path(self.root, "klines", "BIGUSDT", "2020-02")
        path.with_name(path.name + ".CHECKSUM").write_text("0" * 64 + "  x\n")
        with self.assertRaises(ValueError):
            bn.build(self.root, self.symbols, "2020-01", "2020-03", self.root / "p.csv")

    def test_sync_verifies_and_skips_missing_months(self):
        dst = self.root / "mirror"
        src = self.root

        def fetch(url):
            kind = "klines" if "/klines/" in url else "fundingRate"
            name = url.rsplit("/", 1)[1]
            sym = name.split("-")[0]
            month = name.split("-")[-2] + "-" + name.split("-")[-1].split(".")[0]
            path = bn.archive_path(src, kind, sym, month)
            target = path.with_name(path.name + ".CHECKSUM") if url.endswith(".CHECKSUM") else path
            if not target.exists():
                raise RuntimeError("HTTP Error 404: Not Found")
            return target.read_bytes()

        res = bn.sync(dst, ["GONEUSDT"], "2020-01", "2020-03", fetch=fetch)
        self.assertEqual(res["downloaded"], 2)   # klines Jan and Feb
        self.assertEqual(res["missing"], 4)      # funding x3 and klines Mar
        again = bn.sync(dst, ["GONEUSDT"], "2020-01", "2020-03", fetch=fetch)
        self.assertEqual(again["downloaded"], 0)


if __name__ == "__main__":
    unittest.main()
