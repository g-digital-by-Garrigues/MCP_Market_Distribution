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
**If you already sign in with a User Key, there is nothing to do.** The credential type
itself has not changed — it keeps its name, and the **API Base URL** and **User Key**
fields keep theirs along with the values you already stored. Saved workflows keep
running, and nothing has to be re-selected.

**If you sign in with an e-mail and password, that pair is gone.** Password sign-in now
requires 2FA / biometric verification, which cannot complete in an unattended workflow,
so no version of this connector can keep it working. Open the **GoCertius API**
credential, fill in **User Key**, and save. Editing the credential in place is enough:
you do not need to delete it, and you do not need to touch the nodes that use it.

Both remaining fields are now required:

| Field | Value |
|---|---|
| **API Base URL** (`MCP_API_BASE_URL`) | The GoCertius API root you connect to. No longer optional. |
| **User Key** (`MCP_AUTH_USER_KEY`) | Your long-lived user key. Replaces the e-mail/password pair. |

**58 operations, up from 39.** Every operation that existed before keeps its name and
its inputs; the new ones are additions.

**The two one-call notification helpers are not in the connector.** They carry no REST
annotation upstream, so they are absent by design — chain the individual notification
steps instead. All of those are present.
<!-- /N8N_UPGRADE -->
