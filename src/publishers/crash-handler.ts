// Defensive last-resort error handler for publisher CLI shims. Each
// run-publish-*.ts script calls `runWithCrashHandler(target, main)` so
// that if anything in main() (or even outside it) throws an error before
// the publisher writes its final PublisherOutput JSON to stdout, we:
//
//   1. Print the stack trace to stderr (visible in the GH Actions job log).
//   2. Emit a PublisherOutputSchema-compatible failed JSON to stdout so
//      the composite action's `> result.json` redirect still captures
//      something the final-report aggregator can parse.
//   3. Exit with code 1.
//
// We install THREE layers of defense:
//   - process.on('uncaughtException')  — catches synchronous throws that
//     bubble up to the event loop (e.g., a require/import-time error).
//   - process.on('unhandledRejection') — catches Promise rejections that
//     never had a .catch attached (e.g., a fire-and-forget await inside
//     the publisher).
//   - .then(...).catch(...) on main()  — catches rejections of main()
//     itself; lets us exit with main()'s return code on success.
//
// Why all three: the v1.0.1 run #25866440574 showed that a single
// `.catch` on main() didn't surface the crash — the failure was reaching
// the event loop through a path that bypassed main's promise chain.
// The v1.0.2 run #25869794563 added the listeners and finally captured
// the real stack trace. PR #64 originally inlined this pattern in
// run-publish-docker-mcp-catalog.ts; this helper extracts it for the
// other 6 publisher runners.

import process from 'node:process';

import { parseDryRunFlag } from '../ci/dry-run.js';

function emitCrash(target: string, kind: 'uncaughtException' | 'unhandledRejection' | 'mainRejected', err: unknown): void {
  const stack = err instanceof Error ? err.stack ?? err.message : String(err);
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[run-publish-${target}] ${kind}:\n${stack}\n`);
  const failed = {
    target,
    status: 'failed' as const,
    target_url: `https://example.invalid/crashed/${encodeURIComponent(target)}`,
    version_published: null,
    duration_ms: 0,
    attempts: 1,
    dry_run: parseDryRunFlag(process.env.INPUT_DRY_RUN),
    error: {
      message: `Publisher crashed via ${kind}: ${message}`,
      cause: `Uncaught error or unhandled promise rejection in the ${target} publisher.`,
      action:
        'Inspect the stack trace on stderr above; fix the failing await/throw. If the crash is environmental (gh CLI / network), retry; otherwise file a pipeline bug.',
    },
  };
  process.stdout.write(JSON.stringify(failed) + '\n');
}

export function runWithCrashHandler(
  target: string,
  main: () => Promise<number>,
): void {
  // Layer 1+2: process-level listeners catch anything that escapes main's
  // promise chain — including errors thrown during a different event-loop
  // tick than the one main was awaiting on.
  process.on('uncaughtException', (err) => {
    emitCrash(target, 'uncaughtException', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    emitCrash(target, 'unhandledRejection', err);
    process.exit(1);
  });

  // Layer 3: explicit .then/.catch on main lets us preserve the exit code
  // returned by main on the happy path, and gives a final safety net for
  // rejections that somehow bypass the unhandledRejection listener.
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      emitCrash(target, 'mainRejected', err);
      process.exit(1);
    });
}
