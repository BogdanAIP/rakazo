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
import {
  appendVerifiedPerpetualPaperEvent,
  createDisabledPerpetualPaperAccount,
} from "../../../packages/db/src/trading-paper-perpetual-store.js";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

for (const { venue, symbol } of [
  { venue: "okx", symbol: "SOL-USDT" },
  { venue: "bingx", symbol: "S-USDT" },
] as const) {
  test(
    "owner creates and starts a virtual account, sees an audited fill and pauses entries (" +
      venue +
      " " +
      symbol +
      ")",
    async ({ page }, testInfo) => {
      await signup(page, `paper-ui-${Date.now()}@rakazo.test`, "password12", "PAPER Fixture");
      await completeOnboarding(page);
      await page.getByRole("button", { name: "Виртуальные счета · PAPER", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Журнал PAPER-сделок" })).toBeVisible();
      await page.getByRole("button", { name: "Создать счёт", exact: true }).click();
      await page.getByLabel("Название", { exact: true }).fill("Учебная проверка");
      await page.getByRole("button", { name: "Создать виртуальный счёт", exact: true }).click();
      await expect(page.getByText("Готов к запуску", { exact: true })).toBeVisible();
      await captureScreenshot(page, testInfo, "paper-account-ready");
      await page
        .getByRole("combobox", { name: "Исследование", exact: true })
        .selectOption("baseline");
      await page
        .getByRole("combobox", { name: "Источник котировок", exact: true })
        .selectOption(venue);
      await page.getByLabel("Инструмент", { exact: true }).fill(symbol);
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
        const signalAuthority = await readTradingPaperWorkerSignalPreflight(
          db.prisma,
          owner,
          ledgerId,
        );
        const fillAuthority = await readTradingPaperWorkerFillPreflight(db.prisma, owner, ledgerId);
        const target = await readTradingPaperWorkerMarketTargetPreflight(
          db.prisma,
          owner,
          ledgerId,
        );
        if (
          signalAuthority.status !== "ready" ||
          fillAuthority.status !== "ready" ||
          target.status !== "ready"
        )
          throw new Error("PAPER approvals missing");
        const market = {
          venue,
          kind: "spot",
          symbol,
          base: symbol.slice(0, -5),
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
            venue,
            kind: "spot",
            symbol,
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
    },
  );
}

test("PAPER exposes the shared Codex model picker before completing onboarding", async ({
  page,
}, testInfo) => {
  await signup(page, `paper-models-${Date.now()}@rakazo.test`, "password12", "PAPER Models");
  await page.waitForURL(/\/(onboarding|app)(?:\/|$)/);
  await page.goto("/app/paper-journal");
  await expect(page.getByRole("heading", { name: "Журнал PAPER-сделок" })).toBeVisible();
  await page.getByRole("button", { name: "Модели", exact: true }).click();
  await page.getByPlaceholder("Search providers").fill("OpenAI Codex");
  await page.getByRole("button").filter({ hasText: "OpenAI Codex" }).first().click();
  await page.getByRole("combobox", { name: "Model", exact: true }).click();
  for (const model of [
    "GPT-6.1 Sol",
    "GPT-6 Astra",
    "GPT-6 Sol",
    "GPT-6 Luna",
    "GPT-5.6 Sol",
    "GPT-5.6 Terra",
    "GPT-5.6 Luna",
  ]) {
    await expect(page.getByRole("option", { name: model, exact: true })).toBeAttached();
  }
  await page.getByRole("combobox", { name: "Search models" }).fill("GPT-6.1 Sol");
  await expect(page.getByRole("option", { name: "GPT-6.1 Sol", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "paper-codex-model-picker");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close model settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Журнал PAPER-сделок" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Создать счёт", exact: true })).toBeVisible();
});

test("PAPER spot and futures share one journal page with separate verified owner-scoped accounts", async ({
  page,
}) => {
  await signup(page, `paper-tabs-${Date.now()}@rakazo.test`, "password12", "Journal Tabs");
  await completeOnboarding(page);
  await page.goto("/app/paper-journal");
  await expect(page.getByRole("heading", { name: "Журнал PAPER-сделок" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Спот" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Создать счёт", exact: true }).click();
  await page.getByRole("button", { name: "Создать виртуальный счёт", exact: true }).click();
  await expect(page.getByLabel("Выберите журнал")).toBeVisible();
  const spotId = await page.getByLabel("Выберите журнал").inputValue();
  expect(spotId).toBeTruthy();

  const db = createDb(process.env.DATABASE_URL!);
  const futuresId = `paper-tabs-futures-${Date.now()}`;
  try {
    const spot = await db.prisma.tradingPaperLedger.findUniqueOrThrow({
      where: { id: spotId },
    });
    const owner = { spaceId: spot.spaceId, userId: spot.ownerUserId };
    const openedAt = new Date().toISOString();
    await createDisabledPerpetualPaperAccount(db.prisma, owner, {
      ledgerId: futuresId,
      strategy: "conservative",
      openedAt,
    });
    await appendVerifiedPerpetualPaperEvent(db.prisma, owner, {
      ledgerId: futuresId,
      eventId: "open-one",
      sequence: 1,
      recordedAt: new Date(Date.now() + 1000).toISOString(),
      kind: "open",
      positionId: "long-eth",
      venue: "okx",
      instrument: "ETH-USDT-SWAP",
      side: "long",
      leverage: 1,
      quantityBase: "1",
      entryPriceQuote: "100",
      entryFeeQuote: "0.1",
      maintenanceMarginBps: 50,
    });
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
  }

  await page.getByRole("tab", { name: "Фьючерсы" }).click();
  await expect(page.getByRole("tab", { name: "Фьючерсы" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("heading", { name: "Фьючерсы · PAPER" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Стратегия и виртуальный счёт" })).toHaveValue(
    futuresId,
  );
  await expect(page.getByRole("heading", { name: "Открытые фьючерсные позиции" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "OKX · ETH-USDT-SWAP" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Long" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Открытие" })).toBeVisible();
  await expect(
    page.getByRole("tabpanel", { name: "Фьючерсы" }).getByText("1000 USDT"),
  ).toBeVisible();
  await expect(page.getByLabel("Выберите журнал")).toHaveCount(0);

  await page.getByRole("tab", { name: "Спот" }).click();
  await expect(page.getByLabel("Выберите журнал")).toHaveValue(spotId);
  await expect(page.getByRole("cell", { name: "OKX · ETH-USDT-SWAP" })).toHaveCount(0);
});
