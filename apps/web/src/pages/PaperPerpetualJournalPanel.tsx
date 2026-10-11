import type {
  TradingPaperPerpetualJournalListOutput,
  TradingPaperPerpetualJournalReadOutput,
} from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";

type VerifiedJournal = Extract<TradingPaperPerpetualJournalReadOutput, { status: "verified" }>;
type PerpetualEvent = VerifiedJournal["events"][number];
const dateTime = (iso: string) => new Date(iso).toLocaleString("ru-RU");
const strategyName: Record<string, string> = {
  conservative: "Консервативная",
  moderate: "Умеренная",
  aggressive: "Агрессивная",
};
const kindName: Record<PerpetualEvent["kind"], string> = {
  open: "Открытие",
  mark: "Переоценка",
  funding: "Funding",
  close: "Закрытие",
  liquidate: "Ликвидация",
};

/**
 * Read-only FUTURES tab inside the existing PAPER Journal page.
 * Separate margin accounting, SAME dashboard/URL/desktop shortcut.
 * Never offers Start, credentials, external orders or synthetic demo balances.
 */
export function PaperPerpetualJournalPanel() {
  const [accounts, setAccounts] = useState<TradingPaperPerpetualJournalListOutput | null>(null);
  const [ledgerId, setLedgerId] = useState<string | null>(null);
  const [journal, setJournal] = useState<TradingPaperPerpetualJournalReadOutput | null>(null);
  const [events, setEvents] = useState<PerpetualEvent[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [olderPending, setOlderPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedLedger = useRef<string | null>(null);
  const journalEpoch = useRef(0);
  selectedLedger.current = ledgerId;

  useEffect(() => {
    let active = true;
    void rpc.trading
      .perpetualJournalList({})
      .then((result) => {
        if (!active) return;
        setAccounts(result);
        setLedgerId((current) =>
          current && result.ledgers.some((entry) => entry.ledgerId === current)
            ? current
            : (result.ledgers[0]?.ledgerId ?? null),
        );
      })
      .catch(() => {
        if (active)
          setError("Не удалось получить фьючерсные счета. Проверьте версию Rakazo и подключение.");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    journalEpoch.current += 1;
    setJournal(null);
    setEvents([]);
    setCursor(null);
    if (!ledgerId) return;
    let active = true;
    let fetching = false;
    let firstPage = true;
    setPending(true);
    setError(null);
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const result = await rpc.trading.perpetualJournalRead({ ledgerId });
        if (!active) return;
        setJournal(result);
        if (result.status === "verified") {
          setEvents((previous) => [
            ...result.events,
            ...previous.filter(
              (event) => !result.events.some((fresh) => fresh.eventId === event.eventId),
            ),
          ]);
          if (firstPage) {
            setCursor(result.nextBeforeSequence);
            firstPage = false;
          }
        } else {
          journalEpoch.current += 1;
          setEvents([]);
          setCursor(null);
          firstPage = true;
        }
        setError(null);
      } catch {
        if (active) {
          journalEpoch.current += 1;
          firstPage = true;
          setJournal(null);
          setEvents([]);
          setCursor(null);
          setError("Не удалось проверить фьючерсный журнал. Финансовые данные скрыты.");
        }
      } finally {
        fetching = false;
        if (active) setPending(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [ledgerId]);

  async function loadOlder() {
    if (!ledgerId || cursor === null || olderPending) return;
    const requested = ledgerId;
    const epoch = journalEpoch.current;
    setOlderPending(true);
    try {
      const result = await rpc.trading.perpetualJournalRead({
        ledgerId,
        beforeSequence: cursor,
      });
      if (selectedLedger.current !== requested || journalEpoch.current !== epoch) return;
      if (result.status === "integrity_blocked") {
        journalEpoch.current += 1;
        setJournal(result);
        setEvents([]);
        setCursor(null);
        return;
      }
      setEvents((old) => [
        ...old,
        ...result.events.filter(
          (event) => !old.some((existing) => existing.eventId === event.eventId),
        ),
      ]);
      setCursor(result.nextBeforeSequence);
    } catch {
      if (selectedLedger.current === requested && journalEpoch.current === epoch) {
        setError("Не удалось проверить предыдущую страницу фьючерсного журнала.");
      }
    } finally {
      setOlderPending(false);
    }
  }

  const verified = journal?.status === "verified" ? journal : null;
  return (
    <div
      className="space-y-5"
      id="paper-journal-futures-panel"
      role="tabpanel"
      aria-labelledby="paper-journal-futures-tab"
    >
      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="text-lg font-semibold">Фьючерсы · PAPER</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Long / Short · плечо и изолированная маржа · без реальных средств. Эта вкладка показывает
          только проверенные виртуальные записи. Запуск ИИ-стратегий и создание счетов подключаются
          отдельно после проверки.
        </p>
        <label htmlFor="paper-perpetual-ledger" className="mb-2 mt-4 block text-sm font-medium">
          Стратегия и виртуальный счёт
        </label>
        <select
          id="paper-perpetual-ledger"
          className="w-full max-w-xl rounded-lg border border-border bg-background p-2"
          value={ledgerId ?? ""}
          onChange={(event) => setLedgerId(event.target.value || null)}
          disabled={!accounts || accounts.ledgers.length === 0}
        >
          {!accounts && <option value="">Загрузка…</option>}
          {accounts?.ledgers.length === 0 && (
            <option value="">Проверенных фьючерсных счетов пока нет</option>
          )}
          {accounts?.ledgers.map((entry) => (
            <option key={entry.ledgerId} value={entry.ledgerId}>
              {strategyName[entry.strategy]} · {entry.ledgerId} · {entry.eventsCount} событий
            </option>
          ))}
        </select>
      </section>
      {error && (
        <p role="alert" className="rounded-xl border border-destructive/50 p-4 text-sm">
          {error}
        </p>
      )}
      {pending && <p className="text-sm text-muted-foreground">Проверка фьючерсного журнала…</p>}
      {journal?.status === "integrity_blocked" && (
        <p role="alert" className="rounded-xl border border-destructive p-5">
          Целостность журнала не подтверждена: данные о средствах и позициях скрыты.
        </p>
      )}
      {verified && (
        <>
          <section
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
            aria-label="Фьючерсные показатели"
          >
            {[
              ["Начальный капитал", verified.state.initialBalanceQuote],
              ["Доступно", verified.state.availableQuote],
              ["Изолированная маржа", verified.state.lockedMarginQuote],
              ["Стоимость счёта по рынку", verified.state.markedEquityQuote],
              ["Реализованный PnL", verified.state.realizedPnlQuote],
              ["Нереализованный PnL", verified.state.unrealizedPnlQuote],
              ["Funding (нетто)", verified.state.fundingNetQuote],
              ["Комиссии", verified.state.totalFeesQuote],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-2 break-all text-xl font-semibold tabular-nums">{value} USDT</p>
              </div>
            ))}
          </section>
          <p className="text-xs text-muted-foreground">
            {strategyName[verified.state.strategy]} · Позиции: {verified.state.openPositions.length}{" · "}
              Закрыто: {verified.state.closedPositions} · Ликвидации: {verified.state.liquidations}{" · "}
              Обновлено: {dateTime(verified.updatedAt)}. Переоценка зависит от последних записанных
            котировок, не является непрерывным биржевым балансом.
          </p>
          <section className="rounded-2xl border border-border bg-card p-5">
            <h2 className="mb-4 text-lg font-semibold">Открытые фьючерсные позиции</h2>
            {verified.state.openPositions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Открытых позиций нет.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="p-2">Пара</th>
                      <th className="p-2">Сторона</th>
                      <th className="p-2">Плечо</th>
                      <th className="p-2">Объём</th>
                      <th className="p-2">Вход / Mark</th>
                      <th className="p-2">Маржа</th>
                      <th className="p-2">PnL</th>
                      <th className="p-2">Риск ликвидации</th>
                    </tr>
                  </thead>
                  <tbody>
                    {verified.state.openPositions.map((position) => (
                      <tr key={position.positionId} className="border-b border-border/60">
                        <td className="p-2">
                          {position.venue.toUpperCase()} · {position.instrument}
                        </td>
                        <td className="p-2">{position.side === "long" ? "Long" : "Short"}</td>
                        <td className="p-2">{position.leverage}×</td>
                        <td className="p-2 tabular-nums">{position.quantityBase}</td>
                        <td className="p-2 tabular-nums">
                          {position.entryPriceQuote} / {position.markPriceQuote}
                        </td>
                        <td className="p-2 tabular-nums">{position.isolatedMarginQuote}</td>
                        <td className="p-2 tabular-nums">{position.unrealizedPnlQuote}</td>
                        <td className="p-2">
                          {position.liquidationRequired
                            ? "Требуется защитное действие"
                            : "Нет сигнала по текущей записи"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="rounded-2xl border border-border bg-card p-5">
            <h2 className="mb-4 text-lg font-semibold">История фьючерсных операций</h2>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">Операций пока нет.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="p-2">Дата</th>
                      <th className="p-2">Операция</th>
                      <th className="p-2">Позиция / инструмент</th>
                      <th className="p-2">Направление</th>
                      <th className="p-2">Цена / Funding</th>
                      <th className="p-2">Комиссия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event) => (
                      <tr key={event.eventId} className="border-b border-border/60">
                        <td className="whitespace-nowrap p-2">{dateTime(event.recordedAt)}</td>
                        <td className="p-2">{kindName[event.kind]}</td>
                        <td className="p-2">{event.kind === "open" ? event.instrument : event.positionId}</td>
                        <td className="p-2">{event.kind === "open" ? event.side : "—"}</td>
                        <td className="p-2 tabular-nums">
                          {event.kind === "open"
                            ? event.entryPriceQuote
                            : event.kind === "mark"
                              ? event.markPriceQuote
                              : event.kind === "funding"
                                ? event.paymentQuoteSigned
                                : event.exitPriceQuote}
                        </td>
                        <td className="p-2 tabular-nums">
                          {event.kind === "open"
                            ? event.entryFeeQuote
                            : event.kind === "close" || event.kind === "liquidate"
                              ? event.exitFeeQuote
                              : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {cursor !== null && (
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={olderPending}
                className="mt-4 rounded-xl border border-border px-4 py-2 text-sm hover:bg-muted"
              >
                {olderPending ? "Загрузка…" : "Показать более ранние записи"}
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
