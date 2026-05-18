import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  distributionConfigSchema,
  type DistributionConfig,
} from '../schemas/distribution-config.schema.js';

export class DistributionConfigError extends Error {
  readonly mcpName: string;
  readonly filePath: string;
  constructor(mcpName: string, filePath: string, message: string) {
    super(message);
    this.name = 'DistributionConfigError';
    this.mcpName = mcpName;
    this.filePath = filePath;
  }
}

function distributionYamlPath(repoRoot: string, mcpName: string): string {
  return path.join(repoRoot, 'pending-to-publish', mcpName, '.distribution.yaml');
}

export async function loadDistributionConfig(
  repoRoot: string,
  mcpName: string,
): Promise<DistributionConfig> {
  const filePath = distributionYamlPath(repoRoot, mcpName);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    throw new DistributionConfigError(
      mcpName,
      filePath,
      `.distribution.yaml not found at ${filePath}. ` +
        `The pipeline expects this file at the root of the MCP source repo cloned ` +
        `into pending-to-publish/${mcpName}/. Add one to the MCP repo or check the ` +
        `repo_url + repo_ref were resolved correctly.`,
    );
  }
  const parsed = yaml.load(raw);
  const result = distributionConfigSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new DistributionConfigError(
      mcpName,
      filePath,
      `.distribution.yaml at ${filePath} failed schema validation: ${detail}`,
    );
  }
  return result.data;
}
