#!/usr/bin/env bun
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";

const executable = process.argv[2]!;
if (!executable) throw new Error("usage: cohort-smoke.ts <candidate-claude-executable>");
const model = process.env.CLAUDE_NATIVE_COHORT_MODEL ?? "claude-fable-5";
const sessionId = crypto.randomUUID();
let askCount = 0;

function sdkEnvironment(): Record<string, string | undefined> {
  const keys = [
    "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "PATH", "LANG", "LC_ALL",
    "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "CI", "NO_COLOR", "NO_PROXY",
    "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR",
    "CLAUDE_AGENT_SDK_CLIENT_APP",
  ];
  const environment: Record<string, string | undefined> = {};
  for (const key of keys) environment[key] = process.env[key];
  environment.CLAUDE_AGENT_SDK_CLIENT_APP = "eyejoker-cohort-verifier/0.2.0";
  return environment;
}

function options(resume = false): Options {
  return {
    cwd: process.cwd(),
    model,
    permissionMode: "default",
    pathToClaudeCodeExecutable: executable,
    tools: ["AskUserQuestion"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    includePartialMessages: true,
    includeHookEvents: true,
    canUseTool: async (toolName, input) => {
      if (toolName === "AskUserQuestion") {
        askCount += 1;
        const questions = (input as { questions?: Array<{ question?: string; options?: Array<{ label?: string }> }> }).questions ?? [];
        const answers: Record<string, string> = {};
        for (const question of questions) {
          const text = String(question.question ?? "question");
          answers[text] = String(question.options?.[0]?.label ?? "계속");
        }
        return { behavior: "allow" as const, updatedInput: { ...input, answers } };
      }
      return { behavior: "deny" as const, message: `tool not allowed in cohort smoke: ${toolName}`, interrupt: true };
    },
    env: sdkEnvironment(),
    ...(resume ? { resume: sessionId } : { sessionId }),
  };
}

async function run(prompt: string, resume = false): Promise<string> {
  let result = "";
  for await (const message of query({ prompt, options: options(resume) })) {
    if (message.type === "result") {
      if (message.subtype !== "success" || message.is_error) throw new Error(`candidate result failed: ${message.subtype}`);
      result = message.result;
    }
  }
  if (!result) throw new Error("candidate emitted no terminal result");
  return result;
}

const first = await run(
  "Cohort compatibility smoke다. 반드시 AskUserQuestion을 한 번 호출해 단일 선택지 '계속'을 물어본 뒤 최종에 COHORT_FIRST_OK를 포함해.",
);
if (!first.includes("COHORT_FIRST_OK")) throw new Error(`first marker missing: ${first.slice(0, 200)}`);
const second = await run("같은 세션 resume 검증이다. COHORT_RESUME_OK라고만 답해.", true);
if (!second.includes("COHORT_RESUME_OK")) throw new Error(`resume marker missing: ${second.slice(0, 200)}`);
if (askCount < 1) throw new Error("AskUserQuestion callback was not observed");
console.log(JSON.stringify({ marker: "COHORT_SMOKE_OK", askCount, sessionId }));
