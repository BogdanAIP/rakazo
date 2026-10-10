import type { TradingPaperWorkspaceCommand, TradingPaperWorkspaceStatus } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

const phases: Record<string, string> = {
  idle: "Готов к запуску",
  active: "Торговая сессия",
  settling: "Освобождение резервов",
  protection_only: "Защита открытых позиций",
  finished: "Сессия завершена",
  attention_required: "Нужно ваше действие",
};
export function PaperTradingControls({
  ledgerId,
  onCreated,
  onChanged,
}: {
  ledgerId: string | null;
  onCreated: (id: string) => void;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<TradingPaperWorkspaceStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("Учебный счёт");
  const [balance, setBalance] = useState("10000");
  const [idea, setIdea] = useState("100");
  const [daily, setDaily] = useState("500");
  const [openRisk, setOpenRisk] = useState("200");
  const [exposure, setExposure] = useState("2000");
  const [venue, setVenue] = useState<"okx" | "bingx">("okx");
  const [symbol, setSymbol] = useState("BTC-USDT");
  const [duration, setDuration] = useState(60);
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => {
    let active = true;
    let refreshing = false;
    setStatus(null);
    setError(null);
    setReviewing(false);
    if (!ledgerId) return;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const result = await rpc.trading.workspaceRead({ ledgerId });
        if (active) {
          setStatus(result);
          setError(null);
        }
      } catch {
        if (active) {
          setStatus(null);
          setError("Не удалось проверить состояние счёта. Проверьте подключение.");
        }
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [ledgerId]);
  const verified = status?.status === "verified" ? status : null;
  async function create() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const account = await rpc.trading.accountCreate({
        name,
        initialBalanceQuote: balance,
        maxPerIdeaRiskQuote: idea,
        maxDailyLossQuote: daily,
        maxOpenRiskQuote: openRisk,
        maxTotalExposureQuote: exposure,
      });
      setCreating(false);
      onCreated(account.ledgerId);
    } catch {
      setError("Не удалось создать счёт. Проверьте суммы и подключение.");
    } finally {
      setPending(false);
    }
  }
  async function command(action: TradingPaperWorkspaceCommand["action"]) {
    if (!verified || pending) return;
    setPending(true);
    setError(null);
    const base = {
      ledgerId: verified.ledgerId,
      commandId: crypto.randomUUID(),
      expectedRevision: verified.sessionRevision,
    };
    const input: TradingPaperWorkspaceCommand =
      action === "start"
        ? { ...base, action, venue, symbol, durationMinutes: duration }
        : action === "protect"
          ? {
              ...base,
              action,
              expectedProtectionRevision: verified.protectionRevision,
              durationMinutes: 1440,
            }
          : { ...base, action };
    try {
      const result = await rpc.trading.workspaceCommand(input);
      if (result.ledgerId === ledgerId) setStatus(result);
      setReviewing(false);
      onChanged();
    } catch {
      setError("Действие не выполнено. Обновите состояние счёта и повторите.");
    } finally {
      setPending(false);
    }
  }
  return (
    <section
      className="space-y-4 rounded-2xl border border-border bg-card p-5"
      aria-label="Управление виртуальной торговлей"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Виртуальные счета</h2>
        <Button variant="outline" onClick={() => setCreating((v) => !v)} disabled={pending}>
          Создать счёт
        </Button>
      </div>
      {creating && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
          className="grid gap-3 sm:grid-cols-2"
        >
          {[
            ["Название", name, setName],
            ["Начальный баланс, USDT", balance, setBalance],
            ["Риск на сделку, USDT", idea, setIdea],
            ["Предел дневного убытка, USDT", daily, setDaily],
            ["Общий открытый риск, USDT", openRisk, setOpenRisk],
            ["Максимальная экспозиция, USDT", exposure, setExposure],
          ].map(([label, value, setter], index) => (
            <label
              key={String(label)}
              htmlFor={`paper-account-${index}`}
              className="space-y-1 text-sm"
            >
              <span>{String(label)}</span>
              <Input
                id={`paper-account-${index}`}
                value={String(value)}
                onChange={(e) => (setter as (s: string) => void)(e.target.value)}
                required
              />
            </label>
          ))}
          <Button type="submit" disabled={pending}>
            Создать виртуальный счёт
          </Button>
        </form>
      )}
      {status?.status === "integrity_blocked" && (
        <p role="alert" className="text-destructive">
          Проверка счёта не пройдена. Торговля заблокирована.
        </p>
      )}
      {verified && (
        <>
          <div className="flex flex-wrap justify-between gap-2">
            <strong>{verified.name}</strong>
            <span role="status">{phases[verified.phase]}</span>
          </div>
          <p className="text-sm text-muted-foreground">
            Открытых позиций: {verified.openPositions} · Резервов: {verified.openReservations}
            {verified.expiresAt && verified.sessionStatus === "active" && (
              <> · Новые входы до {new Date(verified.expiresAt).toLocaleTimeString("ru-RU")}</>
            )}
          </p>
          {verified.phase === "attention_required" && (
            <p role="alert" className="text-sm text-destructive">
              {verified.protectionStatus === "expired"
                ? "Срок защиты истёк. Продлите наблюдение за открытыми позициями."
                : "Новые входы остановлены. Для открытых позиций включите защиту отдельно."}
            </p>
          )}
          {verified.phase === "protection_only" && (
            <p className="text-sm text-muted-foreground">
              Защита до{" "}
              {verified.protectionExpiresAt &&
                new Date(verified.protectionExpiresAt).toLocaleString("ru-RU")}
              . Новые покупки отключены.
            </p>
          )}
          {verified.sessionStatus !== "active" &&
            verified.openPositions === 0 &&
            verified.openReservations === 0 && (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="space-y-1 text-sm">
                    <span>Источник котировок</span>
                    <select
                      className="w-full rounded-md border border-border bg-background p-2"
                      value={venue}
                      onChange={(e) => setVenue(e.target.value as "okx" | "bingx")}
                    >
                      <option value="okx">OKX</option>
                      <option value="bingx">BingX</option>
                    </select>
                  </label>
                  <label htmlFor="paper-symbol" className="space-y-1 text-sm">
                    <span>Инструмент</span>
                    <Input
                      id="paper-symbol"
                      value={symbol}
                      onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                    />
                  </label>
                  <label htmlFor="paper-duration" className="space-y-1 text-sm">
                    <span>Длительность, минут</span>
                    <Input
                      id="paper-duration"
                      type="number"
                      min={15}
                      max={240}
                      value={duration}
                      onChange={(e) => setDuration(Number(e.target.value))}
                    />
                  </label>
                </div>
                {!reviewing ? (
                  <Button onClick={() => setReviewing(true)} disabled={pending}>
                    Запустить сессию
                  </Button>
                ) : (
                  <div className="space-y-3 rounded-lg border border-border p-4">
                    <p className="text-sm">
                      {venue.toUpperCase()} · {symbol} · {duration} мин · пробой 20 часовых свечей.
                      Проверка каждые 5 минут.
                    </p>
                    <p className="text-sm">
                      Разрешить автоматические покупки и продажи только на виртуальном счёте. Риск
                      на сделку: {verified.policy.maxPerIdeaRiskQuote} USDT; дневной предел:{" "}
                      {verified.policy.maxDailyLossQuote} USDT.
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Пауза и истечение срока блокируют новые входы. Оставшиеся позиции требуют
                      отдельного включения защиты. После перезапуска сессия ставится на паузу.
                    </p>
                    <div className="flex gap-2">
                      <Button disabled={pending} onClick={() => void command("start")}>
                        Подтвердить запуск PAPER
                      </Button>
                      <Button variant="outline" onClick={() => setReviewing(false)}>
                        Отмена
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          <div className="flex flex-wrap gap-2">
            {verified.sessionStatus === "active" && (
              <Button variant="outline" disabled={pending} onClick={() => void command("pause")}>
                Пауза новых входов
              </Button>
            )}
            {verified.sessionStatus !== "absent" &&
              verified.sessionStatus !== "ended" &&
              verified.phase !== "finished" && (
                <Button variant="outline" disabled={pending} onClick={() => void command("end")}>
                  Завершить входы
                </Button>
              )}
            {verified.sessionStatus !== "active" &&
              verified.openPositions > 0 &&
              verified.protectionStatus !== "active" && (
                <Button disabled={pending} onClick={() => void command("protect")}>
                  Включить защиту на 24 часа
                </Button>
              )}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
