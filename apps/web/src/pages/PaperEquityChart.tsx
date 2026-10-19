import type { TradingPaperPerpetualJournalReadOutput } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";

type Verified = Extract<TradingPaperPerpetualJournalReadOutput, { status: "verified" }>;
type Analytics = NonNullable<Verified["analytics"]>;
const money = (n: number) =>
  n.toLocaleString("ru-RU", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
export function PaperEquityChart({ analytics }: { analytics: Analytics }) {
  const [mode, setMode] = useState<"equity" | "drawdown">("equity");
  const [selected, setSelected] = useState<number | null>(null);
  const chart = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    if (!chart.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(chart.current);
    return () => observer.disconnect();
  }, []);
  const points = analytics.points;
  const index = Math.min(selected ?? points.length - 1, points.length - 1);
  const point = points[index];
  if (!point) return null;
  const values = points.map((p) =>
    mode === "equity" ? Number(p.equityQuote) : -Number(p.drawdownPercent),
  );
  const bottom = Math.min(...values),
    top = Math.max(...values),
    padding = Math.max((top - bottom) * 0.15, mode === "equity" ? 0.05 : 0.01);
  const min = bottom - padding,
    max = top + padding;
  const firstAt = Date.parse(points[0]!.at),
    lastAt = Date.parse(points.at(-1)!.at);
  const x = (i: number) =>
    60 + ((Date.parse(points[i]!.at) - firstAt) / Math.max(1, lastAt - firstAt)) * (width - 80);
  const y = (i: number) => 180 - ((values[i]! - min) / (max - min)) * 155;
  const path = points
    .map((p, i) => (i === 0 || p.gapBefore ? "M" : "L") + x(i).toFixed(2) + "," + y(i).toFixed(2))
    .join(" ");
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <fieldset className="flex gap-1 rounded-lg bg-muted p-1" aria-label="Вид графика">
          <button
            type="button"
            aria-pressed={mode === "equity"}
            onClick={() => setMode("equity")}
            className={
              "rounded-md px-3 py-1.5 text-xs " +
              (mode === "equity" ? "bg-background font-medium shadow-sm" : "text-muted-foreground")
            }
          >
            Капитал
          </button>
          <button
            type="button"
            aria-pressed={mode === "drawdown"}
            onClick={() => setMode("drawdown")}
            className={
              "rounded-md px-3 py-1.5 text-xs " +
              (mode === "drawdown"
                ? "bg-background font-medium shadow-sm"
                : "text-muted-foreground")
            }
          >
            Просадка
          </button>
        </fieldset>
        <p className="text-sm tabular-nums">
          <span className="mr-3 text-xs text-muted-foreground">
            {new Date(point.at).toLocaleString("ru-RU")}
          </span>
          <strong>
            {mode === "equity"
              ? money(Number(point.equityQuote)) + " USDT"
              : money(Number(point.drawdownPercent)) + "%"}
          </strong>
        </p>
      </div>
      <svg
        ref={chart}
        viewBox={"0 0 " + width + " 210"}
        className={"w-full " + (mode === "drawdown" ? "text-destructive" : "text-primary")}
        role="img"
        aria-label={
          mode === "equity"
            ? "Кривая капитала по проверенному журналу"
            : "Просадка от предыдущего максимума капитала"
        }
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const cursor = ((event.clientX - box.left) / box.width) * width;
          let nearest = 0;
          for (let i = 1; i < points.length; i++)
            if (Math.abs(x(i) - cursor) < Math.abs(x(nearest) - cursor)) nearest = i;
          setSelected(nearest);
        }}
      >
        <title>{mode === "equity" ? "Капитал, USDT" : "Просадка, %"}</title>
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction} className="text-muted-foreground">
            <line
              x1="60"
              x2={width - 20}
              y1={25 + fraction * 155}
              y2={25 + fraction * 155}
              className="stroke-border"
              strokeDasharray="3 5"
            />
            <text x="52" y={29 + fraction * 155} textAnchor="end" fill="currentColor" fontSize="10">
              {money(max - fraction * (max - min))}
            </text>
          </g>
        ))}
        <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <line
          x1={x(index)}
          x2={x(index)}
          y1="22"
          y2="182"
          className="stroke-muted-foreground"
          strokeDasharray="3 4"
        />
        <circle cx={x(index)} cy={y(index)} r="4" fill="currentColor" />
        <g className="text-muted-foreground" fill="currentColor" fontSize="10">
          <text x="60" y="205">
            {new Date(points[0]!.at).toLocaleDateString("ru-RU")}
          </text>
          <text x={width - 20} y="205" textAnchor="end">
            {new Date(points.at(-1)!.at).toLocaleDateString("ru-RU")}
          </text>
        </g>
      </svg>
      <label className="sr-only" htmlFor="paper-equity-point">
        Точка графика
      </label>
      <input
        id="paper-equity-point"
        type="range"
        min="0"
        max={points.length - 1}
        value={index}
        onChange={(e) => setSelected(Number(e.target.value))}
        className="sr-only accent-primary focus:not-sr-only focus:mt-2 focus:w-full"
        aria-valuetext={
          new Date(point.at).toLocaleString("ru-RU") +
          " · " +
          (mode === "equity"
            ? money(Number(point.equityQuote)) + " USDT"
            : money(Number(point.drawdownPercent)) + "%")
        }
      />
      <p className="mt-2 text-xs text-muted-foreground">
        Переоценка по записям журнала. Разрывы — интервалы без наблюдений более 15 минут.
      </p>
    </div>
  );
}
