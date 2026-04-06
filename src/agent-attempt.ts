import {
  getAgentOutputText,
  getStructuredAgentOutput,
} from './agent-output.js';
import type { AgentOutput } from './agent-runner.js';
import {
  evaluateStreamedOutput,
  type EvaluateStreamedOutputOptions,
  type EvaluateStreamedOutputResult,
  type StreamedOutputState,
} from './streamed-output-evaluator.js';

export interface EvaluatedAgentOutput {
  output: AgentOutput;
  outputText: string | null;
  structuredOutput: ReturnType<typeof getStructuredAgentOutput>;
  evaluation: EvaluateStreamedOutputResult;
}

export function createInitialStreamedOutputState(): StreamedOutputState {
  return {
    sawOutput: false,
    sawVisibleOutput: false,
    sawSuccessNullResultWithoutOutput: false,
  };
}

export function createEvaluatedOutputHandler(args: {
  agentType: EvaluateStreamedOutputOptions['agentType'];
  provider: string;
  evaluationOptions?: Omit<
    EvaluateStreamedOutputOptions,
    'agentType' | 'provider'
  >;
  onEvaluatedOutput?: (output: EvaluatedAgentOutput) => Promise<void> | void;
}): {
  handleOutput: (output: AgentOutput) => Promise<void>;
  getState: () => StreamedOutputState;
  markVisibleOutput: () => void;
} {
  let state = createInitialStreamedOutputState();

  return {
    async handleOutput(output: AgentOutput): Promise<void> {
      const rawOutputText = getAgentOutputText(output);
      const outputText =
        typeof rawOutputText === 'string' ? rawOutputText : null;
      const structuredOutput = getStructuredAgentOutput(output);
      const evaluation = evaluateStreamedOutput(output, state, {
        agentType: args.agentType,
        provider: args.provider,
        ...args.evaluationOptions,
      });
      state = evaluation.state;
      await args.onEvaluatedOutput?.({
        output,
        outputText,
        structuredOutput,
        evaluation,
      });
    },
    getState(): StreamedOutputState {
      return state;
    },
    markVisibleOutput(): void {
      state = {
        ...state,
        sawVisibleOutput: true,
      };
    },
  };
}
