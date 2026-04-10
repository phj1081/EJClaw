export {
  assertReadonlyWorkspaceRepoConnectivity,
  buildReviewerGitGuardEnv,
  isReviewerRuntime,
} from 'ejclaw-runners-shared';

// Codex app-server does not expose a BashTool-style pre-use hook, so reviewer
// mode can only hard-block mutating git via PATH interception here. Non-git
// shell mutation commands remain a known gap when REVIEWER_AGENT_TYPE=codex.
