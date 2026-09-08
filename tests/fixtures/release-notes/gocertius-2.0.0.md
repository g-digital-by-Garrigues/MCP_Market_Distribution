# GoCertius MCP v2.0.0

Breaking. Read this before upgrading.

## The credential changed

`MCP_AUTH_EMAIL`, `MCP_AUTH_PASSWORD` and `MCP_AUTH_JWT` are gone. There is now one
upstream credential: a long-lived **user key**, which the server exchanges
automatically for a short-lived session token. Two variables are mandatory:

| Variable | Secret | Notes |
|---|---|---|
| `MCP_AUTH_USER_KEY` | yes | Your long-lived GoCertius user key. |
| `MCP_API_BASE_URL` | no | Required. The key exchange has no built-in host, so the server will not start without it. |

`MCP_SVC_INTROSPECT_URL` / `MCP_SVC_CLIENT_ID` / `MCP_SVC_CLIENT_SECRET` are unchanged,
and they are **not** credentials: they verify the tokens *your own* callers present
when you host this server over HTTP. Leave them empty for local (stdio) use.

Upgrade without migrating and the server still starts — a retired variable is simply
unknown to it — while every tool that needs authentication answers:

> Configure authentication before calling this tool — … a user key (MCP_AUTH_USER_KEY), then retry.

## More tools

62 tools, up from 41.

## Upgrading the n8n connector

<!-- N8N_UPGRADE -->
**Re-create the credential — editing the existing one is not enough.** The credential
form changed shape. It now has exactly two required fields:

| Field | Value |
|---|---|
| **API Base URL** (`MCP_API_BASE_URL`) | The GoCertius API root you connect to. No longer optional. |
| **User Key** (`MCP_AUTH_USER_KEY`) | Your long-lived user key. Replaces the e-mail/password pair. |

Delete the old GoCertius API credential, create a new one, and re-select it on every
node that used it. Saved workflows keep working once the new credential is selected.

**58 operations, up from 39.** Every operation that existed before keeps its name and
its inputs; the new ones are additions.

**The two one-call notification helpers are not in the connector.** They carry no REST
annotation upstream, so they are absent by design — chain the individual notification
steps instead. All of those are present.
<!-- /N8N_UPGRADE -->
