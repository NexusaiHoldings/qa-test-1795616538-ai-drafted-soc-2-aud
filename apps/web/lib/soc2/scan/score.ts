export type FindingStatus = "compliant" | "deficient" | "not_assessed";

export interface FindingForScore {
  status: FindingStatus;
  severity: "critical" | "high" | "medium" | "low" | string;
}

export interface CoverageScoreResult {
  score: number;
  compliantCount: number;
  deficientCount: number;
  notAssessedCount: number;
  findingsTotal: number;
}

const SEVERITY_WEIGHTS: Record<string, number> = {
  critical: 1.0,
  high: 0.75,
  medium: 0.5,
  low: 0.25,
};

export function computeCoverageScore(findings: FindingForScore[]): CoverageScoreResult {
  if (findings.length === 0) {
    return {
      score: 0,
      compliantCount: 0,
      deficientCount: 0,
      notAssessedCount: 0,
      findingsTotal: 0,
    };
  }

  let compliantCount = 0;
  let deficientCount = 0;
  let notAssessedCount = 0;
  let weightedTotal = 0;
  let weightedCompliant = 0;

  for (const finding of findings) {
    const severityWeight = SEVERITY_WEIGHTS[finding.severity] ?? SEVERITY_WEIGHTS.high;
    weightedTotal += severityWeight;

    if (finding.status === "compliant") {
      compliantCount += 1;
      weightedCompliant += severityWeight;
    } else if (finding.status === "deficient") {
      deficientCount += 1;
    } else {
      notAssessedCount += 1;
    }
  }

  const normalized = weightedTotal > 0 ? (weightedCompliant / weightedTotal) * 100 : 0;
  const score = Math.max(0, Math.min(100, Math.round(normalized)));

  return {
    score,
    compliantCount,
    deficientCount,
    notAssessedCount,
    findingsTotal: findings.length,
  };
}
