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

/** "now"/"0m" read oddly as "reset now"; everything else is a duration. */
function resetLabel(resetIn: string): string {
  if (resetIn === "now" || resetIn === "0m") return "resets soon";
  return `resets in ${resetIn}`;
}

export function QuotaBar({ usedPct, resetIn, noData, emptyLabel = "—" }: QuotaBarProps) {
  if (noData) {
    return <span className="text-xs text-zinc-500">(no data yet)</span>;
  }
  if (usedPct == null) {
    if (resetIn) {
      // Reset time known but usage isn't — say so instead of an unlabelled grey line.
      return (
        <span className="text-xs text-zinc-500">
          {resetLabel(resetIn)} · usage n/a
        </span>
      );
    }
    return <span className="text-zinc-600">{emptyLabel}</span>;
  }

  const width = Math.min(100, Math.max(0, usedPct));
  return (
    <div className="min-w-[9rem]">
      <div className="mb-0.5 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded bg-zinc-800">
          <div className={`h-full ${barColor(width)}`} style={{ width: `${width}%` }} />
        </div>
        <span className="w-16 text-right font-mono text-xs text-zinc-400">{width}% used</span>
      </div>
      {resetIn && <div className="text-xs text-zinc-600">{resetLabel(resetIn)}</div>}
    </div>
  );
}

export function ContextPct({ pct, noData }: { pct: number | null; noData?: boolean }) {
  if (noData) return <span className="text-xs text-zinc-500">(no data yet)</span>;
  if (pct == null) return <span className="text-zinc-600">—</span>;
  const width = Math.min(100, Math.max(0, pct));
  return (
    <div className="min-w-[8rem]">
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded bg-zinc-800">
          <div className={`h-full ${barColor(width)}`} style={{ width: `${width}%` }} />
        </div>
        <span className="w-16 text-right font-mono text-xs text-zinc-400">{width}% full</span>
      </div>
    </div>
  );
}
