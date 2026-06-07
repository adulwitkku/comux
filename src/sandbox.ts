// Confinement is intentionally a no-op (ADR-0017).
//
// ADR-0005 once wrapped every Agent launch in `sandbox-exec` so it could only write inside its
// workspace. That boundary was hollowed out by two later decisions: ADR-0016 made Bypass mode
// default-on (zero human gates) and Phase 3 has Agents drive cmux directly — and the sandbox
// never covered cmux/network/spawn anyway, only file writes. A write-only sandbox guarding a side
// door while the front door stands open was safety theatre, so ADR-0017 drops it: the orchestrated
// flow runs Agents unconfined, exactly as Broadcast mode already does (ADR-0014).
//
// The safety story is now: trusted Agents + the frozen Acceptance check (ADR-0009) + Git
// checkpoints for revert (ADR-0002). `confine` is kept as an identity function so existing call
// sites (agents.ts, check.ts) need no change and a future re-introduction has one seam.

/** Identity: return the launch command unchanged. Confinement is dropped (ADR-0017). */
export function confine(launch: string, _workspace: string): string {
  return launch;
}
