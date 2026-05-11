import { describe, expect, it } from 'vitest';
import { aggregateErrorReports } from '../../../src/ci/aggregate-error-reports.js';
import { errorReportSchema } from '../../../src/schemas/error-report.schema.js';

const LAYER_1_PASS = JSON.stringify({
  passed: true,
  mcpName: 'ead-factory',
  checks: [],
  errors: [],
  log: { event: 'gate.layer_1_passed', pipeline_run_id: 'run-1' },
});

const LAYER_2_FAIL = JSON.stringify({
  passed: false,
  mcpName: 'ead-factory',
  tools_checked: ['echo'],
  errors: [
    {
      stage: 'gate',
      layer: 2,
      target: null,
      check: 'tools_call_probe',
      observation: "Tool 'echo' tools/call returned -32601.",
      cause: 'Handler not registered (typo in mcp.tool() call?).',
      action: 'Open src/server.ts and verify mcp.tool("echo", ...) registration.',
      source_path: 'src/server.ts',
    },
  ],
  log: { event: 'gate.layer_2_failed', pipeline_run_id: 'run-1' },
});

const LAYER_3_FAIL = JSON.stringify({
  passed: false,
  mcpName: 'ead-factory',
  checks_run: ['npm_build'],
  errors: [
    {
      stage: 'gate',
      layer: 3,
      target: null,
      check: 'npm_build',
      observation: "src/server.ts(42,10): error TS2322.",
      cause: 'The MCP source has TypeScript errors that prevent the build from completing.',
      action: "Fix TypeScript build errors locally with 'npm run build' and push a fix commit, then re-run.",
    },
  ],
  log: { event: 'gate.layer_3_failed', pipeline_run_id: 'run-1' },
});

describe('aggregateErrorReports', () => {
  it('merges errors from multiple gate reports into a single ordered list', () => {
    const aggregated = aggregateErrorReports({
      inputs: [
        { path: 'gate-layer-1.json', raw: LAYER_1_PASS },
        { path: 'gate-layer-2.json', raw: LAYER_2_FAIL },
        { path: 'gate-layer-3.json', raw: LAYER_3_FAIL },
      ],
      pipelineRunId: 'run-1',
    });
    expect(aggregated.pipeline_run_id).toBe('run-1');
    expect(aggregated.mcpName).toBe('ead-factory');
    expect(aggregated.has_failures).toBe(true);
    expect(aggregated.errors).toHaveLength(2);
    expect(aggregated.errors.map((e) => e.layer)).toEqual([2, 3]);
    expect(aggregated.source_reports.map((s) => ({ passed: s.passed, count: s.error_count }))).toEqual([
      { passed: true, count: 0 },
      { passed: false, count: 1 },
      { passed: false, count: 1 },
    ]);
  });

  it('every aggregated error validates against errorReportSchema', () => {
    const aggregated = aggregateErrorReports({
      inputs: [
        { path: 'gate-layer-2.json', raw: LAYER_2_FAIL },
        { path: 'gate-layer-3.json', raw: LAYER_3_FAIL },
      ],
      pipelineRunId: 'run-1',
    });
    for (const err of aggregated.errors) {
      const parsed = errorReportSchema.safeParse(err);
      expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    }
  });

  it('has_failures=false when every input passes (no errors collected)', () => {
    const aggregated = aggregateErrorReports({
      inputs: [{ path: 'gate-layer-1.json', raw: LAYER_1_PASS }],
      pipelineRunId: 'run-1',
    });
    expect(aggregated.has_failures).toBe(false);
    expect(aggregated.errors).toEqual([]);
  });

  it('throws when an input file is not valid JSON', () => {
    expect(() =>
      aggregateErrorReports({
        inputs: [{ path: 'bad.json', raw: '{ not json' }],
        pipelineRunId: 'run-1',
      }),
    ).toThrow(/not valid JSON/);
  });

  it('throws when an embedded error does not match errorReportSchema', () => {
    const malformed = JSON.stringify({
      passed: false,
      errors: [{ stage: 'gate', check: 'missing-fields' }],
    });
    expect(() =>
      aggregateErrorReports({
        inputs: [{ path: 'bad.json', raw: malformed }],
        pipelineRunId: 'run-1',
      }),
    ).toThrow(/errorReportSchema/);
  });
});
