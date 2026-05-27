# Docker MCP Catalog — credentials submission runbook

Operator-facing runbook for the **Google form** step the Docker MCP Catalog requires for any MCP that needs test credentials.

## When this matters

Every MCP in the Docker MCP Catalog that needs auth credentials to function (which is all three of ours: `ead-factory`, `gocertius`, `ead-enterprise-suite`) must have **test credentials shared with the Docker maintainers via a Google form** alongside the PR. Without that, maintainers cannot validate the submission and the PR sits indefinitely.

The form URL is documented in [Docker MCP Registry's CONTRIBUTING.md](https://github.com/docker/mcp-registry/blob/main/CONTRIBUTING.md):

> https://forms.gle/6Lw3nsvu2d6nFg8e6

This is referenced in the PR body our pipeline now renders ([`templates/store-descriptions/docker-mcp-catalog/pr-body.hbs`](../../templates/store-descriptions/docker-mcp-catalog/pr-body.hbs)) — the checkbox `Test credentials shared via this form` is ticked by default. **Make the claim true** by submitting the form once per server.

## When to submit the form

- **Within 24 hours of opening a fresh PR** (or shortly after). Maintainers triage in batches; a freshly-opened PR with the credentials already linked-in-form gets reviewed faster than one that waits.
- **Whenever the test credentials rotate.** If a credential changes (password reset, OAuth client rotated), resubmit the form referencing the same server name. The catalog team will reach out via the email you provide.

## What to put in each form field

The form has changed over time; what follows is the field-by-field guidance as of 2026-05-26. Confirm by reading the form before filling. If field shape changes, update this runbook.

### Per MCP — one form submission per server

| Field | Value |
|---|---|
| Your name | Real-human name on the submitter's GitHub profile (the maintainers cross-check) |
| Your email | A real Garrigues human email, NOT a `+bot@` alias — the maintainer may reply to follow up |
| GitHub PR URL | The URL of the OPEN PR on `docker/mcp-registry` for this server |
| Server name | Match `server.yaml#name` exactly (kebab-case): `ead-factory`, `gocertius`, `ead-enterprise-suite` |
| Test credentials | The env-var block from `server.yaml#config.secrets` rendered with sandbox values. See below per MCP |
| Notes for the reviewer | How to invoke the MCP for a smoke test (e.g., the `task validate` command from our PR body) and any non-obvious "test this tool first" guidance |

### Test credential shapes (sandbox / non-prod values only)

**ead-factory** uses Okta `client_credentials` grant. Submit the following env vars from the sandbox Okta tenant (never production credentials):

```
OKTA_TOKEN_URL=https://<sandbox-okta-tenant>.okta.com/oauth2/<authServer>/v1/token
OKTA_CLIENT_ID=<sandbox-client-id>
OKTA_CLIENT_SECRET=<sandbox-client-secret>
OKTA_SCOPE=token
API_BASE_URL=https://api.int.gcloudfactory.com/digital-trust
SIGNATURE_API_BASE_URL=https://api.int.gcloudfactory.com/signature-manager
```

**gocertius** and **ead-enterprise-suite** use email/password against the sandbox auth server:

```
MCP_AUTH_EMAIL=<sandbox-email-alias>
MCP_AUTH_PASSWORD=<sandbox-password>
```

(or, alternatively, OIDC refresh-token: `MCP_OPENID_ISSUER` + `MCP_OPENID_CLIENT_ID` + `MCP_OPENID_REFRESH_TOKEN`)

## Post-submission

1. **Comment on the PR**: a short "Credentials submitted via the Google Form" note so the maintainer sees confirmation without needing to ask. Example:
   > Test credentials submitted via the Google form (sandbox Okta tenant) on 2026-MM-DD. Happy to address review feedback.
2. **Rotate the sandbox credentials AFTER review concludes** (or sooner if they're shared more broadly). Update the test account password / OAuth secret and stop sharing the old set.
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
