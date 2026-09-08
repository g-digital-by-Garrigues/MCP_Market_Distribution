# Docker MCP Catalog — credentials submission runbook

Operator-facing runbook for the **Google form** step the Docker MCP Catalog requires for any MCP that needs test credentials.

## When this matters

Every MCP in the Docker MCP Catalog that needs auth credentials to function (which is all three of ours: `ead-factory`, `gocertius`, `ead-enterprise-suite`) must have **test credentials shared with the Docker maintainers via a Google form** alongside the PR. Without that, maintainers cannot validate the submission and the PR sits indefinitely.

The form URL is documented in [Docker MCP Registry's CONTRIBUTING.md](https://github.com/docker/mcp-registry/blob/main/CONTRIBUTING.md):

> https://forms.gle/6Lw3nsvu2d6nFg8e6

This is referenced in the PR body our pipeline now renders ([`templates/store-descriptions/docker-mcp-catalog/pr-body.hbs`](../../templates/store-descriptions/docker-mcp-catalog/pr-body.hbs)) — the checkbox `Test credentials shared via this form` is ticked by default. **Make the claim true** by submitting the form once per server.

## When to submit the form

- **Within 24 hours of opening a fresh PR** (or shortly after). Maintainers triage in batches; a freshly-opened PR with the credentials already linked-in-form gets reviewed faster than one that waits.
- **Whenever the test credentials rotate.** If a credential changes (user key re-issued, OAuth client secret rotated), resubmit the form referencing the same server name. The catalog team will reach out via the email you provide.

## What to put in each form field

The form has changed over time; what follows is the field-by-field guidance as of 2026-05-26. Confirm by reading the form before filling. If field shape changes, update this runbook.

### Per MCP — one form submission per server

| Field | Value |
|---|---|
| Your name | Real-human name on the submitter's GitHub profile (the maintainers cross-check) |
| Your email | A real Garrigues human email, NOT a `+bot@` alias — the maintainer may reply to follow up |
| GitHub PR URL | The URL of the OPEN PR on `docker/mcp-registry` for this server |
| Server name | Match `server.yaml#name` exactly (kebab-case): `ead-factory`, `gocertius`, `ead-enterprise-suite` |
| Test credentials | The `config.env` block of the **rendered** `server.yaml` for this server, filled in with sandbox values. Derive it; do not copy a list out of this runbook — see below |
| Notes for the reviewer | How to invoke the MCP for a smoke test (e.g., the `task validate` command from our PR body) and any non-obvious "test this tool first" guidance |

### Which credentials to submit — derive them, do not copy a list

**The set to submit is the `config.env` entries of the *rendered* `server.yaml` for that server.** Render it (or read the one the publisher committed) and submit every entry the reviewer must fill in. The chain behind that field is worth knowing, because it is why a hardcoded list in a runbook goes stale — this one has now gone stale twice:

`.env.example` (generator-owned, in the MCP source repo) → `server.json#packages[0].environmentVariables` → `config.env[]` in the rendered `server.yaml` (`src/publishers/publish-docker-mcp-catalog.ts:137-179`; `templates/store-descriptions/docker-mcp-catalog/server.yaml.hbs:12-20`). The template renders `config.description` and `config.env[]` with `name` / `example` / `description`, and has **no** `config.secrets` key.

The emitted `.env.example` also annotates every variable with `# isSecret:` and `# isRequired:`. Those tell you which values must be handled as secrets and which the reviewer cannot leave blank.

> **On `gocertius` and `ead-enterprise-suite`, do NOT supply `MCP_SVC_INTROSPECT_URL` / `MCP_SVC_CLIENT_ID` / `MCP_SVC_CLIENT_SECRET`.** On those two products that trio configures the server's **inbound** Bearer verification for HTTP hosting and authenticates nothing upstream (`GoCertius_MCP:.env.example:13-29`); a smoke test needs none of it. On `ead-factory` the same-looking `MCP_SVC_*` names are the **outbound** service-account credential and are exactly what the reviewer needs. Same names, opposite meaning — this is how a copy-paste error happens.

#### Worked example (verified 2026-09-07 against each repo's `origin/main` `.env.example` — re-derive before submitting)

| Server | Variable | Secret? | Required? |
|---|---|---|---|
| `gocertius`, `ead-enterprise-suite` | `MCP_AUTH_USER_KEY` | yes | yes |
| `gocertius`, `ead-enterprise-suite` | `MCP_API_BASE_URL` | **no** | yes |
| `ead-factory` | `MCP_SVC_TOKEN_URL` | no | yes |
| `ead-factory` | `MCP_SVC_CLIENT_ID` | no | yes |
| `ead-factory` | `MCP_SVC_CLIENT_SECRET` | yes | yes |
| `ead-factory` | `MCP_SVC_SCOPE` | no | optional |
| `ead-factory` | `MCP_API_BASE_URL` | no | optional |

`gocertius` and `ead-enterprise-suite` take a **single** upstream credential: a long-lived user key, exchanged automatically for a short-lived session token. `ead-factory` uses an OAuth2 `client_credentials` service account (Okta is one configured instance of it, not the protocol).

Sandbox / non-prod values only — never a production key, never a real customer tenant.

## Post-submission

1. **Comment on the PR**: a short "Credentials submitted via the Google Form" note so the maintainer sees confirmation without needing to ask. Example:
   > Test credentials submitted via the Google form (sandbox tenant) on 2026-MM-DD. Happy to address review feedback.
2. **Rotate the sandbox credentials AFTER review concludes** (or sooner if they're shared more broadly). Re-issue the test user key / rotate the OAuth client secret and stop sharing the old set.
3. **Track the rotation** in `docs/runbooks/bot-pat-rotation.md` (or its successor) so we don't accumulate dormant test credentials with broad knowledge.

## What if there's no public sandbox?

Use a dedicated **review-only tenant** that:
- Has access only to test data (no real customer data ever)
- Is auto-expired after 60 days (or manually rotated post-review)
- Is logged as `make-review-tenant-<date>` in our audit log

If creating a review-only tenant is too heavy: scope a single-purpose test account with read-only grants on a synthetic dataset. **Never share production credentials.**

## Linked runbooks

- [`release-checklist.md`](release-checklist.md) — the full pre-release process (the Docker catalog submission is a downstream consumer of a release)
- [`bot-pat-rotation.md`](bot-pat-rotation.md) — the rotation runbook for the bot PAT used by the publisher

## See also

- [Docker MCP Registry CONTRIBUTING.md](https://github.com/docker/mcp-registry/blob/main/CONTRIBUTING.md)
- [2026-05-26 submission patterns audit](../../_bmad-output/research/mcp-submission-patterns-audit-2026-05-26.md) — surfaced that we were ticking the Google-form checkbox in the PR body without actually submitting the form. Closing that gap is the operator side of the PR template fix.
