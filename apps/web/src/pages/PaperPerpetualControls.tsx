import type {
  PaperPerpetualCommand,
  PaperPerpetualPreparation,
  PaperPerpetualWorkspaceStatus,
  PaperVenueLeverageLimits,
  TradingScanOutput,
} from "@rakazo/contracts";
import { getPaperExperimentPreset, PAPER_OKX_LV1_FEES } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

const phases: Record<PaperPerpetualWorkspaceStatus["phase"], string> = {
  idle: "Готов к запуску",
  active: "Торговая сессия",
  protection_only: "Защита открытых позиций",
  finished: "Новые входы остановлены",
  attention_required: "Нужно ваше действие",
};
const errors: Record<string, string> = {
  restart_paused: "После перезапуска новые входы остановлены. Проверяйте защиту открытых позиций.",
  model_unavailable:
    "Модель не смогла завершить анализ. Новые входы остановлены; проверьте выбранную модель и доступ.",
  market_skill_unavailable: "Источник анализа недоступен или изменился. Новые входы остановлены.",
  market_data_unavailable:
    "Свежие публичные котировки недоступны. Новые входы остановлены; защита повторяет проверку в пределах разрешённого срока.",
  protection_unavailable: "Не удалось исполнить защитный выход. Проверьте позиции и срок защиты.",
  execution_unavailable: "Не удалось проверить исполнение. Новые входы остановлены.",
  research_commit_unavailable: "Не удалось сохранить анализ. Новые входы остановлены.",
  queue_unavailable: "Фоновая проверка недоступна. Новые входы остановлены.",
  integrity_blocked: "Целостность данных не подтверждена. Управление заблокировано.",
};
const outcomes: Record<string, string> = {
  no_trade: "Без сделки",
  reduce_submitted: "Частичное сокращение запрошено",
  denied_reduce: "Частичное сокращение отклонено",
  denied_add_unreserved: "Доливка превышает заранее выделенный резерв",
  denied_recovery_plan_invalid: "План двух доливок несовместим с защитным стопом",
  denied_recovery_step_missing: "Не указан допустимый этап восстановления",
  denied_recovery_step_not_triggered: "Уровень доливки ещё не достигнут",
  denied_recovery_step_no_reversal: "Нет подтверждения разворота — доливка отклонена",
  denied_recovery_step_exceeds_step: "Доливка превышает резерв указанной ступени",
  protective_stop_tightened: "Защитный стоп усилен",
  denied_stop_unknown: "Позиция или план защиты не найдены",
  denied_stop_not_tighter: "Отказ: изменение ослабляет защиту",
  drawdown_circuit_breaker: "Новые входы остановлены из-за просадки",
  filled: "Исполнено",
  partially_filled: "Исполнено частично",
  order_pending: "Ордер ожидает цены",
  order_expired: "Срок ордера истёк",
  closed: "Позиция закрыта",
  close_partial_or_not_ready: "Выход исполнен частично или ожидает котировки",
  denied_market: "Пара вне выбранного списка",
  expired_research: "Анализ устарел",
};
const dateTime = (iso: string) => new Date(iso).toLocaleString("ru-RU");
function feeSummary(status: PaperPerpetualWorkspaceStatus | null, instruments: string[]) {
  const fees = instruments.map(
    (symbol) =>
      status?.executionFees?.find((fee) => fee.instrument === symbol) ?? PAPER_OKX_LV1_FEES,
  );
  const rates = (key: "makerFeeRate" | "takerFeeRate") =>
    [
      ...new Set(
        fees.map(
          (fee) =>
            (Number(fee[key]) * 100).toLocaleString("ru-RU", { maximumFractionDigits: 6 }) + "%",
        ),
      ),
    ].join(" / ");
  return (
    "Тариф симуляции: maker " + rates("makerFeeRate") + ", taker " + rates("takerFeeRate") + "."
  );
}
type Review = {
  preparation: Extract<PaperPerpetualPreparation, { status: "ready" }>;
  instruments: string[];
  duration: number;
};

export function PaperPerpetualControls({
  ledgerId,
  openPositions,
  onChanged,
}: {
  ledgerId: string;
  openPositions: number;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<PaperPerpetualWorkspaceStatus | null>(null);
  const [symbols, setSymbols] = useState("");
  const [marketScan, setMarketScan] = useState<TradingScanOutput | null>(null);
  const [scanning, setScanning] = useState(false);
  const [minTurnoverMillions, setMinTurnoverMillions] = useState(5);
  const [maxSpreadBps, setMaxSpreadBps] = useState(20);
  const [marketQuery, setMarketQuery] = useState("");
  const [leverage, setLeverage] = useState(1);
  const [limits, setLimits] = useState<PaperVenueLeverageLimits[]>([]);
  const [duration, setDuration] = useState(20160);
  const [review, setReview] = useState<Review | null>(null);
  const [closeReview, setCloseReview] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true,
      fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const result = await rpc.trading.perpetualWorkspaceRead({ ledgerId });
        if (active) setStatus(result);
      } catch {
        if (active) {
          setStatus(null);
          setError("Не удалось проверить состояние сессии.");
        }
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [ledgerId]);
  useEffect(() => {
    if (status?.status === "verified") setLeverage(status.maxLeverage);
    setLimits([]);
  }, [ledgerId, status?.maxLeverage]);
  async function checkLeverage() {
    const instruments = (
      status?.sessionStatus === "active"
        ? status.instruments
        : symbols.split(/[,\s]+/).filter(Boolean)
    ).map((symbol) => symbol.toUpperCase());
    setPending(true);
    setError(null);
    setLimits([]);
    try {
      setLimits(await rpc.trading.perpetualLeverageRead({ ledgerId, instruments }));
    } catch {
      setError("Биржевые лимиты недоступны. Плечо не изменено.");
    } finally {
      setPending(false);
    }
  }
  async function scanPerpetualMarkets() {
    if (
      !Number.isFinite(minTurnoverMillions) ||
      minTurnoverMillions < 0.1 ||
      minTurnoverMillions > 1000 ||
      !Number.isFinite(maxSpreadBps) ||
      maxSpreadBps < 1 ||
      maxSpreadBps > 200
    ) {
      setError("Проверьте фильтры: объём 0,1–1000 млн USDT, спред 1–200 б.п.");
      return;
    }
    setScanning(true);
    setMarketScan(null);
    setError(null);
    try {
      const scan = await rpc.trading.list({
        venue: "okx",
        kind: "perpetual",
        allowedQuotes: ["USDT"],
        minQuoteVolume24h: minTurnoverMillions * 1_000_000,
        maxSpreadBps,
        maxDataAgeMs: 60_000,
      });
      setMarketScan(scan);
    } catch {
      setError("Не удалось получить свежий список бессрочных фьючерсов OKX. Выбор не изменён.");
    } finally {
      setScanning(false);
    }
  }
  function applyScannedSymbols(next: string[]) {
    if (!marketScan || Date.now() - Date.parse(marketScan.fetchedAt) > 90_000) {
      setError("Результаты сканирования устарели. Обновите список OKX.");
      return;
    }
    if (next.length > 8) {
      setError("Для одной PAPER-сессии можно выбрать не более 8 инструментов.");
      return;
    }
    setSymbols(next.join(", "));
    setLimits([]);
    setError(null);
  }
  function toggleScannedSymbol(symbol: string) {
    const current = symbols
      .split(/[,\s]+/)
      .filter(Boolean)
      .map((value) => value.toUpperCase());
    applyScannedSymbols(
      current.includes(symbol) ? current.filter((value) => value !== symbol) : [...current, symbol],
    );
  }
  async function prepare() {
    const instruments = symbols
      .split(/[,\s]+/)
      .filter(Boolean)
      .map((s) => s.toUpperCase());
    if (
      !instruments.length ||
      instruments.length > 8 ||
      new Set(instruments).size !== instruments.length ||
      instruments.some((s) => !/^[A-Z0-9]{1,20}-USDT-SWAP$/.test(s))
    ) {
      setError("Укажите от 1 до 8 разных USDT-SWAP пар через запятую.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await rpc.trading.perpetualMarketPrepare({ ledgerId });
      if (result.status === "ready") setReview({ preparation: result, instruments, duration });
      else
        setError(
          result.reason === "engine_not_configured"
            ? "Движок PAPER-фьючерсов не настроен."
            : result.reason === "model_not_configured"
              ? "Выберите доступную модель через кнопку «Модели»."
              : "Источник futures.data не готов. Проверьте выбранный Market Skill в Rakazo.",
        );
    } catch {
      setError("Не удалось подготовить запуск. Обновите состояние счёта.");
    } finally {
      setPending(false);
    }
  }
  async function command(action: PaperPerpetualCommand["action"]) {
    if (!status || pending) return;
    const base = { ledgerId, commandId: crypto.randomUUID(), expectedRevision: status.revision };
    let input: PaperPerpetualCommand;
    if (action === "start") {
      if (!review) return;
      input = {
        ...base,
        action,
        venue: "okx",
        instruments: review.instruments,
        durationMinutes: review.duration,
        protectionMinutes: 1440,
        source: review.preparation.scope,
      };
    } else if (action === "set_leverage") {
      if (!limits.length) return;
      input = {
        ...base,
        action,
        venue: "okx",
        instruments: limits.map((l) => l.instrument),
        maxLeverage: leverage,
      };
    } else if (action === "protect") input = { ...base, action, durationMinutes: 1440 };
    else input = { ...base, action };
    setPending(true);
    setError(null);
    try {
      setStatus(await rpc.trading.perpetualWorkspaceCommand(input));
      setReview(null);
      setCloseReview(false);
      onChanged();
    } catch {
      setReview(null);
      setCloseReview(false);
      setError(
        "Команда не выполнена. Обновите состояние; перед новым запуском закройте позиции предыдущей сессии.",
      );
      try {
        setStatus(await rpc.trading.perpetualWorkspaceRead({ ledgerId }));
      } catch {
        setStatus(null);
      }
    } finally {
      setPending(false);
    }
  }
  const selectedSymbols = symbols
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((symbol) => symbol.toUpperCase());
  const scanFresh = marketScan !== null && Date.now() - Date.parse(marketScan.fetchedAt) <= 90_000;
  const visibleCandidates = (marketScan?.candidates ?? [])
    .filter(({ market }) => market.symbol.includes(marketQuery.trim().toUpperCase()))
    .slice(0, 40);
  const verified = status?.status === "verified" && status.managed ? status : null;
  const preset = verified ? getPaperExperimentPreset(verified.strategy) : null;
  const mayStart =
    verified &&
    verified.sessionStatus !== "active" &&
    openPositions === 0 &&
    !verified.openOrders.length &&
    !verified.pendingClose;
  return (
    <section
      className="space-y-4 rounded-2xl border border-border bg-card p-5"
      aria-label="Управление фьючерсной сессией"
    >
      <h3 className="font-semibold">
        ИИ-торговля · {verified ? phases[verified.phase] : "Проверка состояния"}
      </h3>
      {verified && preset && (
        <>
          <p className="text-sm text-muted-foreground">
            Риск на сделку до {preset.maxPerIdeaRiskQuote} USDT · дневной убыток до{" "}
            {preset.maxDailyLossQuote} USDT · совокупный риск до {preset.maxOpenRiskQuote} USDT ·
            плечо до {verified.maxLeverage}× · позиций до {preset.maxConcurrentPositions}.
          </p>
          {verified.expiresAt && (
            <p className="text-sm">
              Новые входы до {dateTime(verified.expiresAt)}. Защита до{" "}
              {verified.protectionExpiresAt ? dateTime(verified.protectionExpiresAt) : "—"}.
            </p>
          )}
          {verified.runtimeError && (
            <p role="status" className="text-sm text-destructive">
              {errors[verified.runtimeError] ?? "Сессия требует проверки. Новые входы остановлены."}
            </p>
          )}
          {verified.lastDecision && (
            <section className="rounded-xl bg-muted p-3 text-sm" aria-label="Последнее решение ИИ">
              <p className="font-medium">
                {outcomes[verified.lastDecision.outcome] ??
                  (verified.lastDecision.outcome.startsWith("denied_")
                    ? "Предложение отклонено проверкой риска"
                    : "Ордер отменён или не исполнен")}
              </p>
              <p className="mt-1 whitespace-pre-wrap">{verified.lastDecision.rationale}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {dateTime(verified.lastDecision.at)} · {verified.lastDecision.model}
              </p>
            </section>
          )}
          {verified.openOrders.length > 0 && (
            <section className="text-sm" aria-label="Ожидающие фьючерсные ордера">
              {verified.openOrders.map((o) => (
                <p key={o.orderId}>
                  {o.instrument} · {o.side} · {o.quantityBase} · лимит{" "}
                  {o.limitPriceQuote ?? "по рынку"} · до {dateTime(o.expiresAt)}
                </p>
              ))}
            </section>
          )}
          <section className="space-y-2" aria-label="Настройка плеча">
            <p className="text-sm">Плечо новых входов: до {verified.maxLeverage}×</p>
            <Button
              variant="outline"
              disabled={pending || !!review}
              onClick={() => void checkLeverage()}
            >
              Проверить плечо
            </Button>
            {limits.length > 0 && (
              <>
                {limits.map((limit) => (
                  <p key={limit.instrument} className="text-sm text-muted-foreground">
                    OKX · {limit.instrument} · максимум {limit.tiers[0]!.maxLeverage}×; при
                    увеличении позиции действует лимит её уровня.
                  </p>
                ))}
                <label htmlFor="futures-leverage" className="block text-sm">
                  Плечо
                </label>
                <input
                  id="futures-leverage"
                  type="number"
                  min={1}
                  max={Math.floor(Math.min(...limits.map((l) => l.tiers[0]!.maxLeverage)))}
                  step={1}
                  value={leverage}
                  disabled={pending}
                  className="rounded-lg border border-border bg-background p-2 text-sm"
                  onChange={(e) => setLeverage(Number(e.target.value))}
                />
                <p className="text-sm text-muted-foreground">
                  Изменение отменяет ожидающие входы. Плечо открытых позиций сохраняется.
                </p>
                <Button
                  disabled={
                    pending ||
                    !Number.isSafeInteger(leverage) ||
                    leverage < 1 ||
                    leverage > Math.floor(Math.min(...limits.map((l) => l.tiers[0]!.maxLeverage)))
                  }
                  onClick={() => void command("set_leverage")}
                >
                  Сохранить плечо
                </Button>
              </>
            )}
          </section>
          {mayStart && (
            <>
              <section
                className="space-y-3 rounded-xl border border-border p-3"
                aria-label="Сканер фьючерсного рынка"
              >
                <div>
                  <p className="font-medium">Рынок · OKX USDT-SWAP</p>
                  <p className="text-xs text-muted-foreground">
                    Публичные котировки всех доступных бессрочных контрактов. Отбор по ликвидности и
                    спреду, не по прогнозируемой прибыли. Объём в USDT оценён по среднему bid/ask;
                    это не точный биржевой оборот.
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="text-sm" htmlFor="futures-min-volume">
                    Минимальный объём · млн USDT/24 ч
                    <input
                      id="futures-min-volume"
                      type="number"
                      min={0.1}
                      max={1000}
                      step={0.1}
                      value={minTurnoverMillions}
                      disabled={scanning || pending || !!review}
                      className="mt-1 w-full rounded-lg border border-border bg-background p-2"
                      onChange={(e) => setMinTurnoverMillions(Number(e.target.value))}
                    />
                  </label>
                  <label className="text-sm" htmlFor="futures-max-spread">
                    Максимальный спред · б.п.
                    <input
                      id="futures-max-spread"
                      type="number"
                      min={1}
                      max={200}
                      step={1}
                      value={maxSpreadBps}
                      disabled={scanning || pending || !!review}
                      className="mt-1 w-full rounded-lg border border-border bg-background p-2"
                      onChange={(e) => setMaxSpreadBps(Number(e.target.value))}
                    />
                  </label>
                </div>
                <Button
                  variant="outline"
                  disabled={scanning || pending || !!review}
                  onClick={() => void scanPerpetualMarkets()}
                >
                  {scanning ? "Обновление рынка..." : "Сканировать фьючерсы OKX"}
                </Button>
                {marketScan && (
                  <>
                    <p className="text-xs text-muted-foreground" role="status">
                      {dateTime(marketScan.fetchedAt)} · прошли фильтр:{" "}
                      {marketScan.candidates.length} · исключены: {marketScan.excluded.length}.
                      {!scanFresh && " Данные устарели — выполните новое сканирование."}
                    </p>
                    <Button
                      variant="outline"
                      disabled={
                        !scanFresh || pending || !!review || marketScan.candidates.length === 0
                      }
                      onClick={() =>
                        applyScannedSymbols(
                          marketScan.candidates.slice(0, 8).map((item) => item.market.symbol),
                        )
                      }
                    >
                      Выбрать топ-8 по ликвидности
                    </Button>
                    <label className="block text-sm" htmlFor="futures-market-search">
                      Поиск среди прошедших фильтр
                    </label>
                    <input
                      id="futures-market-search"
                      type="search"
                      className="w-full rounded-lg border border-border bg-background p-2 text-sm"
                      placeholder="Например: XRP, LINK, DOGE"
                      value={marketQuery}
                      onChange={(e) => setMarketQuery(e.target.value)}
                    />
                    <section
                      className="max-h-72 space-y-1 overflow-y-auto"
                      aria-label="Подходящие бессрочные фьючерсы"
                    >
                      {visibleCandidates.map(({ market, ticker, spreadBps }) => (
                        <div
                          key={market.symbol}
                          className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2 text-sm"
                        >
                          <div>
                            <p className="font-medium">{market.symbol}</p>
                            <p className="text-xs text-muted-foreground">
                              ≈
                              {(Number(ticker.quoteVolume24h) / 1_000_000).toLocaleString("ru-RU", {
                                maximumFractionDigits: 1,
                              })}{" "}
                              млн USDT/сутки · спред {spreadBps.toFixed(1)} б.п.
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            disabled={!scanFresh || pending || !!review}
                            onClick={() => toggleScannedSymbol(market.symbol)}
                          >
                            {selectedSymbols.includes(market.symbol) ? "Убрать" : "Добавить"}
                          </Button>
                        </div>
                      ))}
                      {visibleCandidates.length === 0 && (
                        <p className="text-sm text-muted-foreground">
                          Нет совпадений по текущему фильтру.
                        </p>
                      )}
                    </section>
                    {marketScan.candidates.length > visibleCandidates.length && (
                      <p className="text-xs text-muted-foreground">
                        Показаны первые 40 совпадений; поиск работает по всему списку.
                      </p>
                    )}
                  </>
                )}
              </section>
              <label className="block text-sm" htmlFor="futures-pairs">
                Пары для PAPER-сессии · выбрано {selectedSymbols.length} из 8
              </label>
              <input
                id="futures-pairs"
                className="w-full rounded-lg border border-border bg-background p-2 text-sm"
                value={symbols}
                maxLength={256}
                disabled={pending || !!review}
                onChange={(e) => setSymbols(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Список можно уточнить вручную. Сканер ничего не покупает и не запускает. Для входов
                по-прежнему требуется отдельное подтверждение PAPER-сессии.
              </p>
              <label className="block text-sm" htmlFor="futures-duration">
                Длительность новых входов
              </label>
              <select
                id="futures-duration"
                className="rounded-lg border border-border bg-background p-2 text-sm"
                value={duration}
                disabled={pending || !!review}
                onChange={(e) => setDuration(Number(e.target.value))}
              >
                <option value={15}>15 минут</option>
                <option value={60}>1 час</option>
                <option value={240}>4 часа</option>
                <option value={1440}>1 день</option>
                <option value={20160}>14 дней</option>
              </select>
              {!review ? (
                <div>
                  <Button disabled={pending} onClick={() => void prepare()}>
                    Проверить запуск фьючерсов
                  </Button>
                </div>
              ) : (
                <section
                  className="space-y-3 rounded-xl border border-border p-4"
                  aria-label="Проверка запуска фьючерсов"
                >
                  <p className="font-medium">Запуск выбранного виртуального счёта</p>
                  <p className="text-sm">
                    {review.instruments.join(", ")} ·{" "}
                    {review.duration === 20160 ? "14 дней" : review.duration + " минут"}. Источник:{" "}
                    {review.preparation.name}.
                  </p>
                  <p className="text-sm">
                    ИИ использует модель, выбранную в общих настройках «Модели», предлагает Long /
                    Short и управляет выходами. Каждый вход проходит лимиты этого счёта. Проверка
                    позиций — раз в минуту, анализ — раз в 5 минут.
                  </p>
                  <p className="text-sm">
                    После остановки входов защитные выходы разрешены ещё 24 часа. Окончание срока не
                    закрывает позиции автоматически. Перезапуск приложения ставит новые входы на
                    паузу.
                  </p>
                  <p className="text-sm">
                    {feeSummary(status, review.instruments)} Исполнение по публичным bid/ask без
                    дополнительного проскальзывания. Funding рассчитан по фактической опубликованной
                    ставке и последней наблюдаемой Mark-цене; это виртуальная оценка.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={pending} onClick={() => void command("start")}>
                      Запустить PAPER-фьючерсы
                    </Button>
                    <Button variant="outline" disabled={pending} onClick={() => setReview(null)}>
                      Отмена
                    </Button>
                  </div>
                </section>
              )}
            </>
          )}
          <div className="flex flex-wrap gap-2">
            {verified.sessionStatus === "active" && (
              <Button variant="outline" disabled={pending} onClick={() => void command("pause")}>
                Пауза новых фьючерсных входов
              </Button>
            )}
            {verified.sessionStatus === "active" && (
              <Button variant="outline" disabled={pending} onClick={() => void command("end")}>
                Завершить фьючерсные входы
              </Button>
            )}
            {openPositions > 0 && (
              <>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => void command("protect")}
                >
                  Продлить защиту на 24 часа
                </Button>
                <Button
                  variant="outline"
                  disabled={pending || closeReview}
                  onClick={() => setCloseReview(true)}
                >
                  Закрыть все виртуальные позиции
                </Button>
              </>
            )}
          </div>
          {closeReview && (
            <section
              className="space-y-3 rounded-xl border border-border p-4"
              aria-label="Проверка закрытия фьючерсов"
            >
              <p className="text-sm">
                Остановить новые входы и закрыть {openPositions} виртуальных позиций по свежему
                публичному стакану с комиссией? При недостаточном объёме остаток будет повторно
                проверяться до 15 минут.
              </p>
              <div className="flex gap-2">
                <Button disabled={pending} onClick={() => void command("close_all")}>
                  Подтвердить виртуальное закрытие
                </Button>
                <Button variant="outline" disabled={pending} onClick={() => setCloseReview(false)}>
                  Отмена
                </Button>
              </div>
            </section>
          )}
          {verified.pendingClose && (
            <p role="status" className="text-sm">
              Ожидается исполнение виртуального закрытия. Проверяйте остаток позиций.
            </p>
          )}
          {verified.sessionStatus !== "active" && openPositions > 0 && (
            <p className="text-sm text-muted-foreground">
              Перед новым запуском закройте позиции предыдущей сессии. Защита продолжает работать до
              указанного срока.
            </p>
          )}
        </>
      )}
      {status?.status === "verified" && !status.managed && (
        <p className="text-sm text-muted-foreground">
          Счёт из прежнего журнала. Создайте три профиля для управления ИИ-сессиями.
        </p>
      )}
      {status?.status === "integrity_blocked" && (
        <p role="alert" className="text-sm text-destructive">
          {errors.integrity_blocked}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
