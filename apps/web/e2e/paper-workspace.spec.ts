import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { buildSkillMd } from "@rakazo/core";
import {
  createDb,
  fillApprovedTradingPaperReservation,
  parsePerpetualControl,
  readOwnedPerpetualWorkspace,
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
  await expect(page.getByLabel("Выберите журнал")).not.toHaveValue("");
  const spotId = await page.getByLabel("Выберите журнал").inputValue();

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
  await expect(
    page
      .getByRole("table", { name: "Открытые фьючерсные позиции" })
      .getByRole("cell", { name: "Long", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "Открытие" })).toBeVisible();
  await expect(
    page.getByLabel("Фьючерсные показатели").getByText("1000 USDT", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Выберите журнал")).toBeHidden();

  await page.getByRole("tab", { name: "Спот" }).click();
  await expect(page.getByLabel("Выберите журнал")).toHaveValue(spotId);
  await expect(page.getByRole("cell", { name: "OKX · ETH-USDT-SWAP" })).toHaveCount(0);
});

test("owner reviews futures Start, sees a worker fill, pauses and closes virtual positions on the shared page", async ({
  page,
}, testInfo) => {
  await signup(
    page,
    "futures-browser-" + Date.now() + "@rakazo.test",
    "password12",
    "Futures Browser",
  );
  await completeOnboarding(page);
  await page.goto("/app/paper-journal");
  await page.getByRole("tab", { name: "Фьючерсы" }).click();
  await page.getByRole("button", { name: "Создать три фьючерсных счёта", exact: true }).click();
  await expect(page.getByLabel("Стратегия и виртуальный счёт")).not.toHaveValue("");
  const ledgerId = await page.getByLabel("Стратегия и виртуальный счёт").inputValue();
  const db = createDb(process.env.DATABASE_URL!);
  try {
    const ledger = await db.prisma.tradingPaperPerpetualLedger.findUniqueOrThrow({
      where: { id: ledgerId },
    });
    const source = {
      spaceId: ledger.spaceId,
      userId: ledger.ownerUserId,
      repository: "okx/agent-trade-kit",
      sourceRef: "a".repeat(40),
      sourceUrl: "https://github.com/okx/agent-trade-kit/blob/" + "a".repeat(40) + "/fixture",
      license: "MIT",
      trust: "curated",
      metrics: {},
      metadata: {},
      preferredVariant: "original",
    };
    const original = buildSkillMd({
      name: "perpetual-research",
      description: "Public futures fixture",
      body: "Research only the supplied public snapshot; no account or exchange order tools.",
    });
    await db.prisma.marketEntry.create({
      data: {
        ...source,
        kind: "skill",
        key: "okx/agent-trade-kit:skills/perpetual-research/SKILL.md@" + source.sourceRef,
        name: "perpetual-research",
        description: "Read-only",
        tags: ["trading"],
        sourcePath: "skills/perpetual-research/SKILL.md",
        originalContent: original,
        digest: createHash("sha256").update(original).digest("hex"),
      },
    });
    const resolver = JSON.stringify({
      semanticKey: "futures.data",
      implementations: [
        {
          name: "Public OKX futures Skill",
          kind: "api",
          reference: "market:okx/agent-trade-kit:perpetual-research",
          priority: 1,
          readOnly: true,
          constraints: ["Public data only"],
        },
      ],
    });
    await db.prisma.marketEntry.create({
      data: {
        ...source,
        kind: "resolver",
        key: "futures.data@" + source.sourceRef,
        name: "Futures data",
        description: "Read-only",
        tags: ["futures.data"],
        sourcePath: "resolver.json",
        originalContent: resolver,
        digest: createHash("sha256").update(resolver).digest("hex"),
      },
    });
    expect(
      await db.prisma.tradingPaperPerpetualLedger.count({
        where: { spaceId: ledger.spaceId, ownerUserId: ledger.ownerUserId },
      }),
    ).toBe(3);
    expect(await db.prisma.tradingPaperPerpetualEvent.count({ where: { ledgerId } })).toBe(0);
    await page.getByRole("button", { name: "Создать три фьючерсных счёта", exact: true }).click();
    await expect(page.getByRole("button", { name: "Проверить запуск фьючерсов" })).toBeVisible();
    expect(
      await db.prisma.tradingPaperPerpetualLedger.count({
        where: { spaceId: ledger.spaceId, ownerUserId: ledger.ownerUserId },
      }),
    ).toBe(3);
    // The broad OKX market is publicly scanned; the fixture keeps E2E independent of exchange uptime.
    const marketsCapturedAt = new Date().toISOString();
    const marketCandidates = ["BTC", "ETH", "SOL"].map((base, index) => {
      const symbol = base + "-USDT-SWAP";
      return {
        market: {
          venue: "okx",
          kind: "perpetual",
          symbol,
          base,
          quote: "USDT",
          status: "active",
          priceIncrement: "0.01",
          quantityIncrement: "0.001",
          minNotional: null,
          expiryAt: null,
        },
        ticker: {
          venue: "okx",
          kind: "perpetual",
          symbol,
          observedAt: marketsCapturedAt,
          fetchedAt: marketsCapturedAt,
          bid: "100",
          ask: "100.01",
          quoteVolume24h: String(100_000_000 - index * 20_000_000),
        },
        spreadBps: 1,
      };
    });
    await page.route("**/rpc/trading/list", (route) =>
      route.fulfill({
        json: {
          json: {
            fetchedAt: new Date().toISOString(),
            candidates: marketCandidates,
            excluded: [],
          },
        },
      }),
    );
    await expect(page.locator("#futures-pairs")).toHaveValue("");
    await page.getByRole("button", { name: "Сканировать фьючерсы OKX" }).click();
    await expect(
      page.getByRole("button", { name: "Подобрать криптовалюты для моего профиля" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Подобрать криптовалюты для моего профиля" }).click();
    await expect(page.locator("#futures-pairs")).toHaveValue(
      "BTC-USDT-SWAP, ETH-USDT-SWAP, SOL-USDT-SWAP",
    );
    await page.getByLabel("Поиск среди прошедших фильтр").fill("ETH");
    await expect(
      page.getByRole("region", { name: "Подходящие бессрочные фьючерсы" }),
    ).toContainText("ETH-USDT-SWAP");
    await page.unroute("**/rpc/trading/list");
    await page.getByRole("button", { name: "Проверить плечо", exact: true }).click();
    await expect(page.getByLabel("Плечо", { exact: true })).toBeVisible();
    await page.getByLabel("Плечо", { exact: true }).fill("21");
    await expect(page.getByRole("button", { name: "Сохранить плечо" })).toBeDisabled();
    await page.getByLabel("Плечо", { exact: true }).fill("3");
    await page.getByRole("button", { name: "Сохранить плечо" }).click();
    await expect(page.getByText("Плечо новых входов: до 3×", { exact: true })).toBeVisible();
    expect(
      await readOwnedPerpetualWorkspace(
        db.prisma,
        { spaceId: ledger.spaceId, userId: ledger.ownerUserId },
        ledgerId,
      ),
    ).toMatchObject({ maxLeverage: 3 });
    // The journal refresh triggered by saving leverage must not unmount the
    // controls and silently discard the explicitly selected market universe.
    await expect(page.locator("#futures-pairs")).toHaveValue(
      "BTC-USDT-SWAP, ETH-USDT-SWAP, SOL-USDT-SWAP",
    );
    await captureScreenshot(page, testInfo, "futures-leverage-setting");
    await expect(page.getByLabel("Источник торговых решений")).toHaveValue("chatgpt-r");
    await page.getByLabel("Длительность новых входов").selectOption("15");
    await page.getByRole("button", { name: "Проверить запуск фьючерсов" }).click();
    await expect(page.getByLabel("Проверка запуска фьючерсов")).toBeVisible();
    await expect(page.getByLabel("Проверка запуска фьючерсов")).toContainText(
      "Тариф симуляции: maker 0,02%, taker 0,05%.",
    );
    await expect(page.getByLabel("Проверка запуска фьючерсов")).toContainText(
      "Исполнение по публичным bid/ask без дополнительного проскальзывания.",
    );
    expect(await db.prisma.tradingPaperPerpetualEvent.count({ where: { ledgerId } })).toBe(0);
    await captureScreenshot(page, testInfo, "futures-reviewed-start");
    await page.getByRole("button", { name: "Запустить PAPER-фьючерсы", exact: true }).click();
    // Exercise the authenticated ChatGPT/R submission path; no model or Codex OAuth is required.
    // Read the hash-verified saved control first: fallback statuses intentionally
    // report model as a fail-closed default when ledger recovery cannot verify yet.
    const persisted = await db.prisma.tradingPaperPerpetualWorkspace.findUniqueOrThrow({
      where: { ledgerId },
    });
    expect(parsePerpetualControl(persisted).researchMode).toBe("chatgpt-r");
    // A worker may be committing the first protection tick concurrently; wait
    // for a VERIFIED read instead of comparing fields of an integrity-blocked fallback.
    await expect
      .poll(
        async () => {
          const state = await readOwnedPerpetualWorkspace(
            db.prisma,
            { spaceId: ledger.spaceId, userId: ledger.ownerUserId },
            ledgerId,
          );
          return state?.status === "verified" ? state.researchMode : "await_verified_ledger";
        },
        { timeout: 20_000 },
      )
      .toBe("chatgpt-r");
    const chatgptPaperSession = await readOwnedPerpetualWorkspace(
      db.prisma,
      { spaceId: ledger.spaceId, userId: ledger.ownerUserId },
      ledgerId,
    );
    expect(chatgptPaperSession?.status).toBe("verified");
    const chatgptRResponse = await page.request.post("/rpc/trading/perpetualWorkspaceCommand", {
      headers: { "x-rakazo-space-id": ledger.spaceId },
      data: {
        json: {
          action: "submit_chatgpt_proposal",
          ledgerId,
          commandId: randomUUID(),
          expectedRevision: chatgptPaperSession!.revision,
          decision: {
            kind: "proposal",
            instrument: "BTC-USDT-SWAP",
            side: "long",
            leverage: 2,
            quantityBase: "1",
            orderType: "market",
            limitPriceQuote: null,
            stopPriceQuote: "97",
            takeProfitPriceQuote: "110",
            recoverySteps: [
              { stepId: "first-retest", triggerPriceQuote: "97.8", allocationPercent: 50 },
              { stepId: "second-retest", triggerPriceQuote: "97.4", allocationPercent: 50 },
            ],
            rationale: "ChatGPT/R approved research proposal for virtual PAPER only",
          },
        },
      },
    });
    expect(chatgptRResponse.ok(), await chatgptRResponse.text()).toBe(true);
    await expect(
      page
        .getByRole("table", { name: "Открытые фьючерсные позиции" })
        .getByRole("cell", { name: "Long", exact: true }),
    ).toBeVisible();
    if (process.env.PAPER_NAUTILUS_PYTHON) {
      await expect(page.getByRole("cell", { name: "Открытие", exact: true })).toBeVisible();
      await expect(
        page.getByText("Симуляция общей маржи Nautilus; ликвидация может отличаться от OKX."),
      ).toBeVisible();
      expect(await db.prisma.tradingPaperPerpetualEngine.count({ where: { ledgerId } })).toBe(1);
      expect(await db.prisma.tradingPaperPerpetualEvent.count({ where: { ledgerId } })).toBe(0);
    } else await expect(page.getByRole("cell", { name: "Открытие", exact: true })).toBeVisible();
    await expect(page.getByLabel("Последнее решение ИИ")).toContainText("Исполнено");
    await expect(page.getByLabel("Сравнение фьючерсных профилей").getByRole("row")).toHaveCount(4);
    await captureScreenshot(page, testInfo, "futures-worker-filled-journal");
    await page.getByRole("button", { name: "Пауза новых фьючерсных входов" }).click();
    await expect(page.getByRole("heading", { name: /Защита открытых позиций/ })).toBeVisible();
    const paused = await readOwnedPerpetualWorkspace(
      db.prisma,
      { spaceId: ledger.spaceId, userId: ledger.ownerUserId },
      ledgerId,
    );
    expect(paused).toMatchObject({ sessionStatus: "paused", openOrders: [] });
    await page.getByRole("button", { name: "Закрыть все виртуальные позиции" }).click();
    await page.getByRole("button", { name: "Подтвердить виртуальное закрытие" }).click();
    if (!process.env.PAPER_NAUTILUS_PYTHON)
      await expect(page.getByRole("cell", { name: "Закрытие", exact: true })).toBeVisible();
    await expect(page.getByText("Открытых позиций нет.", { exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, "futures-paused-and-closed");
    await page.getByRole("tab", { name: "Спот" }).click();
    await expect(page.getByLabel("Выберите журнал")).toHaveValue("");
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
  }
});

test("recovery comparison keeps unresolved losses visible with and without completed recoveries", async ({
  page,
}, testInfo) => {
  await signup(page, `recovery-view-${Date.now()}@rakazo.test`, "password12", "Recovery View");
  await completeOnboarding(page);
  let completed = true;
  await page.route("**/rpc/trading/perpetualJournalRead", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.json?.status === "verified" && body.json.state.strategy === "conservative") {
      body.json.recovery = {
        ...body.json.recovery,
        status: "verified",
        recoveryRatePercent: completed ? "100.00" : null,
        recovered: completed ? 1 : 0,
        completedUnderwater: completed ? 1 : 0,
        openUnderwater: 1,
      };
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto("/app/paper-journal");
  await page.getByRole("tab", { name: "Фьючерсы" }).click();
  await page.getByRole("button", { name: "Создать три фьючерсных счёта", exact: true }).click();
  const comparison = page.getByLabel("Сравнение фьючерсных профилей");
  const row = comparison.getByRole("row").filter({
    has: page.getByRole("button", { name: "Консервативная", exact: true }),
  });
  await expect(row).toContainText("100.00% (1/1)");
  await expect(row.getByText("Открыто в убытке: 1", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "futures-recovery-open-losses");

  completed = false;
  await page.reload();
  await page.getByRole("tab", { name: "Фьючерсы" }).click();
  await expect(row).not.toContainText("100.00%");
  await expect(row.getByText("Открыто в убытке: 1", { exact: true })).toBeVisible();
});
