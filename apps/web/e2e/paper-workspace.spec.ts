import { createHash, randomUUID } from "node:crypto";
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
  await expect(page.getByRole("heading", { name: "Обзор счёта" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Профиль и виртуальный счёт" })).toHaveValue(
    futuresId,
  );
  await expect(page.getByRole("heading", { name: "Позиции и план" })).toBeVisible();
  await expect(page.getByRole("article", { name: "ETH-USDT-SWAP · план позиции" })).toBeVisible();
  await expect(
    page
      .getByRole("article", { name: "ETH-USDT-SWAP · план позиции" })
      .getByText("Long", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "Открытие" })).toBeVisible();
  await expect(
    page.getByLabel("Фьючерсные показатели").getByText("Капитал по рынку", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Выберите журнал")).toBeHidden();

  await page.getByRole("tab", { name: "Спот" }).click();
  await expect(page.getByLabel("Выберите журнал")).toHaveValue(spotId);
  await expect(page.getByRole("article", { name: "ETH-USDT-SWAP · план позиции" })).toHaveCount(0);
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
  await expect(page.getByLabel("Профиль и виртуальный счёт")).not.toHaveValue("");
  const ledgerId = await page.getByLabel("Профиль и виртуальный счёт").inputValue();
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
    await page
      .locator("summary")
      .filter({ hasText: /^Создать счёт$/ })
      .click();
    await page.getByRole("button", { name: "Создать три фьючерсных счёта", exact: true }).click();
    await page.getByRole("button", { name: "Плечо и управление" }).click();
    await expect(page.getByRole("button", { name: "Проверить запуск фьючерсов" })).toBeVisible();
    expect(
      await db.prisma.tradingPaperPerpetualLedger.count({
        where: { spaceId: ledger.spaceId, ownerUserId: ledger.ownerUserId },
      }),
    ).toBe(3);
    await expect(page.getByText(/Базовый риск от текущего капитала: идея до/)).toBeVisible();
    await captureScreenshot(page, testInfo, "paper-equity-risk-budgets");
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
    await expect(page.getByLabel("Источник торговых решений")).toHaveValue("external");
    await page.getByLabel("Источник торговых решений").selectOption("model");
    await expect(
      page.getByText(/Без нового предложения ChatGPT\/R бот не открывает позиции/),
    ).not.toBeVisible();
    await captureScreenshot(page, testInfo, "futures-autonomous-source");
    await page.getByLabel("Источник торговых решений").selectOption("external");
    await expect(
      page.getByText(/Без нового предложения ChatGPT\/R бот не открывает позиции/),
    ).toBeVisible();
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
    // Clicking only dispatches an async Start handler; it does NOT await its RPC.
    // Wait for the DB revision/session to be committed before reading the control.
    // Do not mistake the prior, correctly idle "model" mode for a bad Start.
    await expect
      .poll(
        async () => {
          const row = await db.prisma.tradingPaperPerpetualWorkspace.findUnique({
            where: { ledgerId },
          });
          if (!row || row.revision < 2) return "await_start_commit";
          const control = parsePerpetualControl(row);
          if (control.sessionStatus !== "active") return "await_active_session";
          return control.researchMode;
        },
        { timeout: 20_000 },
      )
      .toBe("external");
    // Exercise the authenticated ChatGPT/R submission path; no model or Codex OAuth is required.
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
      .toBe("external");
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
          action: "submit_external_proposal",
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
            plannedRecoveryNotionalQuote: "50",
            recoverySteps: [
              { stepId: "first-retest", triggerPriceQuote: "97.8", allocationPercent: 50 },
              { stepId: "second-retest", triggerPriceQuote: "97.4", allocationPercent: 50 },
            ],
            rationale: "ChatGPT/R approved research proposal for virtual PAPER only",
            comparison: {
              asOf: new Date().toISOString(),
              validUntil: new Date(Date.now() + 600000).toISOString(),
              method: "Сравнение закрытых H1 свечей",
              profileRationale: "Размер ограничен риском выбранного профиля.",
              candidates: [
                {
                  instrument: "BTC-USDT-SWAP",
                  verdict: "selected",
                  reason: "Подтверждённый сигнал и допустимый защитный план",
                  facts: [{ name: "Цена fixture", value: "100" }],
                },
                {
                  instrument: "SOL-USDT-SWAP",
                  verdict: "rejected",
                  reason: "Нет отдельного подтверждения",
                  facts: [],
                },
              ],
            },
          },
        },
      },
    });
    expect(chatgptRResponse.ok(), await chatgptRResponse.text()).toBe(true);
    await expect(
      page.getByLabel("Открытые фьючерсные позиции").getByText("Long", { exact: true }),
    ).toBeVisible();
    if (process.env.PAPER_NAUTILUS_PYTHON) {
      await expect(page.getByRole("cell", { name: "Открытие", exact: true })).toBeVisible();
      await expect(page.getByText("Ликвидация · оценка", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("img", { name: "Кривая капитала по проверенному журналу" }),
      ).toBeVisible();
      const card = page.getByRole("article", { name: "BTC-USDT-SWAP · план позиции" });
      await expect(card.getByText("Стоп", { exact: true }).locator("..")).toContainText("97,00");
      await expect(card.getByText("Тейк-профит", { exact: true }).locator("..")).toContainText(
        "110,00",
      );
      await expect(card).toContainText("97,80");
      await expect(card).toContainText("97,40");
      const controlsSummary = page.locator("#paper-session-controls > summary");
      if (
        await page
          .locator("#paper-session-controls")
          .evaluate((node) => (node as HTMLDetailsElement).open)
      )
        await controlsSummary.click();
      const createSummary = page.locator("summary").filter({ hasText: /^Создать счёт$/ });
      if (await createSummary.locator("..").evaluate((node) => (node as HTMLDetailsElement).open))
        await createSummary.click();
      await page
        .getByRole("heading", { name: "Обзор счёта", exact: true })
        .scrollIntoViewIfNeeded();
      await captureScreenshot(page, testInfo, "futures-risk-dashboard");
      await page.emulateMedia({ colorScheme: "dark" });
      await captureScreenshot(page, testInfo, "futures-risk-dashboard-dark");
      await page.setViewportSize({ width: 390, height: 844 });
      await card.scrollIntoViewIfNeeded();
      await captureScreenshot(page, testInfo, "futures-risk-position-mobile");
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
      await page.getByRole("button", { name: "Просадка", exact: true }).click();
      await expect(
        page.getByRole("img", { name: "Просадка от предыдущего максимума капитала" }),
      ).toBeVisible();
      await page.getByRole("slider", { name: "Точка графика" }).focus();
      await page.keyboard.press("ArrowLeft");
      await captureScreenshot(page, testInfo, "futures-risk-dashboard-mobile");
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole("button", { name: "Капитал", exact: true }).click();
      await page.getByRole("button", { name: "Плечо и управление" }).click();
      expect(await db.prisma.tradingPaperPerpetualEngine.count({ where: { ledgerId } })).toBe(1);
      expect(await db.prisma.tradingPaperPerpetualEvent.count({ where: { ledgerId } })).toBe(0);
    } else await expect(page.getByRole("cell", { name: "Открытие", exact: true })).toBeVisible();
    await expect(page.getByLabel("Последнее решение ИИ")).toContainText("Исполнено");
    await page
      .locator("summary")
      .filter({ hasText: /^Сравнить профили$/ })
      .click();
    await expect(page.getByLabel("Сравнение фьючерсных профилей").getByRole("row")).toHaveCount(4);
    await page.getByText("Сравнение кандидатов", { exact: true }).click();
    await expect(page.getByRole("table", { name: "Сравнение кандидатов" })).toContainText(
      "Нет отдельного подтверждения",
    );
    await captureScreenshot(page, testInfo, "futures-research-comparison");

    await page
      .locator("summary")
      .filter({ hasText: /^Решения и анализ ИИ$/ })
      .click();
    const researchHistory = page.getByLabel("Последние решения", { exact: true });
    await researchHistory.locator("summary").first().focus();
    await page.keyboard.press("Enter");
    await expect(researchHistory.getByRole("listitem")).toHaveCount(1);
    await researchHistory.getByRole("listitem").first().locator("summary").first().click();
    await researchHistory.getByText("Сравнение кандидатов", { exact: true }).click();
    await expect(
      researchHistory.getByRole("table", { name: "Сравнение кандидатов" }),
    ).toContainText("Нет отдельного подтверждения");
    await captureScreenshot(page, testInfo, "futures-research-history");

    await captureScreenshot(page, testInfo, "futures-worker-filled-journal");
    await page.getByRole("button", { name: "Пауза новых фьючерсных входов" }).click();
    await expect(page.getByRole("heading", { name: /Защита открытых позиций/ })).toBeVisible();
    const paused = await readOwnedPerpetualWorkspace(
      db.prisma,
      { spaceId: ledger.spaceId, userId: ledger.ownerUserId },
      ledgerId,
    );
    expect(paused).toMatchObject({ sessionStatus: "paused", openOrders: [] });
    const held = await db.prisma.tradingPaperPerpetualWorkspace.findUniqueOrThrow({
      where: { ledgerId },
    });
    const heldPlans = parsePerpetualControl(held).plans;
    await page.getByRole("button", { name: "Проверить возобновление", exact: true }).click();
    await expect(page.getByLabel("Проверка возобновления фьючерсов")).toBeVisible();
    await page.locator("#futures-resume-duration").selectOption("15");
    await captureScreenshot(page, testInfo, "futures-reviewed-resume");
    await page.getByRole("button", { name: "Возобновить PAPER-фьючерсы", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "ИИ-торговля · Торговая сессия", exact: true }),
    ).toBeVisible();
    const resumed = await db.prisma.tradingPaperPerpetualWorkspace.findUniqueOrThrow({
      where: { ledgerId },
    });
    expect(parsePerpetualControl(resumed)).toMatchObject({
      sessionStatus: "active",
      researchMode: "external",
      plans: heldPlans,
    });
    expect(resumed.revision).toBeGreaterThan(held.revision);
    await captureScreenshot(page, testInfo, "futures-resumed-with-position");

    // Scoped connector access is created through the normal signed-in owner,
    // then exercised with fetch (no ambient browser cookies).
    const accessResponse = await page.request.post("/rpc/rpcAccess/grantCreate", {
      headers: { "x-rakazo-space-id": ledger.spaceId },
      data: {
        json: {
          label: "PAPER connector fixture",
          durationMinutes: 15,
          procedures: ["trading/perpetualWorkspaceRead"],
        },
      },
    });
    expect(accessResponse.ok()).toBe(true);
    const access = (await accessResponse.json()).json;
    const callWithAccess = (procedure: string, input: unknown, spaceId = ledger.spaceId) =>
      fetch(new URL("/rpc/" + procedure, page.url()), {
        method: "POST",
        headers: {
          authorization: "Bearer " + access.token,
          "content-type": "application/json",
          "x-rakazo-space-id": spaceId,
        },
        body: JSON.stringify({ json: input }),
      });
    const scopedRead = await callWithAccess("trading/perpetualWorkspaceRead", { ledgerId });
    expect(scopedRead.status).toBe(200);
    expect((await scopedRead.json()).json).toMatchObject({ ledgerId, status: "verified" });
    expect((await callWithAccess("me", {})).status).toBe(401);
    expect(
      (
        await callWithAccess("rpcAccess/grantCreate", {
          label: "forbidden",
          durationMinutes: 15,
          procedures: ["trading/list"],
        })
      ).status,
    ).toBe(401);
    expect(
      (await callWithAccess("trading/perpetualWorkspaceRead", { ledgerId }, "another-space"))
        .status,
    ).toBe(401);
    const revokeResponse = await page.request.post("/rpc/rpcAccess/grantRevoke", {
      headers: { "x-rakazo-space-id": ledger.spaceId },
      data: { json: { id: access.id } },
    });
    expect(revokeResponse.ok()).toBe(true);
    expect((await callWithAccess("trading/perpetualWorkspaceRead", { ledgerId })).status).toBe(401);

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
  await page
    .locator("summary")
    .filter({ hasText: /^Сравнить профили$/ })
    .click();
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
  await page
    .locator("summary")
    .filter({ hasText: /^Сравнить профили$/ })
    .click();
  await expect(row).not.toContainText("100.00%");
  await expect(row.getByText("Открыто в убытке: 1", { exact: true })).toBeVisible();
});
