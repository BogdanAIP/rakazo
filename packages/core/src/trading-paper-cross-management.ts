/** PAPER-only pure advisory: half-exit at 1.5R and fee-buffered approximate BE.
 * This is NOT order authority and does not guarantee actual funding outcomes.
 */
const S = 100000000n,
	BPS = 10000n;
const a = (v: string): bigint => {
	if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(v)) throw Error("decimal");
	const [w, d = ""] = v.split(".");
	return BigInt(w!) * S + BigInt(d.padEnd(8, "0"));
};
const f = (v: bigint) => {
	const d = (v % S).toString().padStart(8, "0").replace(/0+$/, "");
	return (v / S).toString() + (d ? "." + d : "");
};
const ceil = (x: bigint, y: bigint) => (x + y - 1n) / y;
export type PaperHalfExitInput = Readonly<{
	side: "long" | "short";
	entryPriceQuote: string;
	originalStopPriceQuote: string;
	markPriceQuote: string;
	quantityBase: string;
	lotIncrementBase: string;
	minimumBase: string;
	priceIncrement: string;
	feeBpsPerSide: number;
	slippageBpsPerSide: number;
	fundingReserveBps?: number;
}>;
export function planPaperHalfExit(
	input: PaperHalfExitInput,
):
	| { status: "not_ready"; reason: string }
	| {
			status: "ready";
			quantityBase: string;
			breakEvenStop: string;
			triggerPrice: string;
	  } {
	try {
		const e = a(input.entryPriceQuote),
			s = a(input.originalStopPriceQuote),
			m = a(input.markPriceQuote),
			q = a(input.quantityBase),
			lot = a(input.lotIncrementBase),
			min = a(input.minimumBase),
			tick = a(input.priceIncrement);
		if (!e || !m || !q || !lot || !min || !tick)
			return { status: "not_ready", reason: "zero_input" };
		const long = input.side === "long",
			risk = long ? e - s : s - e,
			gain = long ? m - e : e - m;
		if (risk <= 0n)
			return { status: "not_ready", reason: "invalid_initial_stop" };
		if (gain <= 0n || 2n * gain < 3n * risk)
			return { status: "not_ready", reason: "below_1_5R" };
		const half = (q / 2n / lot) * lot;
		if (half < min || q - half < min)
			return { status: "not_ready", reason: "invalid_partial_lot" };
		const fee = input.feeBpsPerSide,
			slip = input.slippageBpsPerSide,
			fund = input.fundingReserveBps ?? 5;
		if (
			![fee, slip, fund].every(
				(x) => Number.isSafeInteger(x) && x >= 0 && x <= 200,
			)
		)
			return { status: "not_ready", reason: "invalid_costs" };
		const reserve = ceil(e * BigInt(fee * 2 + slip * 2 + fund), BPS);
		if (reserve >= e)
			return { status: "not_ready", reason: "costs_exceed_entry" };
		const raw = long ? e + reserve : e - reserve;
		const be = long ? ceil(raw, tick) * tick : (raw / tick) * tick;
		if (long ? be >= m : be <= m)
			return { status: "not_ready", reason: "be_not_behind_market" };
		const trigger = long ? e + ceil(3n * risk, 2n) : e - ceil(3n * risk, 2n);
		return {
			status: "ready",
			quantityBase: f(half),
			breakEvenStop: f(be),
			triggerPrice: f(trigger),
		};
	} catch {
		return { status: "not_ready", reason: "invalid_input" };
	}
}
