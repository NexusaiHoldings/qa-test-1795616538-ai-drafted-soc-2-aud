export type FindingStatus = "compliant" | "deficient" | "not_assessed";

export type ScoreInputFinding = {
  status: string;
  severity: string;
};

export type CoverageScoreBreakdown = {
  score: number;
  compliantCount: number;
  deficientCount: number;
  notAssessedCount: number;
  findingsTotal: number;
};

const SEVERITY_WEIGHTS: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function normalizeStatus(status: string): FindingStatus {
  if (status === "compliant") {
    return "compliant";
  }
  if (status === "deficient") {
    return "deficient";
  }
  return "not_assessed";
}

function normalizeSeverity(severity: string): number {
  return SEVERITY_WEIGHTS[severity] ?? SEVERITY_WEIGHTS.high;
}

export function computeCoverageScore(findings: ScoreInputFinding[]): CoverageScoreBreakdown {
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
  let totalWeight = 0;
  let compliantWeight = 0;

  for (const finding of findings) {
    const status = normalizeStatus(finding.status);
    const weight = normalizeSeverity(finding.severity);

    totalWeight += weight;

    if (status === "compliant") {
      compliantCount += 1;
      compliantWeight += weight;
    } else if (status === "deficient") {
      deficientCount += 1;
    } else {
      notAssessedCount += 1;
    }
  }

  const score = totalWeight > 0 ? Math.max(0, Math.min(100, Math.round((compliantWeight / totalWeight) * 100))) : 0;

  return {
    score,
    compliantCount,
    deficientCount,
    notAssessedCount,
    findingsTotal: findings.length,
  };
}
