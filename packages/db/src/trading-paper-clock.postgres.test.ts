import { describe, expect, it } from "vitest";
import { createDb, Prisma } from "./client.js";
import { tradingPaperDatabaseNow } from "./trading-paper-clock.js";

const postgres = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
postgres("trusted PAPER clock", () => {
  it("uses the actual epoch regardless of the PostgreSQL session timezone", async () => {
    const db = createDb(process.env.DATABASE_URL!);
    try {
      for (const zone of ["UTC", "Europe/Moscow", "America/New_York"]) {
        await db.prisma.$transaction(async (tx) => {
          await tx.$executeRaw(Prisma.sql`SELECT set_config('TimeZone', ${zone}, true)`);
          const before = Date.now();
          const now = await tradingPaperDatabaseNow(tx);
          expect(Math.abs(now.getTime() - before)).toBeLessThan(15_000);
        });
      }
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
});
