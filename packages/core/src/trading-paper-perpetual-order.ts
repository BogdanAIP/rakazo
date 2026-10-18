/** Resting PAPER limits follow the signal's bounded validity; legacy/market TTL is five minutes. */
export function paperPerpetualOrderExpiresAt(input: {
  orderType: "market" | "limit";
  submittedAt: string;
  sessionExpiresAt: string;
  comparisonValidUntil?: string;
}): string {
  const submitted = Date.parse(input.submittedAt);
  const session = Date.parse(input.sessionExpiresAt);
  const comparison = input.comparisonValidUntil ? Date.parse(input.comparisonValidUntil) : Infinity;
  if (![submitted, session].every(Number.isFinite) || Number.isNaN(comparison))
    throw new Error("Invalid PAPER order validity");
  const ttl = input.orderType === "limit" && input.comparisonValidUntil ? 1_800_000 : 300_000;
  return new Date(Math.min(submitted + ttl, session, comparison)).toISOString();
}
