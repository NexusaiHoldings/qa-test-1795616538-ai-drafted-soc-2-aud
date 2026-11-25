export type Severity = "low" | "medium" | "high" | "critical";

export interface ReadinessTaskSignal {
  severity: Severity;
  status: "todo" | "in_progress" | "verified";
  notApplicable: boolean;
}

const severityWeight: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function estimateWeeksToAuditReady(tasks: ReadinessTaskSignal[]): number {
  const actionable = tasks.filter((t) => !t.notApplicable);
  if (actionable.length === 0) return 0;
  const effort = actionable.reduce((sum, task) => {
    const base = severityWeight[task.severity] ?? 2;
    if (task.status === "verified") return sum;
    if (task.status === "in_progress") return sum + Math.max(1, base - 1);
    return sum + base;
  }, 0);
  return Math.max(1, Math.ceil(effort / 5));
}
