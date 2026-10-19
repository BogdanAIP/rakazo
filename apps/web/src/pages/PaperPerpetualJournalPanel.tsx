import type {
  PaperPerpetualWorkspaceStatus,
  TradingPaperPerpetualJournalListOutput,
  TradingPaperPerpetualJournalReadOutput,
} from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { PaperPerpetualComparison } from "./PaperPerpetualComparison";
import { PaperPerpetualControls } from "./PaperPerpetualControls";
import { PaperPerpetualDashboard } from "./PaperPerpetualDashboard";
import { PaperPerpetualResearchHistory } from "./PaperPerpetualResearchHistory";

type VerifiedJournal = Extract<TradingPaperPerpetualJournalReadOutput, { status: "verified" }>;
type PerpetualEvent = VerifiedJournal["events"][number];
const dateTime = (iso: string) => new Date(iso).toLocaleString("ru-RU");
const strategyName: Record<string, string> = {
  conservative: "Консервативная",
  moderate: "Умеренная",
  aggressive: "Агрессивная",
};
const kindName: Record<PerpetualEvent["kind"], string> = {
  engine: "Движок",
  open: "Открытие",
  mark: "Переоценка",
  funding: "Funding",
  close: "Закрытие",
  liquidate: "Ликвидация",
};

type NativeJournalEvent = Extract<PerpetualEvent, { kind: "engine" }>;
function nativeJournalLabels(event: NativeJournalEvent) {
  const orders = new Map(
    event.input.commands.flatMap((c) => (c.kind === "order" ? [[c.orderId, c] as const] : [])),
  );
  const operations = new Set<string>(),
    instruments = new Set<string>(),
    directions = new Set<string>();
  const details: string[] = [],
    fees: string[] = [];
  for (const e of event.output.events) {
    const order = orders.get(e.orderId ?? "");
    const position = event.output.positions.find((p) => p.positionId === e.positionId);
    if (order) {
      instruments.add(order.instrument);
      directions.add((order.action === "buy") !== order.reduceOnly ? "Long" : "Short");
    } else if (position) instruments.add(position.instrument);
    if (e.kind === "fill") {
      operations.add(order ? (order.reduceOnly ? kindName.close : kindName.open) : "Исполнение");
      details.push([e.quantityBase, e.priceQuote].join(" @ "));
      if (e.commission) fees.push(e.commission);
    } else if (e.kind === "funding") {
      operations.add(kindName.funding);
      details.push(e.paymentQuoteSigned ?? "—");
    } else {
      const label = e.kind === "canceled" ? "Отмена" : "Отказ";
      operations.add(label);
      details.push(label);
    }
  }
  if (!instruments.size) for (const quote of event.input.quotes) instruments.add(quote.instrument);
  return {
    operation: [...operations].join(", ") || kindName.mark,
    instrument: [...instruments].join(", ") || "Счёт",
    direction: [...directions].join(", ") || "—",
    details: details.join("; ") || kindName.mark,
    fees: fees.join("; ") || "—",
  };
}

/**
 * Human controls and verified FUTURES accounting in the existing PAPER Journal.
 * Separate margin accounts, same dashboard/URL/desktop shortcut.
 */
export function PaperPerpetualJournalPanel() {
  const [workspace, setWorkspace] = useState<PaperPerpetualWorkspaceStatus | null>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [refreshId, setRefreshId] = useState(0);
  const [creating, setCreating] = useState(false);
  const [strategy, setStrategy] = useState<"conservative" | "moderate" | "aggressive">(
    "conservative",
  );
  const [accounts, setAccounts] = useState<TradingPaperPerpetualJournalListOutput | null>(null);
  const [ledgerId, setLedgerId] = useState<string | null>(null);
  const [journal, setJournal] = useState<TradingPaperPerpetualJournalReadOutput | null>(null);
  const [events, setEvents] = useState<PerpetualEvent[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [olderPending, setOlderPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedLedger = useRef<string | null>(null);
  const journalScopeLedger = useRef<string | null>(null);
  const journalEpoch = useRef(0);
  selectedLedger.current = ledgerId;
  const receiveStatus = useCallback((value: PaperPerpetualWorkspaceStatus | null) => {
    if (!value || value.ledgerId === selectedLedger.current) setWorkspace(value);
  }, []);

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
  }, [refreshId]);

  useEffect(() => {
    // refreshId is an account-status refresh, not a change of account.
    // Unmounting the controls after every leverage adjustment would erase
    // the user's selected market universe before the Start review.
    if (journalScopeLedger.current !== ledgerId) {
      journalScopeLedger.current = ledgerId;
      journalEpoch.current += 1;
      setJournal(null);
      setEvents([]);
      setCursor(null);
    }
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
  }, [ledgerId, refreshId]);

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

  async function createAccounts(selected?: typeof strategy) {
    setCreating(true);
    setError(null);
    try {
      const result = await rpc.trading.perpetualExperimentsCreate(
        selected ? { strategy: selected } : {},
      );
      setLedgerId(result.accounts[0]?.ledgerId ?? null);
      setRefreshId((n) => n + 1);
    } catch {
      setError("Не удалось создать фьючерсные счета.");
    } finally {
      setCreating(false);
    }
  }
  // Never render stale financial data or controls from the previously
  // selected ledger during the first frame of a ledger switch.
  const verified = journal?.status === "verified" && journal.ledgerId === ledgerId ? journal : null;
  const visibleEvents = events.filter(
    (event) =>
      showAudit ||
      (event.kind === "engine" ? event.output.events.length > 0 : event.kind !== "mark"),
  );
  return (
    <div
      className="space-y-5"
      id="paper-journal-futures-panel"
      role="tabpanel"
      aria-labelledby="paper-journal-futures-tab"
    >
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Обзор счёта</h2>
          <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
            PAPER · виртуальная торговля
          </span>
        </div>
        <details className="mt-3 text-sm" open={accounts?.ledgers.length === 0}>
          <summary className="cursor-pointer text-muted-foreground">Создать счёт</summary>
          <p className="mt-2 text-sm text-muted-foreground">
            Виртуальный счёт — 1000 USDT. Для сравнения можно создать три независимых профиля.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label htmlFor="futures-account-strategy" className="text-sm">
              Профиль риска
            </label>
            <select
              id="futures-account-strategy"
              value={strategy}
              disabled={creating}
              className="rounded-lg border border-border bg-background p-2 text-sm"
              onChange={(event) => setStrategy(event.target.value as typeof strategy)}
            >
              <option value="conservative">Консервативная · 5×</option>
              <option value="moderate">Умеренная · 10×</option>
              <option value="aggressive">Агрессивная · 20×</option>
            </select>
            <Button disabled={creating || !accounts} onClick={() => void createAccounts(strategy)}>
              Создать виртуальный счёт
            </Button>
            <Button
              variant="outline"
              disabled={creating || !accounts}
              onClick={() => void createAccounts()}
            >
              {creating ? "Создание…" : "Создать три фьючерсных счёта"}
            </Button>
          </div>
        </details>
        <label htmlFor="paper-perpetual-ledger" className="mb-2 mt-4 block text-sm font-medium">
          Профиль и виртуальный счёт
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
              {strategyName[entry.strategy]}
            </option>
          ))}
        </select>
      </section>
      {accounts && (
        <details className="rounded-2xl border border-border bg-card p-4">
          <summary className="cursor-pointer text-sm font-medium">Сравнить профили</summary>
          <div className="mt-3">
            <PaperPerpetualComparison
              ledgerIds={accounts.ledgers.map((a) => a.ledgerId)}
              onSelect={setLedgerId}
            />
          </div>
        </details>
      )}
      {verified && ledgerId && (
        <PaperPerpetualDashboard
          journal={verified}
          workspace={workspace}
          onOpenControls={() => {
            setControlsOpen(true);
            window.requestAnimationFrame(() =>
              document
                .getElementById("paper-session-controls")
                ?.scrollIntoView({ behavior: "smooth", block: "start" }),
            );
          }}
        />
      )}
      {verified && ledgerId && (
        <details
          id="paper-session-controls"
          open={controlsOpen}
          onToggle={(event) => setControlsOpen(event.currentTarget.open)}
          className="rounded-2xl border border-border bg-card p-4"
        >
          <summary className="cursor-pointer text-sm font-medium">
            Управление сессией и плечом
          </summary>
          <div className="mt-3">
            <PaperPerpetualControls
              key={ledgerId}
              ledgerId={ledgerId}
              openPositions={verified.state.openPositions.length}
              onChanged={() => setRefreshId((n) => n + 1)}
              onStatus={receiveStatus}
            />
          </div>
        </details>
      )}
      {verified && ledgerId ? (
        <details className="rounded-2xl border border-border bg-card p-4">
          <summary className="cursor-pointer text-sm font-medium">Решения и анализ ИИ</summary>
          <div className="mt-3">
            <PaperPerpetualResearchHistory key={ledgerId} ledgerId={ledgerId} />
          </div>
        </details>
      ) : null}
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
          <section className="rounded-2xl border border-border bg-card p-5">
            <h2 className="mb-4 text-lg font-semibold">История фьючерсных операций</h2>
            <label className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={showAudit}
                onChange={(e) => setShowAudit(e.target.checked)}
              />
              Показать переоценки и технические записи
            </label>
            {visibleEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                На загруженных страницах нет исполнений. Более ранние записи доступны ниже.
              </p>
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
                    {visibleEvents.map((event) => {
                      const native = event.kind === "engine" ? nativeJournalLabels(event) : null;
                      return (
                        <tr key={event.eventId} className="border-b border-border/60">
                          <td className="whitespace-nowrap p-2">{dateTime(event.recordedAt)}</td>
                          <td className="p-2">
                            {native ? native.operation : kindName[event.kind]}
                          </td>
                          <td className="p-2">
                            {native
                              ? native.instrument
                              : event.kind === "open"
                                ? event.instrument
                                : event.positionId}
                          </td>
                          <td className="p-2">
                            {native ? native.direction : event.kind === "open" ? event.side : "—"}
                          </td>
                          <td className="p-2 tabular-nums">
                            {event.kind === "engine"
                              ? native?.details
                              : event.kind === "open"
                                ? event.entryPriceQuote
                                : event.kind === "mark"
                                  ? event.markPriceQuote
                                  : event.kind === "funding"
                                    ? event.paymentQuoteSigned
                                    : event.exitPriceQuote}
                          </td>
                          <td className="p-2 tabular-nums">
                            {native
                              ? native.fees
                              : event.kind === "open"
                                ? event.entryFeeQuote
                                : event.kind === "close" || event.kind === "liquidate"
                                  ? event.exitFeeQuote
                                  : "—"}
                          </td>
                        </tr>
                      );
                    })}
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
