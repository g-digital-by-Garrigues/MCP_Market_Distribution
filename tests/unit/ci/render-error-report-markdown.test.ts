import { describe, expect, it } from 'vitest';
import { renderErrorReportMarkdown } from '../../../src/ci/render-error-report-markdown.js';
import type { AggregatedErrorReport } from '../../../src/ci/aggregate-error-reports.js';

const REPORT: AggregatedErrorReport = {
  pipeline_run_id: 'run-42',
  mcpName: 'ead-factory',
  has_failures: true,
  source_reports: [
    { path: 'gate-layer-1.json', passed: true, error_count: 0 },
    { path: 'gate-layer-2.json', passed: false, error_count: 1 },
  ],
  errors: [
    {
      stage: 'gate',
      layer: 2,
      target: null,
      check: 'tools_call_probe',
      observation: "Tool 'echo' returned -32601.",
      cause: 'Handler not registered.',
      action: 'Open src/server.ts and verify the registration.',
      source_path: 'src/server.ts',
    },
  ],
};

describe('renderErrorReportMarkdown', () => {
  it('includes the marker comment, header, MCP, and pipeline_run_id', () => {
    const md = renderErrorReportMarkdown({ aggregated: REPORT });
    expect(md).toContain('<!-- error-report:run-42 -->');
    expect(md).toContain('## ❌ Pipeline gate failed');
    expect(md).toContain('`ead-factory`');
    expect(md).toContain('`run-42`');
  });

  it('renders each error with the structured fields (stage, layer, check, observation, cause, action)', () => {
    const md = renderErrorReportMarkdown({ aggregated: REPORT });
    expect(md).toContain('### gate · Layer 2 · `tools_call_probe`');
    expect(md).toContain('**Observation:** Tool \'echo\' returned -32601.');
    expect(md).toContain('**Cause:** Handler not registered.');
    expect(md).toContain('**Action:** Open src/server.ts and verify the registration.');
    expect(md).toContain('**Source:** `src/server.ts`');
  });

  it('renders the workflow run URL when provided', () => {
    const md = renderErrorReportMarkdown({
      aggregated: REPORT,
      workflowRunUrl: 'https://github.com/foo/bar/actions/runs/123',
    });
    expect(md).toContain('https://github.com/foo/bar/actions/runs/123');
  });

  it('emits a fallback note when there are no structured errors (e.g., gate crashed before emitting)', () => {
    const md = renderErrorReportMarkdown({
      aggregated: { ...REPORT, has_failures: false, errors: [] },
    });
    expect(md).toContain('No structured errors were emitted');
  });

  it('renders publisher target headings when layer is null and target is set', () => {
    const md = renderErrorReportMarkdown({
      aggregated: {
        ...REPORT,
        errors: [
          {
            stage: 'publish',
            layer: null,
            target: 'smithery',
            check: 'deploy_verify',
            observation: 'Smithery did not reach v1.0.0 within 15 min.',
            cause: 'Smithery deploy queued or stuck.',
            action: 'Check the Smithery dashboard manually.',
          },
        ],
      },
    });
    expect(md).toContain('### publish · target `smithery` · `deploy_verify`');
  });
});
