"""Native Nautilus PAPER transport. No network, exchange clients or credentials.

The caller owns immutable input persistence and owner/revision/risk checks.
This process owns matching, positions, funding, fees and the simulated wallet.
Account-wide margin is explicitly reported; never label it isolated collateral.
"""
from decimal import Decimal
import hashlib
import json
import os
import re
import sys

import nautilus_trader
from nautilus_trader.core.nautilus_pyo3 import UUID4
from nautilus_trader.core.nautilus_pyo3.backtest import BacktestEngine, BacktestEngineConfig
from nautilus_trader.core.nautilus_pyo3.model import (
    AccountType, OmsType, Venue, CryptoPerpetual, Money, Price, Quantity,
    QuoteTick, FundingRateUpdate, MarketOrder, LimitOrder, OrderSide,
    ClientOrderId, ContingencyType, TimeInForce, PositionId, StandardMarginModel, MarkPriceUpdate,
)
from nautilus_trader.core.nautilus_pyo3.trading import Strategy, StrategyConfig
from nautilus_trader.model.instruments import CryptoPerpetual as CyPerpetual
from nautilus_trader.model.identifiers import InstrumentId as CyInstrumentId, Symbol, Venue as CyVenue
from nautilus_trader.model.objects import Price as CyPrice, Quantity as CyQuantity, Currency
from nautilus_trader.model.currencies import USDT

VERSION = "1.231.0"
VENUE = Venue("SIM")
DECIMAL = re.compile(r"^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$")
ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")


def exact(raw, positive=False):
    if not isinstance(raw, str) or not DECIMAL.fullmatch(raw):
        raise ValueError("Invalid exact PAPER amount")
    value = Decimal(raw)
    if positive and value <= 0:
        raise ValueError("Positive amount required")
    return value


def identifier(raw):
    if not isinstance(raw, str) or not ID.fullmatch(raw):
        raise ValueError("Invalid PAPER identifier")
    return raw


def instrument(terms, leverage):
    symbol = terms["instrument"]
    if not re.fullmatch(r"[A-Z0-9]{1,20}-USDT-SWAP", symbol):
        raise ValueError("Only linear USDT perpetuals supported")
    base = symbol.split("-")[0]
    price_step = exact(terms["priceIncrement"], True)
    size_step = exact(terms["quantityIncrement"], True)
    cy = CyPerpetual(
        instrument_id=CyInstrumentId(Symbol(symbol), CyVenue("SIM")),
        raw_symbol=Symbol(symbol), base_currency=Currency.from_str(base),
        quote_currency=USDT, settlement_currency=USDT, is_inverse=False,
        price_precision=max(0, -price_step.as_tuple().exponent),
        price_increment=CyPrice.from_str(terms["priceIncrement"]),
        size_precision=max(0, -size_step.as_tuple().exponent),
        size_increment=CyQuantity.from_str(terms["quantityIncrement"]),
        min_quantity=CyQuantity.from_str(terms["minimumBase"]),
        max_quantity=CyQuantity.from_str(terms["maximumBase"]),
        margin_init=Decimal("1") / Decimal(leverage), margin_maint=exact(terms["maintenanceRate"], True),
        maker_fee=exact(terms["makerFeeRate"]), taker_fee=exact(terms["takerFeeRate"]),
        ts_event=0, ts_init=0,
    )
    return CryptoPerpetual.from_dict(cy.to_dict(cy))



def native_price(raw, ins):
    value = exact(raw, True)
    if value % Decimal(str(ins.price_increment)) != 0:
        raise ValueError("Invalid price increment")
    return Price.from_str(f"{value:.{ins.price_precision}f}")

def native_quantity(raw, ins, depth=False):
    value = exact(raw)
    step = Decimal(str(ins.size_increment))
    if depth:
        value = (value // step) * step
    elif value % step != 0:
        raise ValueError("Invalid quantity increment")
    return Quantity.from_str(f"{value:.{ins.size_precision}f}")

class Commands(Strategy):
    def __init__(self, instruments):
        super().__init__(StrategyConfig())
        self.instruments = instruments
        self.pending = []
        self.events = []

    def on_start(self):
        for value in self.instruments.values():
            self.subscribe_quotes(value.id)

    def on_quote(self, quote):
        ready = [c for c in self.pending if self.instruments[c["instrument"]].id == quote.instrument_id]
        self.pending = [c for c in self.pending if c not in ready]
        for command in ready:
            if command["kind"] == "cancel":
                self.cancel_order(ClientOrderId(command["orderId"]))
                continue
            ins = self.instruments[command["instrument"]]
            args = dict(
                trader_id=self.trader_id, strategy_id=self.strategy_id,
                instrument_id=quote.instrument_id, client_order_id=ClientOrderId(command["orderId"]),
                order_side=OrderSide.BUY if command["action"] == "buy" else OrderSide.SELL,
                quantity=native_quantity(command["quantityBase"], ins),
                init_id=UUID4(), ts_init=self.clock.timestamp_ns(),
                time_in_force=TimeInForce.IOC if command["orderType"] == "market" else TimeInForce.GTC,
                reduce_only=command["reduceOnly"], quote_quantity=False,
                contingency_type=ContingencyType.NO_CONTINGENCY,
            )
            if command["orderType"] == "limit":
                order = LimitOrder(**args, price=native_price(command["limitPriceQuote"], ins), post_only=False)
            else:
                order = MarketOrder(**args)
            self.submit_order(order, position_id=PositionId(command["positionId"]))

    def on_order_filled(self, event):
        self.events.append(dict(kind="fill", orderId=str(event.client_order_id),
                                positionId=str(event.position_id), quantityBase=str(event.last_qty),
                                priceQuote=str(event.last_px), commission=str(event.commission),
                                atNs=str(event.ts_event)))

    def on_order_denied(self, event):
        self.events.append(dict(kind="denied", orderId=str(event.client_order_id), reason=str(event.reason)))

    def on_order_rejected(self, event):
        self.events.append(dict(kind="rejected", orderId=str(event.client_order_id), reason=str(event.reason)))

    def on_order_canceled(self, event):
        self.events.append(dict(kind="canceled", orderId=str(event.client_order_id)))

    def on_stop(self):
        pass


class PaperEngine:
    def __init__(self, config):
        if nautilus_trader.__version__ != VERSION:
            raise ValueError("Unsupported Nautilus package version")
        self.account_id = identifier(config["accountId"])
        if config["initialBalanceQuote"] != "1000":
            raise ValueError("Expected 1000 virtual USDT")
        if config["engineVersion"] != VERSION:
            raise ValueError("Engine version mismatch")
        leverage = config["leverage"]
        if not isinstance(leverage, int) or isinstance(leverage, bool) or leverage < 1:
            raise ValueError("Invalid reviewed leverage")
        self.terms = config["instruments"]
        self.leverage = leverage
        self.instruments = {t["instrument"]: instrument(t, leverage) for t in self.terms}
        if not 1 <= len(self.instruments) <= 8 or len(self.instruments) != len(config["instruments"]):
            raise ValueError("Invalid instrument set")
        self.engine = BacktestEngine(config=BacktestEngineConfig(bypass_logging=True, run_analysis=False))
        self.engine.add_venue(
            venue=VENUE, oms_type=OmsType.HEDGING, account_type=AccountType.MARGIN,
            starting_balances=[Money.from_str("1000 USDT")], default_leverage=Decimal(leverage),
            margin_model=StandardMarginModel(),
            liquidation_enabled=True, use_position_ids=True, use_reduce_only=True,
            liquidity_consumption=True, use_random_ids=False,
        )
        for value in self.instruments.values():
            self.engine.add_instrument(value)
        self.strategy = Commands(self.instruments)
        self.engine.add_strategy(self.strategy)
        self.last_marks = {}
        self.last_quotes = {}
        self.event_cursor = 0
        self.seen_adjustments = set()
        self.sequence = 0
        self.last_at = -1
        self.receipts = {}
        self.failed = False

    def apply(self, batch):
        if self.failed:
            raise ValueError("Engine failed; recover from committed inputs")
        digest = hashlib.sha256(json.dumps(batch, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        sequence = batch["sequence"]
        if sequence in self.receipts:
            previous, result = self.receipts[sequence]
            if previous != digest:
                raise ValueError("Conflicting engine input retry")
            return result
        if sequence != self.sequence + 1:
            raise ValueError("Engine input sequence gap")
        registrations = batch.get("registerInstruments", [])
        if registrations:
            if self.engine.cache.positions_open() or self.engine.cache.orders_open():
                raise ValueError("Register new contracts only on a settled account")
            distinct = {terms["instrument"] for terms in registrations}
            if len(distinct) != len(registrations):
                raise ValueError("Duplicate PAPER contract update")
            if len(registrations) > 8 or len(set(self.instruments) | distinct) > 256:
                raise ValueError("PAPER contract registry full")
            latest = {terms["instrument"]: terms for terms in self.terms}
            for terms in registrations:
                symbol = terms["instrument"]
                fresh = symbol not in self.instruments
                value = instrument(terms, self.leverage)
                self.engine.add_instrument(value)
                self.instruments[symbol] = value
                latest[symbol] = terms
                if fresh and self.sequence:
                    self.strategy.subscribe_quotes(value.id)
            self.terms = list(latest.values())
        quotes = batch["quotes"]
        commands = batch.get("commands", [])
        funding = batch.get("funding", [])
        if len(quotes) > 100 or len(commands) > 8 or len(funding) > 100 or (not quotes and (not commands or any(c["kind"] != "cancel" for c in commands))):
            raise ValueError("Invalid engine input batch size")
        data = []
        covered = set()
        for row in quotes:
            ins = self.instruments[row["instrument"]]
            at = int(row["atNs"])
            if at <= self.last_at:
                raise ValueError("Quote clock regression")
            bid, ask = exact(row["bidQuote"], True), exact(row["askQuote"], True)
            if bid > ask:
                raise ValueError("Invalid book spread")
            exact(row["bidAvailableBase"])
            exact(row["askAvailableBase"])
            data.append(QuoteTick(ins.id, native_price(row["bidQuote"], ins), native_price(row["askQuote"], ins),
                                  native_quantity(row["bidAvailableBase"], ins, True), native_quantity(row["askAvailableBase"], ins, True),
                                  at, at))
            if row.get("markPriceQuote") is not None:
                exact(row["markPriceQuote"], True)
                data.append(MarkPriceUpdate(ins.id, Price.from_str(row["markPriceQuote"]), at, at))
            covered.add(row["instrument"])
        if not quotes:
            # A cancellation-only barrier carries no executable liquidity.
            # This drains queued native cancellations without inventing a fill.
            for index, symbol in enumerate(sorted({c["instrument"] for c in commands})):
                previous = self.last_quotes[symbol]
                ins = self.instruments[symbol]
                at = self.last_at + index + 1
                data.append(QuoteTick(ins.id, native_price(previous["bidQuote"], ins),
                    native_price(previous["askQuote"], ins), native_quantity("0", ins), native_quantity("0", ins), at, at))
        for row in funding:
            at = int(row["atNs"])
            rate = Decimal(row["rateSigned"])
            if not rate.is_finite() or abs(rate) > Decimal("0.05") or at <= self.last_at:
                raise ValueError("Invalid funding event")
            data.append(FundingRateUpdate(instrument_id=self.instruments[row["instrument"]].id,
                                          rate=rate, ts_event=at, ts_init=at, next_funding_ns=at))
        for command in commands:
            if command["instrument"] not in self.instruments:
                raise ValueError("Unknown command market")
            identifier(command["orderId"])
            if command["kind"] == "cancel":
                continue
            if command["instrument"] not in covered:
                raise ValueError("Command needs a subsequent fresh same-market quote")
            if command["kind"] != "order" or command["action"] not in ("buy", "sell"):
                raise ValueError("Invalid engine command")
            identifier(command["positionId"])
            value = exact(command["quantityBase"], True)
            step = Decimal(str(self.instruments[command["instrument"]].size_increment))
            if value % step != 0:
                raise ValueError("Invalid quantity increment")
            if not isinstance(command["reduceOnly"], bool) or command["orderType"] not in ("market", "limit"):
                raise ValueError("Invalid order intent")
            if command["orderType"] == "limit":
                exact(command["limitPriceQuote"], True)
        reviewed_leverage = batch.get("leverage", self.leverage)
        if not isinstance(reviewed_leverage, int) or isinstance(reviewed_leverage, bool) or reviewed_leverage < 1:
            raise ValueError("Invalid reviewed leverage")
        if reviewed_leverage != self.leverage:
            if self.engine.cache.positions_open() or self.engine.cache.orders_open():
                raise ValueError("Settle positions and cancel orders before changing leverage")
        data.sort(key=lambda event: event.ts_init)
        try:
            if reviewed_leverage != self.leverage:
                for terms in self.terms:
                    value = instrument(terms, reviewed_leverage)
                    self.engine.add_instrument(value)
                    self.instruments[terms["instrument"]] = value
                self.leverage = reviewed_leverage
            for command in commands:
                if command["kind"] == "cancel":
                    self.strategy.cancel_order(ClientOrderId(command["orderId"]))
            self.strategy.pending.extend(c for c in commands if c["kind"] != "cancel")
            if data:
                self.engine.clear_data()
                self.engine.add_data(data)
                self.engine.run(streaming=True)
            if self.strategy.pending:
                raise ValueError("Engine command was not delivered")
            if data:
                self.last_at = max(event.ts_init for event in data)
            for row in quotes:
                self.last_quotes[row["instrument"]] = dict(row)
                self.last_marks[row["instrument"]] = row.get("markPriceQuote", self.last_marks.get(row["instrument"], row["bidQuote"]))
            self.sequence = sequence
            result = self.snapshot()
            self.receipts[sequence] = (digest, result)
            return result
        except Exception:
            self.failed = True
            raise

    def snapshot(self):
        account = self.engine.cache.account_for_venue(VENUE)
        balances = account.balances()
        balance = next(v for k, v in balances.items() if str(k) == "USDT")
        def money(value):
            text = str(value)
            if not text.endswith(" USDT"):
                raise ValueError("Unsupported settlement currency")
            return text[:-5]
        all_positions = self.engine.cache.positions()
        funding_total = Decimal(0)
        liquidation_orders = set()
        for position in all_positions:
            for fill in position.events():
                if str(fill.client_order_id).startswith("LIQUIDATION"):
                    liquidation_orders.add(str(fill.client_order_id))
            for adjustment in position.adjustments():
                if str(adjustment.adjustment_type) != "FUNDING":
                    raise ValueError("Unsupported native position adjustment")
                payment = money(adjustment.pnl_change)
                funding_total += Decimal(payment)
                key = (str(position.id), str(adjustment.ts_event), payment)
                if key not in self.seen_adjustments:
                    self.strategy.events.append(dict(kind="funding", positionId=str(position.id),
                        paymentQuoteSigned=payment, atNs=str(adjustment.ts_event)))
                    self.seen_adjustments.add(key)
        events = list(self.strategy.events[self.event_cursor:])
        self.event_cursor = len(self.strategy.events)
        positions = []
        for p in self.engine.cache.positions_open():
            symbol = str(p.instrument_id).removesuffix(".SIM")
            mark = self.last_marks[symbol]
            positions.append(dict(
                positionId=str(p.id), instrument=symbol, side=str(p.side),
                quantityBase=str(p.quantity), realizedPnl=money(p.realized_pnl),
                entryPriceQuote=format(Decimal(str(p.avg_px_open)).quantize(Decimal("0.00000001")), "f"),
                markPriceQuote=mark,
                unrealizedPnlQuote=money(p.unrealized_pnl(Price.from_str(mark))),
            ))
        total_fees = sum((Decimal(money(c)) for p in all_positions for c in p.commissions()), Decimal(0))
        realized = sum((Decimal(money(p.realized_pnl)) for p in all_positions), Decimal(0))
        return dict(
            version="nautilus_paper_v1", engineVersion=VERSION, accountId=self.account_id,
            sequence=self.sequence, marginMode="account_wide", leverage=self.leverage, clockNs=str(self.last_at),
            balanceQuote=money(balance.total), availableQuote=money(balance.free),
            lockedQuote=money(balance.locked),
            positions=sorted(positions, key=lambda p: p["positionId"]),
            closedPositions=self.engine.cache.positions_closed_count(),
            openOrders=sorted([dict(orderId=str(o.client_order_id), instrument=str(o.instrument_id).removesuffix(".SIM"),
                quantityBase=str(o.leaves_qty)) for o in self.engine.cache.orders_open()], key=lambda o: o["orderId"]),
            realizedPnlQuote=format(realized, ".8f"), totalFeesQuote=format(total_fees, ".8f"),
            fundingNetQuote=format(funding_total, ".8f"), liquidations=len(liquidation_orders),
            eventCount=self.event_cursor, events=events,
        )

    def dispose(self):
        self.engine.dispose()


def serve():
    # Native Rust logging must never corrupt the JSON response channel.
    output = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    engine = None
    try:
        for line in sys.stdin:
            if len(line) > 1024 * 1024:
                raise ValueError("Engine request too large")
            request = json.loads(line)
            if request["action"] == "initialize":
                if engine is not None:
                    raise ValueError("Already initialized")
                engine = PaperEngine(request["config"])
                result = dict(status="ready", engineVersion=VERSION)
            elif request["action"] == "apply" and engine is not None:
                result = engine.apply(request["batch"])
            else:
                raise ValueError("Invalid engine request")
            output.write(json.dumps(result, separators=(",", ":")) + "\n")
            output.flush()
    finally:
        if engine:
            engine.dispose()


if __name__ == "__main__":
    serve()
