import type {
  PaperPerpetualWorkspaceStatus,
  TradingPaperPerpetualJournalReadOutput,
} from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { PaperEquityChart } from "./PaperEquityChart";

type Verified = Extract<TradingPaperPerpetualJournalReadOutput, { status: "verified" }>;
const number = (value: string | number, digits = 2) =>
  new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(Number(value));
const price = (value: string) =>
  number(value, Math.max(2, Math.min(8, (value.split(".")[1] ?? "").replace(/0+$/, "").length)));
const tone = (value: string | number) =>
  Number(value) < 0 ? "text-destructive" : Number(value) > 0 ? "text-success" : "text-foreground";
function Metric({
  label,
  value,
  suffix = "USDT",
  colored = false,
}: {
  label: string;
  value: string | number;
  suffix?: string;
  colored?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-border bg-card p-5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          "mt-2 break-words text-2xl font-semibold tracking-tight tabular-nums " +
          (colored ? tone(value) : "")
        }
      >
        {number(value)} <span className="text-xs font-normal text-muted-foreground">{suffix}</span>
      </p>
    </div>
  );
}
export function PaperPerpetualDashboard({
  journal,
  workspace,
  onOpenControls,
}: {
  journal: Verified;
  workspace: PaperPerpetualWorkspaceStatus | null;
  onOpenControls: () => void;
}) {
  const { state } = journal;
  const verified =
    workspace?.status === "verified" && workspace.ledgerId === journal.ledgerId ? workspace : null;
  const net = Number(state.markedEquityQuote) - Number(state.initialBalanceQuote);
  const stale = Date.now() - Date.parse(journal.updatedAt) > 120_000;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <p
          role="status"
          className={verified?.runtimeError ? "text-warning" : "text-muted-foreground"}
        >
          {!verified
            ? "Состояние сессии не подтверждено"
            : verified.runtimeError
              ? "Сессия требует проверки · откройте управление"
              : verified.sessionStatus === "active"
                ? "Новые входы разрешены"
                : verified.phase === "protection_only"
                  ? "Только защита позиций"
                  : "Новые входы остановлены"}
        </p>
        <p className="text-muted-foreground">
          {state.engine ? "Общая маржа" : "Изолированная маржа"}
          {verified ? " · новые входы до " + verified.maxLeverage + "×" : ""}
        </p>
      </div>
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Фьючерсные показатели">
        <Metric label="Капитал по рынку" value={state.markedEquityQuote} />
        <Metric label="Результат с начала · после затрат" value={net} colored />
        <Metric label="PnL открытых позиций" value={state.unrealizedPnlQuote} colored />
        <Metric label="Свободно в симуляторе" value={state.availableQuote} />
      </section>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p className={stale ? "text-warning" : ""}>
          Запись: {new Date(journal.updatedAt).toLocaleString("ru-RU")}
          {stale ? " · котировки не обновлялись более 2 минут" : ""}
        </p>
        <p>
          {state.closedPositions} закрыто · {state.openPositions.length} открыто ·{" "}
          {state.liquidations} ликвидаций
        </p>
      </div>
      <section className="space-y-4" aria-label="Открытые фьючерсные позиции">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Позиции и план</h2>
          <Button variant="outline" size="sm" onClick={onOpenControls}>
            Плечо и управление
          </Button>
        </div>
        {state.openPositions.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            Открытых позиций нет.
          </div>
        ) : (
          state.openPositions.map((position) => {
            const plan = verified?.positionPlans?.find((p) => p.positionId === position.positionId);
            const reservation = verified?.recoveryReservations?.find(
              (p) => p.positionId === position.positionId,
            );
            const protectionActive =
              verified?.protectionExpiresAt &&
              Date.parse(verified.protectionExpiresAt) > Date.now();
            const stopDistance = plan
              ? (Number(plan.stopPriceQuote) / Number(position.markPriceQuote) - 1) * 100
              : null;
            return (
              <article
                key={position.positionId}
                className="overflow-hidden rounded-2xl border border-border bg-card"
                aria-label={position.instrument + " · план позиции"}
              >
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border p-5">
                  <div>
                    <h3 className="text-lg font-semibold">
                      {position.instrument.replace("-USDT-SWAP", " / USDT")}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      OKX ·{" "}
                      <span
                        className={position.side === "long" ? "text-success" : "text-destructive"}
                      >
                        {position.side === "long" ? "Long" : "Short"}
                      </span>{" "}
                      · {position.leverage}× · {number(position.quantityBase, 4)}{" "}
                      {position.instrument.split("-")[0]}
                    </p>
                  </div>
                  <div className="text-right">
                    <p
                      className={
                        "text-xl font-semibold tabular-nums " + tone(position.unrealizedPnlQuote)
                      }
                    >
                      {number(position.unrealizedPnlQuote)}{" "}
                      <span className="text-xs font-normal text-muted-foreground">USDT</span>
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">Нереализованный PnL</p>
                  </div>
                </div>
                <dl className="grid grid-cols-2 gap-x-5 gap-y-5 p-5 sm:grid-cols-3 xl:grid-cols-6">
                  {[
                    ["Вход", price(position.entryPriceQuote)],
                    ["Текущая · Mark", price(position.markPriceQuote)],
                    ["Стоп", plan ? price(plan.stopPriceQuote) : "Не подтверждён"],
                    ["Тейк-профит", plan ? price(plan.takeProfitPriceQuote) : "Не подтверждён"],
                    [
                      "До стопа",
                      stopDistance === null ? "—" : number(Math.abs(stopDistance)) + "%",
                    ],
                    [
                      "Ликвидация · оценка",
                      position.estimatedLiquidationPriceQuote
                        ? "≈ " + price(position.estimatedLiquidationPriceQuote)
                        : position.estimatedLiquidationPriceQuote === null
                          ? "Нет границы > 0"
                          : "Нет расчёта",
                    ],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="mt-1 text-sm font-semibold tabular-nums">{value}</dd>
                    </div>
                  ))}
                </dl>
                {position.liquidationRequired ? (
                  <p role="alert" className="px-5 pb-4 text-sm font-medium text-destructive">
                    По текущей записи требуется защитное действие.
                  </p>
                ) : null}
                {!protectionActive ? (
                  <p role="status" className="px-5 pb-4 text-sm text-warning">
                    Действующая защита не подтверждена. Проверьте сессию.
                  </p>
                ) : null}
                <div className="border-t border-border px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-medium">Доливки по плану</h4>
                    <span className="text-xs text-muted-foreground">
                      Остаток бюджета:{" "}
                      {reservation ? number(reservation.reservedNotionalQuote) : "—"} USDT
                    </span>
                  </div>
                  {reservation?.stages?.length ? (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {reservation.stages.map((step, index) => (
                        <div key={step.stepId} className="rounded-xl bg-muted/50 p-3 text-sm">
                          <div className="flex justify-between gap-3">
                            <span>
                              Уровень {index + 1} ·{" "}
                              <strong className="tabular-nums">
                                {price(step.triggerPriceQuote)}
                              </strong>
                            </span>
                            <span className="tabular-nums">
                              {number(step.remainingNotionalQuote)} USDT
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {Number(step.remainingNotionalQuote) === 0
                              ? "Бюджет использован"
                              : step.activatedAt
                                ? "Уровень достигнут · остаток ещё не исполнен"
                                : "Ожидает уровня"}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground">
                      {verified ? "Доливки не запланированы." : "План временно недоступен."}
                    </p>
                  )}
                  <details className="mt-3 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Как читать риск и доливки</summary>
                    <div className="mt-2 space-y-2">
                      <p>
                        Оценка ликвидации: меняется цена этого инструмента, остальные позиции,
                        ставки маржи и баланс фиксированы. Будущие комиссии, funding и доливки не
                        учтены. Это граница модели общей маржи, не котировка OKX.
                      </p>
                      <p>
                        Уровень доливки — условие повторного анализа, а не выставленный ордер.
                        Достижение уровня не означает исполнение. Резерв — доступный по плану объём,
                        а не заблокированные деньги.
                      </p>
                      <p>
                        Стоп и цель показаны из действующего проверенного плана. При разрыве связи
                        или проскальзывании цена исполнения может отличаться.
                      </p>
                    </div>
                  </details>
                </div>
              </article>
            );
          })
        )}
      </section>
      <section
        className="rounded-2xl border border-border bg-card p-5"
        aria-label="Аналитика счёта"
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Аналитика</h2>
          <span className="text-xs text-muted-foreground">С начала эксперимента</span>
        </div>
        {journal.analytics?.points.length ? (
          <PaperEquityChart key={journal.ledgerId} analytics={journal.analytics} />
        ) : (
          <p className="text-sm text-muted-foreground">Полная кривая капитала пока недоступна.</p>
        )}
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">Максимальная просадка</p>
            <p className="mt-1 font-semibold tabular-nums">
              {journal.analytics ? number(journal.analytics.maximumDrawdownPercent) + "%" : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Комиссии</p>
            <p className="mt-1 font-semibold tabular-nums">
              {number(state.totalFeesQuote, 4)} USDT
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Funding · нетто</p>
            <p className={"mt-1 font-semibold tabular-nums " + tone(state.fundingNetQuote)}>
              {number(state.fundingNetQuote, 4)} USDT
            </p>
          </div>
        </div>
        <details className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Баланс и маржа</summary>
          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            {[
              ["Начальный капитал", state.initialBalanceQuote],
              ["Баланс без переоценки", state.bookBalanceQuote],
              ["Реализованный PnL движка", state.realizedPnlQuote],
              ["Резерв движка", state.lockedMarginQuote],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className="mt-1 tabular-nums text-foreground">{number(value!)} USDT</dd>
              </div>
            ))}
          </dl>
        </details>
      </section>
    </div>
  );
}
