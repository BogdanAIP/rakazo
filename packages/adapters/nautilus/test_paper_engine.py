import json
import unittest
from paper_engine import PaperEngine

def config(leverage=20):
    return dict(accountId="paper.test", engineVersion="1.231.0", initialBalanceQuote="1000", leverage=leverage,
                instruments=[dict(instrument=symbol, priceIncrement="0.01", quantityIncrement="0.01",
                                  minimumBase="0.01", maximumBase="100.00", maintenanceRate="0.005",
                                  makerFeeRate="0.001", takerFeeRate="0.001")
                             for symbol in ("BTC-USDT-SWAP", "ETH-USDT-SWAP")])

def batch(sequence, commands=None, rate=None, price="100.00", depth="100.00"):
    at = 1704067200000000000 + sequence * 1000000000
    return dict(sequence=sequence, commands=commands or [], quotes=[
        dict(instrument=symbol, atNs=str(at), bidQuote=price, askQuote=price,
             bidAvailableBase=depth, askAvailableBase=depth)
        for symbol in ("ETH-USDT-SWAP", "BTC-USDT-SWAP")
    ], funding=[] if rate is None else [dict(instrument="BTC-USDT-SWAP", atNs=str(at+1), rateSigned=rate)])

def order(order_id, position, action, quantity="1.00", symbol="BTC-USDT-SWAP", reduce=False, limit=None):
    return dict(kind="order", orderId=order_id, positionId=position, action=action, instrument=symbol,
                quantityBase=quantity, reduceOnly=reduce, orderType="limit" if limit else "market",
                limitPriceQuote=limit)

class EngineTest(unittest.TestCase):

    def test_exact_wire_precision_and_new_contract_registration_replay(self):
        engine = PaperEngine(config())
        first = batch(1, [order("one", "LONG", "buy", quantity="1")], price="100", depth="1.009")
        second = batch(2, [order("close", "LONG", "sell", quantity="1", reduce=True)])
        third = batch(3)
        terms = dict(config()["instruments"][0], instrument="SOL-USDT-SWAP")
        third["registerInstruments"] = [terms]
        third["quotes"].append(dict(third["quotes"][0], instrument="SOL-USDT-SWAP"))
        third["commands"] = [order("sol", "SOL", "buy", quantity="1", symbol="SOL-USDT-SWAP")]
        inputs = [first, second, third]
        try:
            results = [engine.apply(value) for value in inputs]
            self.assertEqual(results[0]["positions"][0]["quantityBase"], "1.00")
            self.assertEqual(results[2]["positions"][0]["instrument"], "SOL-USDT-SWAP")
            self.assertEqual(results[2]["balanceQuote"], "999.70000000")
        finally:
            engine.dispose()
        replay = PaperEngine(config())
        try:
            for value, expected in zip(inputs, results):
                self.assertEqual(replay.apply(json.loads(json.dumps(value))), expected)
        finally:
            replay.dispose()

    def test_hedge_funding_partial_close_and_recovery_at_all_presets(self):
        inputs = [batch(1,[order("one","LONG","buy")]),
                  batch(2,[order("two","SHORT","sell")]),
                  batch(3,[order("three","OTHER","buy","0.50","ETH-USDT-SWAP")]),
                  batch(4,[order("four","LONG","sell","0.40",reduce=True)]),
                  batch(5,rate="0.001")]
        for leverage in (5,10,20):
            original = PaperEngine(config(leverage))
            expected=[]
            try:
                for event in inputs:
                    first=original.apply(event)
                    expected.append(first)
                    self.assertEqual(original.apply(event),first)
                self.assertEqual(len(first["positions"]),3)
                self.assertEqual(first["balanceQuote"],"999.75000000")
                self.assertEqual(first["eventCount"],6)
                self.assertEqual(len(first["events"]),2)
                self.assertEqual(first["marginMode"],"account_wide")
            finally:
                original.dispose()
            replay=PaperEngine(config(leverage))
            try:
                for event, first in zip(inputs, expected):
                    self.assertEqual(replay.apply(json.loads(json.dumps(event))),first)
            finally:
                replay.dispose()

    def test_fee_depends_on_native_execution_not_order_type(self):
        for mode, entry_fee in (("market", "0.05000000"),
                                ("marketable_limit", "0.05000000"),
                                ("resting_limit", "0.01980000")):
            with self.subTest(mode=mode):
                terms = config()
                for instrument_terms in terms["instruments"]:
                    instrument_terms.update(makerFeeRate="0.0002", takerFeeRate="0.0005")
                engine = PaperEngine(terms)
                inputs, outputs = [], []
                try:
                    limit = None if mode == "market" else ("99.00" if mode == "resting_limit" else "101.00")
                    inputs.append(batch(1, [order("entry", "LONG", "buy", limit=limit)]))
                    outputs.append(engine.apply(inputs[-1]))
                    if mode == "resting_limit":
                        self.assertEqual(outputs[-1]["positions"], [])
                        inputs.append(batch(2, price="98.00"))
                        outputs.append(engine.apply(inputs[-1]))
                    self.assertEqual(outputs[-1]["totalFeesQuote"], entry_fee)
                    inputs.append(batch(len(inputs) + 1, [order("exit", "LONG", "sell", reduce=True)]))
                    outputs.append(engine.apply(inputs[-1]))
                    expected = "0.06980000" if mode == "resting_limit" else "0.10000000"
                    self.assertEqual(outputs[-1]["totalFeesQuote"], expected)
                    self.assertEqual(outputs[-1]["positions"], [])
                finally:
                    engine.dispose()
                replay = PaperEngine(terms)
                try:
                    for value, expected_output in zip(inputs, outputs):
                        self.assertEqual(replay.apply(json.loads(json.dumps(value))), expected_output)
                finally:
                    replay.dispose()

    def test_limit_wait_cross_and_cancel(self):
        engine=PaperEngine(config())
        try:
            result=engine.apply(batch(1,[order("limit","LONG","buy",limit="99.00")]))
            self.assertEqual(result["positions"],[])
            result=engine.apply(batch(2,price="98.00"))
            self.assertEqual(len(result["positions"]),1)
            engine.apply(batch(3,[order("pending","SHORT","sell",limit="110.00")]))
            result=engine.apply(batch(4,[dict(kind="cancel",orderId="pending",instrument="BTC-USDT-SWAP")]))
            self.assertTrue(any(e["kind"]=="canceled" for e in result["events"]))
        finally:
            engine.dispose()

    def test_consumes_only_visible_liquidity_and_liquidates_without_custom_accounting(self):
        engine=PaperEngine(config())
        try:
            result=engine.apply(batch(1,[order("large","LONG","buy","19.00")],depth="1.00"))
            self.assertEqual(result["positions"][0]["quantityBase"],"1.00")
            self.assertTrue(any(e["kind"]=="canceled" for e in result["events"]))
        finally:
            engine.dispose()
        engine=PaperEngine(config())
        try:
            engine.apply(batch(1,[order("large","LONG","buy","19.00")]))
            result=engine.apply(batch(2,price="30.00"))
            self.assertEqual(result["positions"],[])
            self.assertEqual(result["closedPositions"],1)
            self.assertEqual(result["liquidations"],1)
        finally:
            engine.dispose()

    def test_maintenance_is_independent_of_leverage_and_mark_drives_funding(self):
        for leverage in (5, 10, 20):
            engine = PaperEngine(config(leverage))
            try:
                first = batch(1, [order("one", "LONG", "buy")])
                for quote in first["quotes"]:
                    quote["markPriceQuote"] = "120.00"
                result = engine.apply(first)
                self.assertEqual(result["lockedQuote"], "0.50000000")
                self.assertEqual(result["positions"][0]["unrealizedPnlQuote"], "20.00000000")
                result = engine.apply(batch(2, rate="0.001"))
                self.assertEqual(result["balanceQuote"], "999.78000000")
                self.assertEqual(result["events"][0]["kind"], "funding")
                self.assertEqual(result["totalFeesQuote"], "0.10000000")
            finally:
                engine.dispose()

    def test_reviewed_leverage_changes_only_when_flat_and_replay_preserves_it(self):
        engine = PaperEngine(config(20))
        try:
            first = batch(1)
            first["leverage"] = 1
            engine.apply(first)
            denied = engine.apply(batch(2, [order("large", "LONG", "buy", "19.00")]))
            self.assertEqual(denied["positions"], [])
            self.assertEqual(denied["leverage"], 1)
            self.assertEqual(denied["events"][0]["kind"], "denied")
            third = batch(3, [order("small", "LONG", "buy")])
            third["leverage"] = 5
            engine.apply(third)
            change = batch(4)
            change["leverage"] = 10
            with self.assertRaises(ValueError):
                engine.apply(change)
        finally:
            engine.dispose()

    def test_cancel_precedes_crossing_quote_and_can_run_without_quotes(self):
        engine = PaperEngine(config())
        try:
            engine.apply(batch(1, [order("limit", "LONG", "buy", limit="99.00")]))
            second = batch(2, [dict(kind="cancel", orderId="limit", instrument="BTC-USDT-SWAP")], price="98.00")
            result = engine.apply(second)
            self.assertEqual(result["positions"], [])
            self.assertEqual(result["openOrders"], [])
            engine.apply(batch(3, [order("pending", "LONG", "buy", limit="97.00")]))
            fourth = batch(4, [dict(kind="cancel", orderId="pending", instrument="BTC-USDT-SWAP")])
            fourth["quotes"] = []
            result = engine.apply(fourth)
            self.assertEqual(result["openOrders"], [])
            self.assertTrue(any(e["kind"] == "canceled" for e in result["events"]))
        finally:
            engine.dispose()

    def test_refuses_fork_gap_and_backdated_inputs(self):
        engine=PaperEngine(config())
        try:
            engine.apply(batch(1))
            with self.assertRaises(ValueError):
                engine.apply(batch(1,price="99.00"))
            with self.assertRaises(ValueError):
                engine.apply(batch(3))
            broken=batch(2)
            broken["quotes"][0]["atNs"]=batch(1)["quotes"][0]["atNs"]
            with self.assertRaises(ValueError):
                engine.apply(broken)
        finally:
            engine.dispose()

if __name__=="__main__":
    unittest.main()
