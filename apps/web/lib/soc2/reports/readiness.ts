/**
 * SOC 2 readiness estimator (F1-006).
 *
 * Pure, deterministic function that turns the current deficient-finding mix
 * into an estimated number of weeks until the org is audit-ready. No model is
 * in the loop — this is a transparent weighting the CTO can reason about:
 *
 *   - a high-severity gap is assumed to take ~3 engineer-weeks of remediation
 *   - a medium-severity gap ~2 weeks
 *   - a low-severity gap ~1 week
 *
 * We assume a small team can close roughly four "severity-weeks" of work in
 * parallel per calendar week (REMEDIATION_VELOCITY), so the calendar estimate
 * is the weighted backlog divided by that velocity. While any gap remains we
 * never report fewer than MIN_WEEKS_WITH_GAPS weeks — closing a control,
 * collecting evidence and re-scanning realistically spans at least a sprint.
 * A fully compliant org returns 0.
 */

export interface ReadinessInput {
  readonly deficientCount: number;
  readonly highSeverityCount: number;
  readonly mediumSeverityCount: number;
  readonly lowSeverityCount: number;
}

/** Engineer-weeks assumed per gap, by severity. */
const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 } as const;

/** Severity-weeks a team can close in parallel per calendar week. */
const REMEDIATION_VELOCITY = 4;

/** Floor (in weeks) while any gap remains open. */
const MIN_WEEKS_WITH_GAPS = 2;

export function estimateReadinessWeeks(input: ReadinessInput): number {
  const high = Math.max(0, input.highSeverityCount);
  const medium = Math.max(0, input.mediumSeverityCount);
  const low = Math.max(0, input.lowSeverityCount);

  const weightedBacklog =
    high * SEVERITY_WEIGHT.high + medium * SEVERITY_WEIGHT.medium + low * SEVERITY_WEIGHT.low;

  if (input.deficientCount <= 0 && weightedBacklog === 0) {
    return 0;
  }

  const calendarWeeks = Math.ceil(weightedBacklog / REMEDIATION_VELOCITY);
  return Math.max(MIN_WEEKS_WITH_GAPS, calendarWeeks);
}
