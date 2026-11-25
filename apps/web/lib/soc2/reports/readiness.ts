export type ReadinessInput = {
  deficientCount: number;
  highSeverityCount: number;
  mediumSeverityCount: number;
  lowSeverityCount: number;
};

export function estimateReadinessWeeks(input: ReadinessInput): number {
  const weighted =
    input.highSeverityCount * 3 +
    input.mediumSeverityCount * 2 +
    input.lowSeverityCount;

  const base = Math.ceil(weighted / 4);
  const floor = input.deficientCount > 0 ? 2 : 0;
  return Math.max(floor, base);
}
