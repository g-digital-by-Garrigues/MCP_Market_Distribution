import { spawn } from 'node:child_process';

// Story 3.1: Idempotency check helper.
//
// Every publisher composite action consults this before publishing. If the
// MCP is already at the target version on that channel, the publisher must
// return `status: "skipped"` instead of re-publishing — that's how we get
// safe re-runs of the same release (Journey 2: a transient failure in a
// later step shouldn't make us try to re-publish a version already live on
// npm). The helper is wrapped in a 3-attempt exponential backoff so a
// transient registry blip doesn't cause us to declare "absent" when in fact
// the version IS present (which would lead to a duplicate-publish attempt
// that DOES fail — but for the wrong reason).
//
// All three return values are structured (never throws): callers compose
// on the discriminated `status` field.

export type CheckTargetName = 'npm' | 'docker-hub' | 'mcp-publisher';

export interface CheckPresentResult {
  status: 'present';
  version: string;
  attempts: number;
}
export interface CheckAbsentResult {
  status: 'absent';
  version: null;
  attempts: number;
}
export interface CheckErrorResult {
  status: 'error';
  version: null;
  attempts: number;
  error: { message: string; lastStderr?: string };
}
export type CheckTargetVersionResult =
  | CheckPresentResult
  | CheckAbsentResult
  | CheckErrorResult;

// Delays for retry attempts. Long delays are deliberate — these registries
// can take seconds-to-minutes to recover from a transient failure, and a
// false "absent" answer causes a worse failure mode (duplicate publish
// attempt) than a long wait. Override in tests via `retryDelaysMs: [0, 0]`.
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 300_000];

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecFn = (cmd: string, args: readonly string[]) => Promise<ExecResult>;

export interface CheckOptions {
  /** Override retry delays. Length determines max attempts (default 3). */
  retryDelaysMs?: readonly number[];
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable exec for tests. */
  exec?: ExecFn;
}

interface TargetProbe {
  /** Argv to invoke for the version-check. */
  cmd: (mcpName: string) => { cmd: string; args: string[] };
  /**
   * Parse the exec result into a high-level outcome:
   *   - { present: true, version }  → registry confirms version
   *   - { present: false }          → registry confirms not-published
   *   - null                        → transient/unknown failure, retry
   */
  parse: (result: ExecResult, mcpName: string) => { present: true; version: string } | { present: false } | null;
}

const npmProbe: TargetProbe = {
  cmd: (mcpName) => ({ cmd: 'npm', args: ['view', mcpName, 'version', '--json'] }),
  parse: (result) => {
    // npm view exits 0 with the version (or JSON) on stdout if present.
    // It exits non-zero with E404 in stderr (or `code: 'E404'` in --json
    // mode's stderr) when the package isn't published at all.
    if (result.exitCode === 0) {
      const trimmed = result.stdout.trim();
      if (trimmed === '') return null;
      // --json wraps the value in quotes, e.g. `"1.2.3"`. Strip optional quotes.
      const unquoted = trimmed.replace(/^"|"$/g, '');
      return { present: true, version: unquoted };
    }
    if (/E404/.test(result.stderr) || /404 Not Found/i.test(result.stderr)) {
      return { present: false };
    }
    return null;
  },
};

const dockerHubProbe: TargetProbe = {
  // We probe Docker Hub via the public tags API. The image name passed in
  // is already the canonical repo path (e.g. "gdigital/mcp-ead-factory") —
  // the caller composes that; here we just hit the tag-list endpoint and
  // pass the tag through as a JQ filter.
  cmd: (repo) => ({
    cmd: 'curl',
    args: ['-sS', '-o', '-', '-w', '\n%{http_code}', `https://hub.docker.com/v2/repositories/${repo}/tags/?page_size=100`],
  }),
  parse: (result) => {
    if (result.exitCode !== 0) return null;
    // curl appended the HTTP status on the final line via -w. Split it off.
    const body = result.stdout;
    const match = body.match(/(.*)\n(\d{3})\s*$/s);
    if (!match) return null;
    const [, payload, statusCode] = match;
    if (statusCode === '404') return { present: false };
    if (statusCode !== '200') return null;
    try {
      const parsed = JSON.parse(payload!) as { results?: Array<{ name: string }> };
      const tags = (parsed.results ?? []).map((t) => t.name);
      // The caller stuffs the desired tag into the MCP-name slot for now —
      // we use a sentinel substring to extract it.
      // A simpler contract: this probe answers "any version present at all?"
      // Callers (Story 3.3) layer the "and is it MY version" check on top.
      if (tags.length === 0) return { present: false };
      // We return the first tag that looks like a semver as the "version".
      const semver = tags.find((t) => /^\d+\.\d+\.\d+/.test(t));
      if (semver !== undefined) return { present: true, version: semver };
      return { present: true, version: tags[0]! };
    } catch {
      return null;
    }
  },
};

const mcpPublisherProbe: TargetProbe = {
  // Hit the MCP Official Registry public API directly. The "MCP name" here
  // is the reverse-DNS name (e.g. "io.github.g-digital-by-Garrigues/mcp-ead-factory").
  cmd: (name) => ({
    cmd: 'curl',
    args: ['-sS', '-o', '-', '-w', '\n%{http_code}', `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(name)}&limit=1`],
  }),
  parse: (result, mcpName) => {
    if (result.exitCode !== 0) return null;
    const match = result.stdout.match(/(.*)\n(\d{3})\s*$/s);
    if (!match) return null;
    const [, payload, statusCode] = match;
    if (statusCode === '404') return { present: false };
    if (statusCode !== '200') return null;
    try {
      const parsed = JSON.parse(payload!) as {
        servers?: Array<{ name: string; version?: string; version_detail?: { version?: string } }>;
      };
      const exact = (parsed.servers ?? []).find((s) => s.name === mcpName);
      if (!exact) return { present: false };
      const version = exact.version_detail?.version ?? exact.version;
      if (!version) return { present: false };
      return { present: true, version };
    } catch {
      return null;
    }
  },
};

const PROBES: Record<CheckTargetName, TargetProbe> = {
  npm: npmProbe,
  'docker-hub': dockerHubProbe,
  'mcp-publisher': mcpPublisherProbe,
};

function defaultExec(cmd: string, args: readonly string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', (err) => {
      resolve({ stdout, stderr: `${stderr}\n${(err as Error).message}`, exitCode: -1 });
    });
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function checkTargetVersion(
  target: CheckTargetName,
  mcpName: string,
  options: CheckOptions = {},
): Promise<CheckTargetVersionResult> {
  const probe = PROBES[target];
  if (!probe) {
    return {
      status: 'error',
      version: null,
      attempts: 0,
      error: { message: `unknown target: ${target}` },
    };
  }

  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const maxAttempts = delays.length;
  const sleep = options.sleep ?? defaultSleep;
  const exec = options.exec ?? defaultExec;

  let lastStderr = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { cmd, args } = probe.cmd(mcpName);
    const result = await exec(cmd, args);
    lastStderr = result.stderr;
    const parsed = probe.parse(result, mcpName);
    if (parsed === null) {
      // Transient — wait the configured delay (unless this is the final
      // attempt, in which case we drop out and return an error).
      if (attempt < maxAttempts) {
        await sleep(delays[attempt - 1]!);
        continue;
      }
      return {
        status: 'error',
        version: null,
        attempts: attempt,
        error: {
          message: `check-target-version for ${target}:${mcpName} failed after ${attempt} attempts`,
          lastStderr,
        },
      };
    }
    if (parsed.present) {
      return { status: 'present', version: parsed.version, attempts: attempt };
    }
    return { status: 'absent', version: null, attempts: attempt };
  }
  // Unreachable — the loop always returns. Defensive fallback.
  return {
    status: 'error',
    version: null,
    attempts: maxAttempts,
    error: { message: `check-target-version exited the retry loop unexpectedly`, lastStderr },
  };
}
