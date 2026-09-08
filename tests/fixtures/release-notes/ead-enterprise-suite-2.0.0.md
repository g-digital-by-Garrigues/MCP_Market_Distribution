# EAD Enterprise Suite MCP v2.0.0

Breaking. Read this before upgrading. There are two independent breaks — the
credential, and two re-pointed signature operations. Neither one implies the other.

## The credential changed

`MCP_AUTH_EMAIL`, `MCP_AUTH_PASSWORD` and `MCP_AUTH_JWT` are gone. There is now one
upstream credential: a long-lived **user key**, which the server exchanges
automatically for a short-lived session token. Two variables are mandatory:

| Variable | Secret | Notes |
|---|---|---|
| `MCP_AUTH_USER_KEY` | yes | Your long-lived EAD Enterprise Suite user key. |
| `MCP_API_BASE_URL` | no | Required. The key exchange has no built-in host, so the server will not start without it. |

`MCP_SVC_INTROSPECT_URL` / `MCP_SVC_CLIENT_ID` / `MCP_SVC_CLIENT_SECRET` are unchanged,
and they are **not** credentials: they verify the tokens *your own* callers present
when you host this server over HTTP. Leave them empty for local (stdio) use.

Upgrade without migrating and the server still starts — a retired variable is simply
unknown to it — while every tool that needs authentication answers:

> Configure authentication before calling this tool — … a user key (MCP_AUTH_USER_KEY), then retry.

## Two signature operations now call a different endpoint

Same names, different upstream operation, different inputs. This is not a rename you
can ignore: both lost the document identifier they used to take as a path parameter,
so anything that fed one of them is broken, not merely different.

| Tool | Used to return | Now returns | What used to happen lives in |
|---|---|---|---|
| `signature_document_list` | the signatories of one document | the documents of a signature request | `signature_document_signatory_list` |
| `signature_participant_list` | the observers of one document | the participants of a signature request | `signature_document_observer_list` |

Both replacements are new in this release and take the same inputs the old versions
took, including the document identifier. If you want the old behaviour, switch to the
replacement; if you want a request-level list, keep the name and drop the document
identifier from the call.

A **third** signature change is n8n-only and does not reach this audience:
`signature_participant_create` answers 201 with no body here exactly as it always did,
so a direct MCP caller sees nothing new. The n8n connector, which has to hand the
workflow *some* identifier, renames the one it injects — see
[Upgrading the n8n connector](#upgrading-the-n8n-connector).

## More tools

86 tools, up from 52.

## Upgrading the n8n connector

<!-- N8N_UPGRADE -->
**If you already sign in with a User Key, there is nothing to do.** The credential type
itself has not changed — it keeps its name, and the **API Base URL** and **User Key**
fields keep theirs along with the values you already stored. Saved workflows keep
running, and nothing has to be re-selected.

**If you sign in with an e-mail and password, that pair is gone.** Password sign-in now
requires 2FA / biometric verification, which cannot complete in an unattended workflow,
so no version of this connector can keep it working. Open the **EAD Enterprise Suite
API** credential, fill in **User Key**, and save. Editing the credential in place is
enough: you do not need to delete it, and you do not need to touch the nodes that use
it.

Both remaining fields are now required:

| Field | Value |
|---|---|
| **API Base URL** (`MCP_API_BASE_URL`) | The EAD Enterprise Suite API root you connect to. No longer optional. |
| **User Key** (`MCP_AUTH_USER_KEY`) | Your long-lived user key. Replaces the e-mail/password pair. |

**Two operations changed target, and both lost their Document Id input.** This one is
not fixed by updating the credential — any saved workflow using either operation has
to be re-pointed by hand:

| Operation | Now lists | Use instead, for the old behaviour |
|---|---|---|
| **Signature Document List** | the documents of a signature request | **Signature Document Signatory List** |
| **Signature Participant List** | the participants of a signature request | **Signature Document Observer List** |

The **Document Id** field is gone from both. The two replacements are new operations in
this release and still take it.

**Signature Participant Create hands back a different field.** The call answers 201 with
no body, so the connector injects the id you supplied into the output item. It used to
inject it as `signatoryId` whatever Role you had selected — which was only ever true for
a signatory. It now injects `participantId` for every role, and adds the role-specific
name on top:

| Role you select | Fields on the output item |
|---|---|
| **Signatory** | `participantId` and `signatoryId` |
| **Validator** | `participantId` and `validatorId` |
| **Observer** | `participantId` |

A saved workflow that reads `$json.signatoryId` after creating a **Signatory** is
unaffected. One that reads it after creating a **Validator** or an **Observer** was
reading a field that never described what it held, and now reads nothing: re-point it at
`$json.participantId`, or at `$json.validatorId` for a validator.

**82 operations, up from 50.** Apart from the three changes above, every operation that
existed before keeps its name, its inputs and the fields it hands back; the rest are
additions.

**The two one-call notification helpers are not in the connector.** They carry no REST
annotation upstream, so they are absent by design — chain the individual notification
steps instead. All of those are present.
<!-- /N8N_UPGRADE -->
