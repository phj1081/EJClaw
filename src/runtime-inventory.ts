import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CURRENT_RUNTIME_AGENT_TYPE,
  DATA_DIR,
  SERVICE_ID,
  SERVICE_SESSION_SCOPE,
} from './config.js';

export interface RuntimePathSnapshot {
  label: string;
  path: string;
  exists: boolean;
}

export interface RuntimeSkillSummary {
  name: string;
  description: string | null;
  path: string;
}

export interface RuntimeSkillDirSnapshot extends RuntimePathSnapshot {
  count: number;
  skills: RuntimeSkillSummary[];
}

export interface RuntimeMcpSnapshot {
  configPath: RuntimePathSnapshot;
  ejclawConfigured: boolean;
  serverCount: number;
}

export interface RuntimeAgentInventory {
  configFiles: RuntimePathSnapshot[];
  skillDirs: RuntimeSkillDirSnapshot[];
  mcp: RuntimeMcpSnapshot;
}

export interface RuntimeInventorySnapshot {
  generatedAt: string;
  projectRoot: string;
  dataDir: string;
  service: {
    id: string;
    sessionScope: string;
    agentType: string;
  };
  codex: RuntimeAgentInventory;
  claude: RuntimeAgentInventory;
  ejclaw: {
    runnerSkillDir: RuntimeSkillDirSnapshot;
    mcpServer: RuntimePathSnapshot;
  };
}

interface RuntimeInventoryOptions {
  homeDir?: string;
  projectRoot?: string;
  generatedAt?: string;
}

interface McpConfigSummary {
  ejclawConfigured: boolean;
  serverCount: number;
}

function pathSnapshot(label: string, filePath: string): RuntimePathSnapshot {
  return {
    label,
    path: filePath,
    exists: fs.existsSync(filePath),
  };
}

function parseSkillMetadata(skillMdPath: string): {
  name: string | null;
  description: string | null;
} {
  let content: string;
  try {
    content = fs.readFileSync(skillMdPath, 'utf-8').slice(0, 8000);
  } catch {
    return { name: null, description: null };
  }

  const name = content.match(/^name:\s*(.+?)\s*$/m)?.[1]?.trim() ?? null;
  const description =
    content.match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim() ?? null;
  return { name, description };
}

function readSkillDir(label: string, dirPath: string): RuntimeSkillDirSnapshot {
  if (!fs.existsSync(dirPath)) {
    return {
      ...pathSnapshot(label, dirPath),
      count: 0,
      skills: [],
    };
  }

  const skills = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const skillDir = path.join(dirPath, entry.name);
      const skillMdPath = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) return null;
      const metadata = parseSkillMetadata(skillMdPath);
      return {
        name: metadata.name || entry.name,
        description: metadata.description,
        path: skillDir,
      };
    })
    .filter((skill): skill is RuntimeSkillSummary => Boolean(skill))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    ...pathSnapshot(label, dirPath),
    count: skills.length,
    skills,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summarizeTomlMcpConfig(content: string): McpConfigSummary {
  const serverMatches = content.match(/^\s*\[mcp_servers\.[^\]]+\]/gm) ?? [];
  return {
    ejclawConfigured: /^\s*\[mcp_servers\.ejclaw(?:\.[^\]]+)?\]/m.test(content),
    serverCount: serverMatches.length,
  };
}

function summarizeJsonMcpConfig(content: string): McpConfigSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const servers = parsed.mcpServers ?? parsed.mcp_servers;
  if (!isRecord(servers)) {
    return {
      ejclawConfigured: false,
      serverCount: 0,
    };
  }

  const names = Object.keys(servers);
  return {
    ejclawConfigured: names.includes('ejclaw'),
    serverCount: names.length,
  };
}

function readMcpSnapshot(
  label: string,
  configPath: string,
): RuntimeMcpSnapshot {
  let content = '';
  if (fs.existsSync(configPath)) {
    try {
      content = fs.readFileSync(configPath, 'utf-8');
    } catch {
      content = '';
    }
  }

  const summary =
    path.extname(configPath) === '.json'
      ? (summarizeJsonMcpConfig(content) ?? summarizeTomlMcpConfig(content))
      : summarizeTomlMcpConfig(content);

  return {
    configPath: pathSnapshot(label, configPath),
    ...summary,
  };
}

export function getRuntimeInventory(
  options: RuntimeInventoryOptions = {},
): RuntimeInventorySnapshot {
  const homeDir = options.homeDir ?? os.homedir();
  const projectRoot = options.projectRoot ?? process.cwd();
  const codexConfigPath = path.join(homeDir, '.codex', 'config.toml');
  const claudeSettingsPath = path.join(homeDir, '.claude', 'settings.json');
  const runnerSkillDir = path.join(projectRoot, 'runners', 'skills');
  const mcpServerPath = path.join(
    projectRoot,
    'runners',
    'agent-runner',
    'dist',
    'ipc-mcp-stdio.js',
  );

  const ejclawRunnerSkills = readSkillDir(
    'EJClaw runner skills',
    runnerSkillDir,
  );

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    projectRoot,
    dataDir: DATA_DIR,
    service: {
      id: SERVICE_ID,
      sessionScope: SERVICE_SESSION_SCOPE,
      agentType: CURRENT_RUNTIME_AGENT_TYPE,
    },
    codex: {
      configFiles: [
        pathSnapshot('Codex config.toml', codexConfigPath),
        pathSnapshot(
          'Codex auth.json',
          path.join(homeDir, '.codex', 'auth.json'),
        ),
      ],
      skillDirs: [
        readSkillDir(
          'Codex user skills',
          path.join(homeDir, '.agents', 'skills'),
        ),
        ejclawRunnerSkills,
      ],
      mcp: readMcpSnapshot('Codex config.toml', codexConfigPath),
    },
    claude: {
      configFiles: [
        pathSnapshot('Claude settings.json', claudeSettingsPath),
        pathSnapshot(
          'Claude credentials',
          path.join(homeDir, '.claude', '.credentials.json'),
        ),
      ],
      skillDirs: [
        readSkillDir(
          'Claude user skills',
          path.join(homeDir, '.claude', 'skills'),
        ),
        ejclawRunnerSkills,
      ],
      mcp: readMcpSnapshot('Claude settings.json', claudeSettingsPath),
    },
    ejclaw: {
      runnerSkillDir: ejclawRunnerSkills,
      mcpServer: pathSnapshot('EJClaw IPC MCP server', mcpServerPath),
    },
  };
}
