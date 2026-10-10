import { expect, test } from "@playwright/test";
import {
  createDb,
  fillApprovedTradingPaperReservation,
  readTradingPaperWorkerFillPreflight,
  readTradingPaperWorkerMarketTargetPreflight,
  readTradingPaperWorkerSignalPreflight,
  recordPublicAdapterPaperQuoteEvidence,
  reserveApprovedTradingPaperSignal,
} from "../../../packages/db/src/index.js";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("owner creates and starts a virtual account, sees an audited fill and pauses entries", async ({
  page,
}, testInfo) => {
  await signup(page, `paper-ui-${Date.now()}@rakazo.test`, "password12", "PAPER Fixture");
  await completeOnboarding(page);
  await page.getByRole("button", { name: "Виртуальные счета · PAPER", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Журнал PAPER-сделок" })).toBeVisible();
  await page.getByRole("button", { name: "Создать счёт", exact: true }).click();
  await page.getByLabel("Название", { exact: true }).fill("Учебная проверка");
  await page.getByRole("button", { name: "Создать виртуальный счёт", exact: true }).click();
  await expect(page.getByText("Готов к запуску", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "paper-account-ready");
  await page.getByRole("combobox", { name: "Исследование", exact: true }).selectOption("baseline");
  await page.getByLabel("Инструмент", { exact: true }).fill("SOL-USDT");
  await page.getByLabel("Длительность, минут", { exact: true }).fill("15");
  await page.getByRole("button", { name: "Запустить сессию", exact: true }).click();
  await page.getByRole("button", { name: "Подтвердить запуск PAPER", exact: true }).click();
  await expect(page.getByText("Торговая сессия", { exact: true })).toBeVisible();
  const ledgerId = await page.getByLabel("Выберите журнал").inputValue();
  const db = createDb(process.env.DATABASE_URL!);
  try {
    const ledger = await db.prisma.tradingPaperLedger.findUniqueOrThrow({
      where: { id: ledgerId },
    });
    const owner = { spaceId: ledger.spaceId, userId: ledger.ownerUserId };
    const signalAuthority = await readTradingPaperWorkerSignalPreflight(db.prisma, owner, ledgerId);
    const fillAuthority = await readTradingPaperWorkerFillPreflight(db.prisma, owner, ledgerId);
    const target = await readTradingPaperWorkerMarketTargetPreflight(db.prisma, owner, ledgerId);
    if (
      signalAuthority.status !== "ready" ||
      fillAuthority.status !== "ready" ||
      target.status !== "ready"
    )
      throw new Error("PAPER approvals missing");
    const market = {
      venue: "okx",
      kind: "spot",
      symbol: "SOL-USDT",
      base: "SOL",
      quote: "USDT",
      status: "active",
      priceIncrement: "0.01",
      quantityIncrement: "0.01",
      minNotional: "5",
      expiryAt: null,
    } as const;
    const quote = async (bid: string, ask: string) => {
      const at = new Date().toISOString();
      return recordPublicAdapterPaperQuoteEvidence(db.prisma, owner, ledgerId, market, {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: at,
        fetchedAt: at,
        bid,
        ask,
        quoteVolume24h: "100000",
      });
    };
    const at = new Date();
    const reserveQuote = await quote("100", "100.1");
    const held = await reserveApprovedTradingPaperSignal(
      db.prisma,
      owner,
      ledgerId,
      {
        kind: "proposal",
        executionStatus: "research_only",
        signalId: `ui-test:${ledgerId}`,
        strategyId: "breakout_20_1h_v1",
        strategyVersion: "1",
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + 120000).toISOString(),
        evidenceIds: ["synthetic-ui-fixture"],
        market,
        action: "spot_buy",
        entryTrigger: "100.1",
        stopLoss: "95",
        takeProfit: ["110"],
        invalidation: "fixture",
        rationale: "UI verification",
        riskBudgetQuote: "10",
        maxSlippageBps: null,
      },
      reserveQuote.id,
      signalAuthority,
      undefined,
      1,
    );
    if (held.status !== "reserved")
      throw new Error(`PAPER reserve denied: ${JSON.stringify(held)}`);
    const fillQuote = await quote("99.99", "100");
    const filled = await fillApprovedTradingPaperReservation(
      db.prisma,
      owner,
      ledgerId,
      held.reservationId,
      fillQuote.id,
      fillAuthority,
      target,
      undefined,
      1,
    );
    expect(filled.status).toBe("filled");
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
  }
  await expect(page.getByRole("cell", { name: "Покупка", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Пауза новых входов", exact: true }).click();
  await expect(page.getByText("Нужно ваше действие", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Включить защиту на 24 часа", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "Покупка", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "paper-fill-paused-journal");
});
