# No-consumer-credentials guard (NFR-S3)

This guard is the automated check that prevents the distribution pipeline from ever reading the credentials that consumers configure for the MCPs we publish — for example the EAD Factory's Okta client secret or the EADTrust API key. Those credentials belong to consumers and are surfaced in published artifacts only as `environmentVariables` metadata + a `credential_help_url`, never as values the pipeline could access.

NFR-S3: _"The pipeline never handles consumer credentials."_

## How it works

`src/ci/audit-consumer-credentials.ts` scans every YAML file under `.github/workflows/` and every composite action source under `actions/` for `${{ secrets.<NAME> }}` references. Each match is classified:

- **Allowed** — `<NAME>` is in `OPERATIONAL_ALLOWLIST` (the secrets the pipeline legitimately needs to publish releases: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, `BOT_PAT`, `NPM_TOKEN`, plus GitHub's built-in `GITHUB_TOKEN`).
- **Forbidden** — `<NAME>` matches either:
  - a consumer-credential prefix (`OKTA_*`), or
  - one of the same suffixes that `.env.example` parsing uses to set `isSecret=true`: `*_SECRET`, `*_TOKEN`, `*_KEY`, `*_PASSWORD`.

Any forbidden match emits a finding with the file path, line, secret name, and the matched pattern. If any findings exist, the audit exits non-zero and the CI job fails.

## CI integration

The `nfr-s3-audit` job in `.github/workflows/publish.yml` invokes the audit on every run. It is gated to **block** the publishers — it sits next to the three Track A gate layers. The job is fast (a few hundred ms) and runs before the gates so engineers see the failure early.

## How to add an operational secret

If a future release needs another secret the pipeline owns (e.g. a Snyk token, a signing key for the npm registry), edit `OPERATIONAL_ALLOWLIST` in `src/ci/audit-consumer-credentials.ts` and add the secret to the repo's GitHub Actions secret store. Justify the addition in the PR description so the security review trail stays clear.

If a per-MCP secret legitimately needs to flow through CI (rare — typically a build-only secret like a private npm registry token), pass `--allow <NAME>` to the CLI or add it to `extraAllowlist` in the calling site. Document why in this runbook.

## What this guard does NOT cover

- **Runtime leaks at consumer install time.** A consumer setting their `OKTA_CLIENT_SECRET` env var on their own machine is a different surface; the guard only enforces that *our* CI never reads it.
- **Custom secret names that bypass the heuristic.** If someone names a consumer credential `MY_SHADY_VALUE` (no `_KEY/_TOKEN/_SECRET/_PASSWORD` suffix and no `OKTA_` prefix), the heuristic won't flag it. The runbook expects engineers to add a custom prefix to forbidden patterns when a new consumer-credential family lands.
- **Secrets in plain code.** A hard-coded API key in a JS file is caught by other tooling (gitleaks etc.); this audit only inspects CI workflow + action sources.

## Re-running the audit locally

```
pnpm tsx src/ci/audit-consumer-credentials.ts
```

Exits 0 if clean, non-zero with a JSON findings list if anything matches. The same CLI runs in CI.
