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
  entry_invalidated: "Идея отменена: цена достигла стопа или цели",
  denied_close_unknown: "Позиция для закрытия не найдена",
  closed: "Позиция закрыта",
  close_partial_or_not_ready: "Выход исполнен частично или ожидает котировки",
  denied_market: "Пара вне выбранного списка",
  expired_research: "Анализ устарел",
};
export function paperPerpetualOutcomeLabel(outcome: string | null) {
  if (!outcome) return "Решение";
  return (
    outcomes[outcome] ??
    (outcome.startsWith("denied_")
      ? "Предложение отклонено проверкой риска"
      : "Ордер отменён или не исполнен")
  );
}
