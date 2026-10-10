import type {
  TradingPaperJournalListOutput,
  TradingPaperJournalReadOutput,
  TradingPaperLedgerEvent,
} from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { rpc } from "../lib/rpc";
import { PaperTradingControls } from "./PaperTradingControls";

const dateTime = (iso: string) => new Date(iso).toLocaleString("ru-RU");
const kinds: Record<TradingPaperLedgerEvent["kind"], string> = {
  reserve: "Резерв",
  release: "Отмена резерва",
  fill_buy: "Покупка",
  fill_sell: "Продажа",
};

function downloadDesktopShortcut() {
  // No fixed port, hostname or user credentials: pin the current Rakazo origin.
  const target = new URL("/app/paper-journal", window.location.origin).href;
  const text = `[InternetShortcut]\r\nURL=${target}\r\n`;
  const url = URL.createObjectURL(new Blob([text], { type: "application/internet-shortcut" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "Rakazo-PAPER-Journal.url";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function eventId(event: TradingPaperLedgerEvent) {
  if (event.kind === "fill_sell") return event.positionId;
  return event.reservationId;
}

export function PaperJournalPage() {
  const selectedLedger = useRef<string | null>(null);
  const journalEpoch = useRef(0);
  const [refreshId, setRefreshId] = useState(0);
  const [list, setList] = useState<TradingPaperJournalListOutput | null>(null);
  const [ledgerId, setLedgerId] = useState<string | null>(null);
  selectedLedger.current = ledgerId;
  const [journal, setJournal] = useState<TradingPaperJournalReadOutput | null>(null);
  const [events, setEvents] = useState<TradingPaperLedgerEvent[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [morePending, setMorePending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void rpc.trading
      .journalList({})
      .then((result) => {
        if (!active) return;
        setList(result);
        setLedgerId((current) =>
          current && result.ledgers.some((entry) => entry.ledgerId === current)
            ? current
            : (result.ledgers[0]?.ledgerId ?? null),
        );
      })
      .catch(() => {
        if (active)
          setError("Не удалось получить список журналов. Проверьте подключение к Rakazo.");
      });
    return () => {
      active = false;
    };
  }, [refreshId]);

  useEffect(() => {
    if (!ledgerId) {
      setJournal(null);
      setEvents([]);
      setCursor(null);
      return;
    }
    let active = true;
    journalEpoch.current += 1;
    let initialPage = true;
    setPending(true);
    setError(null);
    setJournal(null);
    setEvents([]);
    setCursor(null);
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const result = await rpc.trading.journalRead({ ledgerId });
        if (!active) return;
        setJournal(result);
        if (result.status === "verified") {
          setEvents((old) => [
            ...result.events,
            ...old.filter(
              (event) => !result.events.some((fresh) => fresh.eventId === event.eventId),
            ),
          ]);
          if (initialPage) {
            setCursor(result.nextBeforeSequence);
            initialPage = false;
          }
        } else {
          journalEpoch.current += 1;
          initialPage = true;
          setEvents([]);
          setCursor(null);
        }
        setError(null);
      } catch {
        if (active) {
          journalEpoch.current += 1;
          initialPage = true;
          setJournal(null);
          setEvents([]);
          setCursor(null);
          setError("Не удалось проверить журнал. Повторите попытку.");
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

  async function loadMore() {
    if (!ledgerId || cursor === null || morePending) return;
    const requestedLedger = ledgerId;
    const requestedEpoch = journalEpoch.current;
    setMorePending(true);
    try {
      const page = await rpc.trading.journalRead({ ledgerId, beforeSequence: cursor });
      if (selectedLedger.current !== requestedLedger || requestedEpoch !== journalEpoch.current)
        return;
      if (page.status !== "verified") {
        // Never retain previously shown money after an integrity failure.
        journalEpoch.current += 1;
        setJournal(page);
        setEvents([]);
        setCursor(null);
        return;
      }
      setEvents((old) => [
        ...old,
        ...page.events.filter(
          (event) => !old.some((existing) => existing.eventId === event.eventId),
        ),
      ]);
      setCursor(page.nextBeforeSequence);
    } catch {
      setError("Не удалось загрузить более ранние записи.");
    } finally {
      setMorePending(false);
    }
  }

  const verified = journal?.status === "verified" ? journal : null;

  return (
    <main className="min-h-screen overflow-auto bg-background px-4 py-8 text-foreground sm:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <Link to="/app" className="text-sm text-muted-foreground underline">
              ← Rakazo
            </Link>
            <h1 className="mt-2 text-2xl font-semibold">Журнал PAPER-сделок</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Виртуальные средства · торговые сессии по вашему запуску
            </p>
          </div>
          <button
            type="button"
            onClick={downloadDesktopShortcut}
            className="rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            Скачать ярлык для рабочего стола
          </button>
        </header>

        <PaperTradingControls
          key={ledgerId ?? "create"}
          ledgerId={ledgerId}
          onCreated={(id) => {
            setLedgerId(id);
            setRefreshId((n) => n + 1);
          }}
          onChanged={() => setRefreshId((n) => n + 1)}
        />
        <section className="rounded-2xl border border-border bg-card p-5">
          <label htmlFor="paper-ledger" className="mb-2 block text-sm font-medium">
            Выберите журнал
          </label>
          <select
            id="paper-ledger"
            className="w-full max-w-xl rounded-lg border border-border bg-background p-2"
            value={ledgerId ?? ""}
            onChange={(event) => setLedgerId(event.target.value || null)}
            disabled={!list || list.ledgers.length === 0}
          >
            {!list && <option value="">Загрузка…</option>}
            {list?.ledgers.length === 0 && <option value="">Журнал ещё не создан</option>}
            {list?.ledgers.map((entry) => (
              <option key={entry.ledgerId} value={entry.ledgerId}>
                {entry.ledgerId} · {entry.quoteCurrency} · {entry.eventsCount} событий
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-muted-foreground">
            Ярлык откроет этот экран в вашем браузере и попросит войти в Rakazo при необходимости.
            Скачанный файл .url нужно переместить на рабочий стол.
          </p>
        </section>

        {error && (
          <p role="alert" className="rounded-xl border border-destructive/50 p-4 text-sm">
            {error}
          </p>
        )}
        {pending && <p className="text-muted-foreground">Проверка журнала…</p>}
        {journal?.status === "integrity_blocked" && (
          <p role="alert" className="rounded-xl border border-destructive p-5">
            Проверка целостности журнала не пройдена. Баланс, позиции и история скрыты. Никаких
            исправлений или сделок не выполнялось.
          </p>
        )}
        {verified && (
          <>
            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                ["Доступно", verified.state.availableQuote],
                ["Зарезервировано", verified.state.reservedQuote],
                ["Реализованный PnL", verified.state.realizedPnlQuote],
                ["Уплачено комиссий", verified.state.totalFeesQuote],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-border bg-card p-4">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-2 break-all text-xl font-semibold tabular-nums">
                    {value} {verified.state.quoteCurrency}
                  </p>
                </div>
              ))}
            </section>
            <p className="text-xs text-muted-foreground">
              Открытых позиций: {verified.state.positions.length}. Событий:{" "}
              {verified.state.acceptedEvents}. Баланс по учётной стоимости, без переоценки открытых
              позиций по рынку. Последнее обновление: {dateTime(verified.updatedAt)}.
            </p>
            <section className="rounded-2xl border border-border bg-card p-5">
              <h2 className="mb-4 text-lg font-semibold">Открытые позиции</h2>
              {verified.state.positions.length === 0 ? (
                <p className="text-sm text-muted-foreground">Открытых позиций нет.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="p-2">Инструмент</th>
                        <th className="p-2">Количество</th>
                        <th className="p-2">Стоимость входа</th>
                        <th className="p-2">ID позиции</th>
                      </tr>
                    </thead>
                    <tbody>
                      {verified.state.positions.map((position) => (
                        <tr key={position.positionId} className="border-b border-border/60">
                          <td className="p-2">{position.symbol}</td>
                          <td className="p-2 tabular-nums">{position.quantityBase}</td>
                          <td className="p-2 tabular-nums">
                            {position.entryCostBasisQuote} {verified.state.quoteCurrency}
                          </td>
                          <td className="p-2 font-mono text-xs">{position.positionId}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="rounded-2xl border border-border bg-card p-5">
              <h2 className="mb-4 text-lg font-semibold">История операций</h2>
              {events.length === 0 ? (
                <p className="text-sm text-muted-foreground">Операций нет.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="p-2">Дата</th>
                        <th className="p-2">Операция</th>
                        <th className="p-2">Инструмент / ID</th>
                        <th className="p-2">Количество</th>
                        <th className="p-2">Цена</th>
                        <th className="p-2">Комиссия</th>
                      </tr>
                    </thead>
                    <tbody>
                      {events.map((event) => (
                        <tr key={event.eventId} className="border-b border-border/60">
                          <td className="whitespace-nowrap p-2">{dateTime(event.recordedAt)}</td>
                          <td className="p-2">{kinds[event.kind]}</td>
                          <td className="p-2">
                            {event.kind === "reserve" ? event.market.symbol : eventId(event)}
                          </td>
                          <td className="p-2 tabular-nums">
                            {event.kind !== "release" ? event.quantityBase : "—"}
                          </td>
                          <td className="p-2 tabular-nums">
                            {event.kind === "fill_buy" || event.kind === "fill_sell"
                              ? event.executedPriceQuote
                              : "—"}
                          </td>
                          <td className="p-2 tabular-nums">
                            {event.kind === "fill_buy" || event.kind === "fill_sell"
                              ? event.feeQuote
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
                  onClick={() => void loadMore()}
                  disabled={morePending}
                  className="mt-4 rounded-xl border border-border px-4 py-2 text-sm hover:bg-muted"
                >
                  {morePending ? "Загрузка…" : "Показать более ранние записи"}
                </button>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
