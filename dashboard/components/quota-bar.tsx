interface QuotaBarProps {
  usedPct: number | null;
  resetIn?: string | null;
  /** Shown when probe ran but cache is empty. */
  noData?: boolean;
  emptyLabel?: string;
}

function barColor(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-emerald-500";
}

export function QuotaBar({ usedPct, resetIn, noData, emptyLabel = "—" }: QuotaBarProps) {
  if (noData) {
    return <span className="text-xs text-zinc-500">(no data yet)</span>;
  }
  if (usedPct == null) {
    return <span className="text-zinc-600">{emptyLabel}</span>;
  }

  const width = Math.min(100, Math.max(0, usedPct));
  return (
    <div className="min-w-[8rem]">
      <div className="mb-0.5 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded bg-zinc-800">
          <div className={`h-full ${barColor(width)}`} style={{ width: `${width}%` }} />
        </div>
        <span className="w-8 text-right font-mono text-xs text-zinc-400">{width}%</span>
      </div>
      {resetIn && <div className="text-xs text-zinc-600">reset {resetIn}</div>}
    </div>
  );
}

export function ContextPct({ pct, noData }: { pct: number | null; noData?: boolean }) {
  if (noData) return <span className="text-xs text-zinc-500">(no data yet)</span>;
  if (pct == null) return <span className="text-zinc-600">—</span>;
  return <span className="font-mono text-zinc-300">{pct}%</span>;
}
