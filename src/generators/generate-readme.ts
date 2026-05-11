import type { EnvironmentVariableEntry } from './generate-environment-variables.js';
import type {
  ClientId,
  InstallBlockResult,
} from './generate-install-block.js';
import { SUPPORTED_CLIENT_IDS } from './generate-install-block.js';

export const README_MARKER_INSTALL = '<!-- INSTALL_BLOCKS -->';
export const README_MARKER_ENV = '<!-- ENV_VARS -->';

export const CLIENT_DISPLAY_NAMES: Record<ClientId, string> = {
  'claude-desktop': 'Claude Desktop',
  'claude-code-cli': 'Claude Code (CLI)',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  cline: 'Cline',
  vscode: 'VS Code',
  jetbrains: 'JetBrains',
  zed: 'Zed',
};

export interface GenerateReadmeOptions {
  sourceReadme: string;
  installBlocks: Record<ClientId, InstallBlockResult>;
  environmentVariables: readonly EnvironmentVariableEntry[];
}

export interface ReadmeResult {
  markdown: string;
}

function buildInstallSection(blocks: Record<ClientId, InstallBlockResult>): string {
  const sections: string[] = [];
  for (const clientId of SUPPORTED_CLIENT_IDS) {
    const block = blocks[clientId];
    if (!block) {
      throw new Error(
        `installBlocks is missing an entry for clientId '${clientId}'. Generate all 8 clients (Story 1.8) before assembling the README.`,
      );
    }
    sections.push(`### ${CLIENT_DISPLAY_NAMES[clientId]}\n\n${block.markdown.trimEnd()}`);
  }
  return sections.join('\n\n');
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function buildEnvTable(envVars: readonly EnvironmentVariableEntry[]): string {
  if (envVars.length === 0) {
    return '_This MCP does not require any environment variables._';
  }
  const sorted = [...envVars].sort((a, b) => a.name.localeCompare(b.name));
  const lines = [
    '| Name | Required | Secret | Description |',
    '| --- | --- | --- | --- |',
    ...sorted.map(
      (v) =>
        `| \`${v.name}\` | ${v.isRequired ? 'Yes' : 'No'} | ${v.isSecret ? 'Yes' : 'No'} | ${escapeTableCell(v.description)} |`,
    ),
  ];
  return lines.join('\n');
}

export function generateReadme(opts: GenerateReadmeOptions): ReadmeResult {
  const { sourceReadme, installBlocks, environmentVariables } = opts;

  const installSection = buildInstallSection(installBlocks);
  const envSection = buildEnvTable(environmentVariables);

  const lines = sourceReadme.split('\n');
  const out: string[] = [];
  let foundInstall = false;
  let foundEnv = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === README_MARKER_INSTALL) {
      foundInstall = true;
      out.push(installSection);
    } else if (trimmed === README_MARKER_ENV) {
      foundEnv = true;
      out.push(envSection);
    } else {
      out.push(line);
    }
  }

  const missing: string[] = [];
  if (!foundInstall) missing.push(README_MARKER_INSTALL);
  if (!foundEnv) missing.push(README_MARKER_ENV);
  if (missing.length > 0) {
    throw new Error(
      `Source README is missing required marker(s): ${missing.join(', ')}. Add each missing marker on its own line where the corresponding generated content should appear.`,
    );
  }

  return { markdown: out.join('\n') };
}
