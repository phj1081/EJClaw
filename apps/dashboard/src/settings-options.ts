export const PRESET_MODELS = {
  codex: ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.3-codex'],
  claude: ['claude-opus-4-8'],
  glm: ['glm-5.2', 'glm-5.2[1m]', 'glm-5.1'],
} as const;

export type AgentType = 'claude-code' | 'codex' | 'glm-code';

export const CODEX_EFFORT_VALUES = [
  '',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export const CLAUDE_EFFORT_VALUES = [
  '',
  'low',
  'medium',
  'high',
  'max',
] as const;

/** @deprecated Use agent-specific lists via effortValuesForAgent */
export const EFFORT_VALUES = CODEX_EFFORT_VALUES;

export type EffortValue = (typeof CODEX_EFFORT_VALUES)[number];

export function effortValuesForAgent(
  agentType: AgentType,
): readonly EffortValue[] {
  return agentType === 'claude-code' || agentType === 'glm-code'
    ? CLAUDE_EFFORT_VALUES
    : CODEX_EFFORT_VALUES;
}

export function isEffortSupported(
  agentType: AgentType | null | undefined,
  effort: string,
): boolean {
  if (!effort) return true;
  if (!agentType) return true;
  return effortValuesForAgent(agentType).includes(effort as EffortValue);
}

export function formatEffortOption(
  value: EffortValue,
  localizedLabel: string,
): string {
  if (value === '') return localizedLabel;
  return `${localizedLabel} (${value})`;
}

export function buildModelOptions(current: string): string[] {
  const presets = [
    ...PRESET_MODELS.codex,
    ...PRESET_MODELS.claude,
    ...PRESET_MODELS.glm,
  ];
  const trimmed = current.trim();
  if (!trimmed || presets.includes(trimmed as (typeof presets)[number])) {
    return [...presets];
  }
  return [trimmed, ...presets.filter((model) => model !== trimmed)];
}

export function isPresetModel(model: string): boolean {
  const trimmed = model.trim();
  return (
    (PRESET_MODELS.codex as readonly string[]).includes(trimmed) ||
    (PRESET_MODELS.claude as readonly string[]).includes(trimmed) ||
    (PRESET_MODELS.glm as readonly string[]).includes(trimmed)
  );
}
