import { describe, expect, test } from "bun:test";
import {
  candidateCohortKey,
  cohortNeedsVerification,
  renderCohortNotice,
  validateCandidateCohort,
} from "../src/cohort-policy";

describe("Claude Code/Agent SDK cohort policy", () => {
  test("treats SDK metadata as the authoritative CLI pairing", () => {
    expect(validateCandidateCohort({ version: "0.3.210", claudeCodeVersion: "2.1.210" }, "2.1.210")).toEqual({
      sdkVersion: "0.3.210",
      claudeCodeVersion: "2.1.210",
    });
    expect(() => validateCandidateCohort({ version: "0.3.210", claudeCodeVersion: "2.1.209" }, "2.1.210")).toThrow("cohort mismatch");
  });

  test("runs once per candidate unless forced", () => {
    const candidate = { sdkVersion: "0.3.210", claudeCodeVersion: "2.1.210" };
    expect(candidateCohortKey(candidate)).toBe("sdk-0.3.210__claude-2.1.210");
    expect(cohortNeedsVerification(null, candidate, false)).toBe(true);
    expect(cohortNeedsVerification({ candidateKey: candidateCohortKey(candidate), status: "passed" }, candidate, false)).toBe(false);
    expect(cohortNeedsVerification({ candidateKey: candidateCohortKey(candidate), status: "failed" }, candidate, false)).toBe(true);
    expect(cohortNeedsVerification({ candidateKey: candidateCohortKey(candidate), status: "failed" }, candidate, true)).toBe(true);
  });

  test("renders a concise notice without claiming production was upgraded", () => {
    const notice = renderCohortNotice({
      current: { sdkVersion: "0.3.201", claudeCodeVersion: "2.1.201" },
      candidate: { sdkVersion: "0.3.210", claudeCodeVersion: "2.1.210" },
      status: "passed",
      summary: "tests and live smoke passed",
      checkedAt: "2026-07-16T00:00:00Z",
      logPath: "/tmp/cohort.log",
    });
    expect(notice).toContain("업데이트 가능");
    expect(notice).toContain("production은 변경하지 않았어");
    expect(notice).not.toContain("자동 배포 완료");
  });
});
