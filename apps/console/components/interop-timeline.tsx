import { type InteropCase, type LockState, PART_LABEL, type PartKey } from "@/lib/interop";

/**
 * One interop run drawn from what the recorder saw on the ledgers: a lane per
 * part, its state over time, and, shaded across the lanes, the window in which
 * one part had settled and another had not. Numbered marks are the narrative's
 * events, listed beside it.
 */

const W = 960;
const LEFT = 10;
const RIGHT = 22;
/** Where the first lane's label sits; each lane is its label, then its bar. */
const TOP = 46;
const LABEL = 22;
const LANE = 34;
const GAP = 18;

const STATE_LABEL: Record<LockState, string> = { none: "", locked: "locked", settled: "settled", released: "released" };

/** Lane labels: the run's own, or the one-currency transfer's. */
export type PartLabels = Record<PartKey, string>;

export function eventRows(c: InteropCase): number[] {
  // Stack marks that would overlap: an event within 1.2s of the previous one in a row goes a row lower.
  const rows: number[] = [];
  const lastInRow: number[] = [];
  const span = scaleSpan(c);
  for (const e of c.events) {
    let row = 0;
    while (lastInRow[row] !== undefined && e.ms - lastInRow[row]! < span * 0.03) row++;
    lastInRow[row] = e.ms;
    rows.push(row);
  }
  return rows;
}

function scaleSpan(c: InteropCase): number {
  const last = Math.max(c.durationMs, ...c.changes.map((ch) => ch.ms), ...c.events.map((e) => e.ms));
  const step = last > 30_000 ? 10_000 : 5_000;
  return Math.max(step, Math.ceil(last / step) * step);
}

export function InteropTimeline({ c, labels }: { c: InteropCase; labels?: PartLabels | undefined }) {
  const parts: PartKey[] = c.coordinator === "unified" ? ["shared"] : ["ledger1", "ledger2"];
  const span = scaleSpan(c);
  const step = span > 30_000 ? 10_000 : 5_000;
  const x = (ms: number) => LEFT + (ms / span) * (W - LEFT - RIGHT);
  // The bar of lane i; its label sits LABEL above it.
  const laneY = (i: number) => TOP + LABEL + i * (LABEL + LANE + GAP);
  const lanesTop = TOP;
  const lanesBottom = laneY(parts.length - 1) + LANE;
  const rows = eventRows(c);
  const marksTop = lanesBottom + 46;
  const height = marksTop + (Math.max(0, ...rows) + 1) * 28 + 6;

  const settledAt = parts
    .map((p) => c.changes.find((ch) => ch.part === p && ch.state === "settled")?.ms)
    .filter((ms): ms is number => ms !== undefined);
  const windowStart = settledAt.length ? Math.min(...settledAt) : null;
  const windowEnd =
    windowStart === null ? null : c.summary.disagreesAtEnd ? span : settledAt.length === parts.length ? Math.max(...settledAt) : null;

  return (
    <svg
      className="itl"
      viewBox={`0 0 ${W} ${height}`}
      role="img"
      aria-label={`Each part's state over ${(c.durationMs / 1000).toFixed(0)} seconds; ${c.summary.outcome}`}
    >
      <defs>
        <pattern id="itl-locked" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" className="itl-locked-bg" />
          <line x1="0" y1="0" x2="0" y2="6" className="itl-locked-line" />
        </pattern>
      </defs>

      {/* Time axis. */}
      {Array.from({ length: span / step + 1 }, (_, i) => i * step).map((ms) => (
        <g key={ms}>
          <line x1={x(ms)} x2={x(ms)} y1={lanesTop - 10} y2={lanesBottom + 6} className="itl-grid" />
          <text x={x(ms)} y={lanesTop - 18} className="itl-tick">
            {ms / 1000}s
          </text>
        </g>
      ))}

      {/* The window in which the ledgers disagreed. */}
      {windowStart !== null && windowEnd !== null && windowEnd > windowStart ? (
        <g>
          <rect
            x={x(windowStart)}
            y={lanesTop - 6}
            width={Math.max(2, x(windowEnd) - x(windowStart))}
            height={lanesBottom - lanesTop + 12}
            className={c.summary.disagreesAtEnd ? "itl-window is-open" : "itl-window"}
          />
          <text x={x(windowStart) + 4} y={lanesBottom + 26} className="itl-window-label">
            {c.summary.disagreesAtEnd
              ? "ledgers disagree, for good"
              : `ledgers disagree ${((windowEnd - windowStart) / 1000).toFixed(1)}s`}
          </text>
        </g>
      ) : null}

      {/* A lane per part. */}
      {parts.map((part, i) => {
        const y = laneY(i);
        const changes = c.changes.filter((ch) => ch.part === part);
        const segments = changes.map((ch, j) => ({ ...ch, end: changes[j + 1]?.ms ?? span }));
        return (
          <g key={part}>
            <text x={LEFT} y={y - 8} className="itl-lane-label">
              {(labels ?? PART_LABEL)[part]}
            </text>
            <line x1={x(0)} x2={x(span)} y1={y + LANE / 2} y2={y + LANE / 2} className="itl-baseline" />
            {segments.map((s) => (
              <g key={`${s.state}-${s.ms}`}>
                <rect x={x(s.ms)} y={y} width={Math.max(2, x(s.end) - x(s.ms))} height={LANE} className={`itl-seg is-${s.state}`}>
                  <title>{`${STATE_LABEL[s.state]} at ${(s.ms / 1000).toFixed(1)}s, block ${s.block}`}</title>
                </rect>
                {x(s.end) - x(s.ms) > 64 ? (
                  <text x={x(s.ms) + 8} y={y + LANE / 2 + 5} className={`itl-seg-label is-${s.state}`}>
                    {STATE_LABEL[s.state]} · b{s.block}
                  </text>
                ) : null}
              </g>
            ))}
          </g>
        );
      })}

      {/* The narrative's events. */}
      {c.events.map((e, i) => {
        const cx = x(e.ms);
        const cy = marksTop + rows[i]! * 28;
        return (
          <g key={i}>
            <line x1={cx} x2={cx} y1={lanesBottom + 34} y2={cy - 11} className="itl-mark-line" />
            <circle cx={cx} cy={cy} r={11} className="itl-mark" />
            <text x={cx} y={cy + 4.5} className="itl-mark-n">
              {i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
