import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runTrackBLayer1 } from '../../src/gates/run-track-b-layer-1.js';
import { generateN8nNode } from '../../src/adapters/n8n-adapter/generate-n8n-node.js';
import { normalizeGeneratedNode } from '../../src/adapters/n8n-adapter/normalize-generated-node.js';
import type { N8nNodeSpec } from '../../src/adapters/n8n-adapter/types.js';

function sampleSpec(): N8nNodeSpec {
  return {
    packageName: '@g-digital/n8n-nodes-multi-tool',
    sourceMcpPackageName: '@g-digital/mcp-multi-tool',
    version: '1.0.0',
    className: 'MultiTool',
    displayName: 'Multi Tool',
    description: 'A test multi-tool MCP node.',
    nodeName: 'multi-tool',
    paramName: 'multiTool',
    resourceDisplayName: 'Multi Tool',
    credentialClassName: 'MultiToolApi',
    credentialParamName: 'multiToolApi',
    sourceRepoUrl: 'https://github.com/test/test-mcp',
    author: { name: 'g-digital by Garrigues', email: 'g-digital@garrigues.com' },
    authStyle: 'email-password',
    // n8n requires an icon on BOTH the node and the credential class
    // (@n8n/community-nodes/icon-validation, cred-class-field-icon-missing). Every
    // real product bundles its logo, so the fixture must too — a spec with
    // iconBundled unset generates a node the official linter rejects, which is the
    // gate working, not a fixture quirk.
    iconBundled: true,
    // Every product ships SVG since Epic 17 / P3, and `node-class-description-icon-not-svg`
    // is no longer allowlisted in the gate — a PNG fixture would now (correctly) fail.
    iconFile: 'icon.svg',
    defaultApiBaseUrl: '',
    credentialAcquisitionUrl: '',
    operations: [
      {
        name: 'get_widget',
        displayName: 'Get Widget',
        description: 'Fetch a widget by id.',
        httpMethod: 'GET',
        httpUrlTemplate: '/widgets/{widget_id}',
        properties: [
          {
            name: 'widget_id',
            displayName: 'Widget Id',
            type: 'string',
            default: '',
            required: true,
            showForOperation: 'get_widget',
          },
        ],
      },
      {
        name: 'list_widgets',
        displayName: 'List Widgets',
        description: 'List widgets.',
        httpMethod: 'GET',
        httpUrlTemplate: '/widgets',
        properties: [],
      },
    ],
    credentials: [
      { envName: 'MCP_AUTH_EMAIL', propName: 'email', displayName: 'Auth Email', isSecret: false },
      { envName: 'MCP_AUTH_PASSWORD', propName: 'password', displayName: 'Auth Password', isSecret: true },
    ],
  };
}

/** Minimal valid SVG — stands in for the product logo the real builds copy in. */
const TINY_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>\n',
  'utf8',
);

/** Smallest valid PNG — used only to prove the gate now rejects a raster icon. */
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Run a block with NODE_ENV unset.
 *
 * eslint-plugin-n8n-nodes-base changes behaviour when NODE_ENV === 'test': its
 * `getNodeFilename()` returns a hardcoded "Test.node.ts" instead of reading the real
 * path, which makes the trigger-node rules match and rename the node to
 * "<Name>Trigger". Vitest sets NODE_ENV=test, so linting inside a test lints a
 * fiction. The pipeline never runs under NODE_ENV=test, so this restores production
 * conditions rather than working around a rule.
 */
async function withProductionNodeEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    return await fn();
  } finally {
    if (previous !== undefined) process.env.NODE_ENV = previous;
  }
}

describe('Track B — Layer 1 (structural lint)', () => {
  let nodeDir: string;
  let logoPath: string;
  beforeEach(async () => {
    nodeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'track-b-l1-'));
    logoPath = path.join(nodeDir, '..', `logo-${path.basename(nodeDir)}.svg`);
    await fs.writeFile(logoPath, TINY_SVG);
  });
  afterEach(async () => {
    await fs.rm(nodeDir, { recursive: true, force: true });
    await fs.rm(logoPath, { force: true });
  });

  it('happy path: passes every check against a freshly generated node tree', async () => {
    const spec = sampleSpec();
    await generateN8nNode({ spec, outputDir: nodeDir, sourceLogoAbsPath: logoPath });
    // Mirror run-adapter-build: the official linter is a real check now (Story 15.1
    // — it used to pass by catching its own import failure), and production always
    // normalizes before the gate runs. Skipping this here would test a tree that is
    // never shipped.
    const result = await withProductionNodeEnv(async () => {
      await normalizeGeneratedNode(nodeDir);
      return runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    });
    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.log.event).toBe('gate.track_b_layer_1_passed');
  });

  it('BLOCKS a raster icon — node-class-description-icon-not-svg is no longer allowlisted', async () => {
    // The allowlist used to tolerate this rule ("we ship PNG and have no SVG artwork").
    // Both halves stopped being true on 2026-07-22, and a stale entry is not harmless:
    // shipping PNG is precisely what got gocertius and ead-enterprise-suite bounced by
    // the n8n reviewers. Prove the gate now catches a regression back to raster.
    const pngLogo = path.join(nodeDir, '..', `logo-raster-${path.basename(nodeDir)}.png`);
    await fs.writeFile(pngLogo, ONE_PX_PNG);
    try {
      const spec = { ...sampleSpec(), iconFile: 'icon.png' };
      await generateN8nNode({ spec, outputDir: nodeDir, sourceLogoAbsPath: pngLogo });
      const result = await withProductionNodeEnv(async () => {
        await normalizeGeneratedNode(nodeDir);
        return runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
      });
      const linter = result.checks.find((c) => c.name === 'official_linter');
      expect(linter?.passed).toBe(false);
      expect(linter?.error?.observation ?? '').toContain(
        'n8n-nodes-base/node-class-description-icon-not-svg',
      );
      expect(result.passed).toBe(false);
    } finally {
      await fs.rm(pngLogo, { force: true });
    }
  });

  it('runs the official linter when handed a RELATIVE nodeDir (the pipeline always does)', async () => {
    // Regression: the gate passed nodeDir straight to the scanner, which hands it to
    // ESLint as `cwd` — and ESLint rejects a relative path ("'cwd' must be an absolute
    // path"). Every local run used an absolute path, so this only surfaced in CI, on a
    // real publish: gocertius v1.5.0 shipped its MCP server to every store while the
    // n8n node failed this gate.
    const spec = sampleSpec();
    await generateN8nNode({ spec, outputDir: nodeDir, sourceLogoAbsPath: logoPath });
    const relativeNodeDir = path.relative(process.cwd(), nodeDir);
    expect(path.isAbsolute(relativeNodeDir)).toBe(false);
    const result = await withProductionNodeEnv(async () => {
      await normalizeGeneratedNode(relativeNodeDir);
      return runTrackBLayer1({ mcpName: 'multi-tool', nodeDir: relativeNodeDir, spec });
    });
    const linter = result.checks.find((c) => c.name === 'official_linter');
    expect(linter?.error?.observation ?? '').not.toContain('absolute path');
    expect(linter?.passed).toBe(true);
  });

  it('fails file_layout when a generated file is missing', async () => {
    const spec = sampleSpec();
    await generateN8nNode({ spec, outputDir: nodeDir, sourceLogoAbsPath: logoPath });
    await fs.rm(path.join(nodeDir, 'index.ts'));
    const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    expect(result.passed).toBe(false);
    const layoutError = result.errors.find((e) => e.check === 'file_layout');
    expect(layoutError).toBeDefined();
    expect(layoutError!.observation).toContain('index.ts');
    expect(layoutError!.stage).toBe('gate');
    expect(layoutError!.layer).toBe(1);
    expect(layoutError!.target).toBe('n8n');
  });

  // Story 12.2 (Epic 12): REST-direct architecture — new gate behaviors
  it('fails package_json when source-MCP appears in devDependencies (REST-direct: not bundled)', async () => {
    const spec = sampleSpec();
    await generateN8nNode({ spec, outputDir: nodeDir, sourceLogoAbsPath: logoPath });
    const pkgPath = path.join(nodeDir, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    // Simulate old-architecture artifact: source MCP accidentally in devDeps
    pkg.devDependencies[spec.sourceMcpPackageName] = '1.0.0';
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
    const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    expect(result.passed).toBe(false);
    const pkgError = result.errors.find((e) => e.check === 'package_json');
    expect(pkgError).toBeDefined();
    expect(pkgError!.observation).toContain('must NOT include');
    expect(pkgError!.observation).toContain(spec.sourceMcpPackageName);
  });

  it('accepts a file:./<tarball>.tgz source-MCP dep when .adapter-build.json signals dry-run substitution', async () => {
    // Regression guard: dry-run mode previously rewrote the source-MCP
    // dep to a file: URL. In REST-direct, this path should no longer
    // exist — the gate should PASS if no source-MCP dep is present at all
    // (which is what the generator now produces).
    const spec = sampleSpec();
    await generateN8nNode({ spec, outputDir: nodeDir, sourceLogoAbsPath: logoPath });
    // Don't inject any sourceMcpPackageName dep — the generator no longer adds it.
    await fs.writeFile(
      path.join(nodeDir, '.adapter-build.json'),
      JSON.stringify({ dry_run: true, source_substituted: true }),
    );
    const result = await withProductionNodeEnv(async () => {
      await normalizeGeneratedNode(nodeDir);
      return runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    });
    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails node_class when the usableAsTool flag is missing (Story 5.8 regression)", async () => {
    // Without `usableAsTool: true` n8n's CLI does NOT auto-generate the
    // virtual `<Name>Tool` sibling, so the node is invisible to AI Agent
    // nodes. Simulate a template drift that drops the flag — Layer 1
    // must catch it before publish.
    const spec = sampleSpec();
    await generateN8nNode({ spec, outputDir: nodeDir, sourceLogoAbsPath: logoPath });
    const nodePath = path.join(nodeDir, 'nodes', 'MultiTool', 'MultiTool.node.ts');
    const original = await fs.readFile(nodePath, 'utf8');
    const tampered = original.replace(/usableAsTool: true,?\s*\n/, '');
    await fs.writeFile(nodePath, tampered);
    const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    expect(result.passed).toBe(false);
    const nodeError = result.errors.find((e) => e.check === 'node_class');
    expect(nodeError).toBeDefined();
    expect(nodeError!.observation).toContain('usableAsTool');
  });

  it("fails node_class when an operation is missing from OPERATION_PROPERTY_NAMES", async () => {
    const spec = sampleSpec();
    await generateN8nNode({ spec, outputDir: nodeDir, sourceLogoAbsPath: logoPath });
    // Surgically strip get_widget from the OPERATION_PROPERTY_NAMES table
    // (and the dropdown, just to amplify) to simulate a template drift bug.
    const nodePath = path.join(nodeDir, 'nodes', 'MultiTool', 'MultiTool.node.ts');
    const original = await fs.readFile(nodePath, 'utf8');
    const tampered = original
      .replace(/'get_widget':[^\n]*\n/, '')
      .replace(/value: 'get_widget',?/g, '');
    await fs.writeFile(nodePath, tampered);
    const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    expect(result.passed).toBe(false);
    const nodeError = result.errors.find((e) => e.check === 'node_class');
    expect(nodeError).toBeDefined();
    expect(nodeError!.observation).toContain("get_widget");
  });

  it('fails credentials when one of the spec env vars is absent from the credentials class', async () => {
    const spec = sampleSpec();
    await generateN8nNode({ spec, outputDir: nodeDir, sourceLogoAbsPath: logoPath });
    const credPath = path.join(nodeDir, 'credentials', 'MultiToolApi.credentials.ts');
    const original = await fs.readFile(credPath, 'utf8');
    // The sample fixture has propName: 'email' so the generated file has name: 'email'
    const tampered = original.replace(/name: 'email'/, "name: 'wrongName'");
    await fs.writeFile(credPath, tampered);
    const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    expect(result.passed).toBe(false);
    const credError = result.errors.find((e) => e.check === 'credentials');
    expect(credError).toBeDefined();
    expect(credError!.observation).toContain('email');
  });

  it('fails readme when an operation is not mentioned in the README', async () => {
    const spec = sampleSpec();
    await generateN8nNode({ spec, outputDir: nodeDir, sourceLogoAbsPath: logoPath });
    const readmePath = path.join(nodeDir, 'README.md');
    const original = await fs.readFile(readmePath, 'utf8');
    // Replace ALL get_widget mentions (table row AND any other reference).
    const tampered = original.replace(/`get_widget`/g, '`removed_widget`');
    await fs.writeFile(readmePath, tampered);
    const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    expect(result.passed).toBe(false);
    const readmeError = result.errors.find((e) => e.check === 'readme');
    expect(readmeError).toBeDefined();
    expect(readmeError!.observation).toContain('get_widget');
  });

  it('emits log.event = track_b_layer_1_failed when any check fails', async () => {
    const spec = sampleSpec();
    // No files generated — every check fails.
    const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    expect(result.passed).toBe(false);
    expect(result.log.event).toBe('gate.track_b_layer_1_failed');
    // All 5 checks should have errored.
    expect(result.errors.length).toBeGreaterThanOrEqual(5);
  });

  it('every emitted ErrorReport carries the canonical Track B shape (stage=gate, layer=1, target=n8n)', async () => {
    const spec = sampleSpec();
    const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    for (const e of result.errors) {
      expect(e.stage).toBe('gate');
      expect(e.layer).toBe(1);
      expect(e.target).toBe('n8n');
      expect(e.check.length).toBeGreaterThan(0);
      expect(e.observation.length).toBeGreaterThan(0);
      expect(e.cause.length).toBeGreaterThan(0);
      expect(e.action.length).toBeGreaterThan(0);
    }
  });

  // The n8n UX compliance gate is the regen guardrail: each case mirrors a real
  // n8n Cloud verification rejection on EAD-ES v1.4.0. These prove the gate
  // CATCHES the violation so a future generator regen can't silently ship it.
  describe('n8n UX compliance gate (regen guardrail)', () => {
    it('fails when an operation shown in the UI is a STUB (issue 1: notification_certificate_get)', async () => {
      const spec = sampleSpec();
      spec.operations.push({
        name: 'notification_certificate_get',
        displayName: 'Get Notification Certificate',
        description: 'Generate a certificate.',
        httpMethod: 'STUB',
        httpUrlTemplate: '',
        isStub: true,
        stubSuffix: ', stub: true',
        properties: [],
      });
      await generateN8nNode({ spec, outputDir: nodeDir, sourceLogoAbsPath: logoPath });
      const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec, skipLinter: true });
      const err = result.errors.find((e) => e.check === 'n8n_ux_compliance');
      expect(err).toBeDefined();
      expect(err!.observation).toContain('notification_certificate_get');
      expect(result.passed).toBe(false);
    });

    it('fails when node displayName uses mis-cased brand token (issue 6: Ead vs EAD)', async () => {
      const spec = sampleSpec();
      spec.displayName = 'Ead Enterprise Suite';
      await generateN8nNode({ spec, outputDir: nodeDir, sourceLogoAbsPath: logoPath });
      const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec, skipLinter: true });
      const err = result.errors.find((e) => e.check === 'n8n_ux_compliance');
      expect(err).toBeDefined();
      expect(err!.observation).toContain('Ead');
    });

    it('fails when the credential exposes MCP transport config (issue 3)', async () => {
      const spec = sampleSpec();
      spec.credentials.push({
        envName: 'MCP_HTTP_HOST', propName: 'mcpHttpHost', displayName: 'Mcp Http Host', isSecret: false,
      });
      await generateN8nNode({ spec, outputDir: nodeDir, sourceLogoAbsPath: logoPath });
      const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec, skipLinter: true });
      const err = result.errors.find((e) => e.check === 'n8n_ux_compliance');
      expect(err).toBeDefined();
      expect(err!.observation).toContain('mcpHttpHost');
    });

    it('fails when a credential prop is not in the node-readable allowlist (any MCP config leak)', async () => {
      const spec = sampleSpec();
      // A leaked field that is NOT one of the transport prefixes — only the
      // allowlist backstop catches it (the recurring [HIGH] class).
      spec.credentials.push({
        envName: 'MCP_OPENID_ISSUER', propName: 'mcpOpenidIssuer', displayName: 'Mcp Openid Issuer', isSecret: false,
      });
      await generateN8nNode({ spec, outputDir: nodeDir, sourceLogoAbsPath: logoPath });
      const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec, skipLinter: true });
      const err = result.errors.find((e) => e.check === 'n8n_ux_compliance');
      expect(err).toBeDefined();
      expect(err!.observation).toContain('mcpOpenidIssuer');
    });

    it('fails when a chat-less node ships chat code (issue 2)', async () => {
      const spec = sampleSpec();
      spec.hasChatCertificateGet = true; // forces chat code into the template output
      // spec.hasChat stays undefined → gate flags the dead code
      await generateN8nNode({ spec, outputDir: nodeDir, sourceLogoAbsPath: logoPath });
      const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec, skipLinter: true });
      const err = result.errors.find((e) => e.check === 'n8n_ux_compliance');
      expect(err).toBeDefined();
      expect(err!.observation).toContain('chat');
    });

    it('fails when a field displayName reads "IDS" instead of "IDs" (issue 5)', async () => {
      const spec = sampleSpec();
      spec.operations[0]!.properties.push({
        name: 'evidence_ids', displayName: 'Evidence IDS', type: 'string', default: '',
        showForOperation: 'get_widget',
      });
      await generateN8nNode({ spec, outputDir: nodeDir, sourceLogoAbsPath: logoPath });
      const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec, skipLinter: true });
      const err = result.errors.find((e) => e.check === 'n8n_ux_compliance');
      expect(err).toBeDefined();
      expect(err!.observation).toContain('IDS');
    });

    it('passes a clean node with no violations', async () => {
      const spec = sampleSpec();
      await generateN8nNode({ spec, outputDir: nodeDir, sourceLogoAbsPath: logoPath });
      const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec, skipLinter: true });
      const uxCheck = result.checks.find((c) => c.name === 'n8n_ux_compliance');
      expect(uxCheck).toBeDefined();
      expect(uxCheck!.passed).toBe(true);
    });
  });
});
