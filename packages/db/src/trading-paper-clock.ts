import { Prisma } from "./client.js";

/** Numeric epoch avoids driver/session timezone interpretation of raw timestamps. */
export async function tradingPaperDatabaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ epoch_ms: bigint }>>(
    Prisma.sql`SELECT floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS epoch_ms`,
  );
  const milliseconds = Number(rows[0]?.epoch_ms);
  if (!Number.isSafeInteger(milliseconds))
    throw new Error("Trusted PAPER database clock unavailable");
  return new Date(milliseconds);
}
