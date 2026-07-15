export interface CohortVersions {
  sdkVersion: string;
  claudeCodeVersion: string;
}

export interface CohortState extends CohortResult {
  candidateKey: string;
  noticeMessageId: string;
}

export interface CohortResult {
  current: CohortVersions;
  candidate: CohortVersions;
  status: "passed" | "failed";
  summary: string;
  checkedAt: string;
  logPath: string;
  lockPath: string | null;
  lockSha256: string | null;
}

export function validateCandidateCohort(
  sdkPackage: { version?: unknown; claudeCodeVersion?: unknown },
  cliVersion: string,
): CohortVersions {
  const sdkVersion = String(sdkPackage.version ?? "").trim();
  const claudeCodeVersion = String(sdkPackage.claudeCodeVersion ?? "").trim();
  if (!sdkVersion || !claudeCodeVersion) throw new Error("candidate SDK metadata is incomplete");
  if (claudeCodeVersion !== cliVersion.trim()) {
    throw new Error(`cohort mismatch: SDK ${sdkVersion} requires Claude Code ${claudeCodeVersion}, got ${cliVersion}`);
  }
  return { sdkVersion, claudeCodeVersion };
}

export function candidateCohortKey(candidate: CohortVersions): string {
  return `sdk-${candidate.sdkVersion}__claude-${candidate.claudeCodeVersion}`;
}

export function cohortNeedsVerification(
  previous: Pick<CohortState, "candidateKey" | "status"> | null,
  candidate: CohortVersions,
  force: boolean,
): boolean {
  if (force || !previous) return true;
  return previous.candidateKey !== candidateCohortKey(candidate) || previous.status === "failed";
}

export function cohortNoticeAction(
  status: "queued" | "running" | "delivering" | "completed" | "failed" | "cancelled" | null,
): "enqueue" | "wait" | "done" | "requeue" {
  if (status === null) return "enqueue";
  if (status === "completed") return "done";
  if (status === "failed" || status === "cancelled") return "requeue";
  return "wait";
}

export function renderCohortNotice(result: CohortResult): string {
  const versions = `SDK ${result.candidate.sdkVersion} + Claude Code ${result.candidate.claudeCodeVersion}`;
  if (result.status === "passed") {
    return [
      `🧪 Claude cohort 업데이트 가능: ${versions}`,
      result.summary,
      "현재 production은 변경하지 않았어. " +
        `SDK ${result.current.sdkVersion} + Claude Code ${result.current.claudeCodeVersion} 그대로 유지 중이야.`,
    ].join("\n");
  }
  return [
    `⛔ Claude cohort 격리 검증 실패: ${versions}`,
    result.summary,
    `현재 production은 SDK ${result.current.sdkVersion} + Claude Code ${result.current.claudeCodeVersion} 그대로 유지했어.`,
    `로컬 상세 로그: ${result.logPath}`,
  ].join("\n");
}
