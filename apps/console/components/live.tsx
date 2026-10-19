"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Re-read the page's server data on an interval while the tab is visible, so
 * the view follows the chain. Pausable, since a moving page is hard to read.
 */
export function Live({ everyMs = 2000 }: { everyMs?: number }) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => clearInterval(id);
  }, [paused, everyMs, router]);

  return (
    <button type="button" className="live" aria-pressed={!paused} onClick={() => setPaused((p) => !p)}>
      <span className={`live-dot ${paused ? "is-paused" : ""}`} aria-hidden="true" />
      {paused ? "Paused · resume" : "Following the chain · pause"}
    </button>
  );
}
