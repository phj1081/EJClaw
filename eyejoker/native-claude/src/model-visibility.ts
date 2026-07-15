export function shortModelLabel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export function formatModelUsage(mainModel: string | null | undefined, subagentModels: string[] = []): string {
  const labels: string[] = [];
  for (const model of [mainModel, ...subagentModels]) {
    if (!model) continue;
    const label = shortModelLabel(model);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.join(" + ");
}
