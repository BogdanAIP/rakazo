"""Offline tests: immutable pages, resumability, backoff, and exact provenance."""
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from okx_backfill import (
    RateLimited, backfill, finalize, initialize, scan, sha, validate_page,
)
from run_alpha_audited import verify_snapshot
from test_okx_dataset import SYMBOL, fixtures

AS_OF = datetime(2025, 5, 1, tzinfo=timezone.utc)


class ResumableTests(unittest.TestCase):
    def test_resumes_from_oldest_cursor_without_redownloading(self):
        pages = fixtures(600)
        calls = []
        with tempfile.TemporaryDirectory() as temp:
            def fake_fetch(symbol, cursor, limit):
                self.assertEqual(symbol, SYMBOL)
                self.assertEqual(limit, 100)
                calls.append(cursor)
                return pages[len(calls)-1]
            first = backfill(temp, SYMBOL, max_new_pages=2, fetcher=fake_fetch,
                             sleeper=lambda _: None, as_of=AS_OF)
            self.assertEqual(first["pages_saved"], 2)
            self.assertEqual(first["closed_bars"], 200)
            resumed = backfill(temp, SYMBOL, max_new_pages=4, fetcher=fake_fetch,
                               sleeper=lambda _: None)
            self.assertEqual(resumed["new_pages_saved"], 4)
            self.assertEqual(resumed["closed_bars"], 600)
            self.assertEqual(calls[0], str(int(AS_OF.timestamp() * 1000)))
            self.assertEqual(calls[2], pages[1]["data"][-1][0])
            with self.assertRaises(ValueError):
                finalize(temp, SYMBOL, Path(temp)/"unready.csv")

    def test_no_auto_retry_after_429_and_resume(self):
        pages = fixtures(600)
        calls = []
        with tempfile.TemporaryDirectory() as temp:
            def limited(symbol, cursor, limit):
                calls.append(cursor)
                if len(calls) == 2:
                    raise RateLimited("simulated 429")
                return pages[0]
            status = backfill(temp, SYMBOL, max_new_pages=3,
                              fetcher=limited, sleeper=lambda _:None, as_of=AS_OF)
            self.assertEqual(status["status"], "RATE_LIMITED_STOPPED_NO_RETRY")
            self.assertEqual(status["new_pages_saved"], 1)
            self.assertEqual(len(calls), 2)
            self.assertEqual(status["pages_saved"], 1)
            next_status = backfill(temp, SYMBOL, max_new_pages=1,
                                   fetcher=lambda s,c,l: pages[1],
                                   sleeper=lambda _:None)
            self.assertEqual(next_status["pages_saved"], 2)

    def test_tamper_and_mixed_instrument_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            backfill(temp, SYMBOL, max_new_pages=1,
                     fetcher=lambda s,c,l: fixtures()[0],
                     sleeper=lambda _:None, as_of=AS_OF)
            file = Path(temp)/"page-0000.json"
            original = file.read_text()
            file.write_text(original.replace('"code":"0"', '"code":"1"'), encoding="utf-8")
            with self.assertRaises(ValueError):
                backfill(temp, SYMBOL, max_new_pages=1, fetcher=lambda *_: None)
            with self.assertRaises(ValueError):
                backfill(temp, "SOL-USDT-SWAP", max_new_pages=1, fetcher=lambda *_: None)

    def test_refuse_cursor_nonprogress_and_invalid_clock(self):
        pages = fixtures(600)
        with tempfile.TemporaryDirectory() as temp:
            backfill(temp, SYMBOL, max_new_pages=1,
                     fetcher=lambda s,c,l: pages[0],
                     sleeper=lambda _:None, as_of=AS_OF)
            with self.assertRaises(ValueError):
                backfill(temp, SYMBOL, max_new_pages=1,
                         fetcher=lambda s,c,l: pages[0],
                         sleeper=lambda _:None)
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(ValueError):
                initialize(temp, SYMBOL, as_of=datetime(2025,1,1))
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(ValueError):
                backfill(temp, SYMBOL, min_spacing=0.1)

    def test_finalizes_90day_immutable_snapshot_and_checksum(self):
        # Build 8640 realistic FORMAT synthetic candles; no API or actual market edge.
        pages = fixtures(8640)
        with tempfile.TemporaryDirectory() as temp:
            session = initialize(Path(temp)/"pages", SYMBOL, AS_OF)
            directory = Path(temp)/"pages"
            cursor = None
            for i, page in enumerate(pages):
                meta = validate_page(page, cursor, session["capture_as_of"])
                envelope = {"page_no":i, "payload":page,
                            "payload_sha256":sha(page), "meta":meta}
                (directory / f"page-{i:04d}.json").write_text(
                    json.dumps(envelope, sort_keys=True), encoding="utf-8"
                )
                cursor = meta["oldest"]
            _, _, _, count = scan(directory, session)
            self.assertEqual(count, 8640)
            out = Path(temp)/"BTC-USDT-SWAP.csv"
            manifest = finalize(directory, SYMBOL, out)
            self.assertEqual(manifest["closed_bars"], 8640)
            verified, _, digest = verify_snapshot(
                out, out.with_suffix(".manifest.json"))
            self.assertEqual(len(verified), 8640)
            self.assertEqual(digest, manifest["csv_sha256"])
            with self.assertRaises(FileExistsError):
                finalize(directory, SYMBOL, out)


if __name__ == "__main__":
    unittest.main()
