# EAD Factory MCP

**EAD Factory MCP — Digital Trust services APIs for your agents.**

This MCP server bridges any MCP-compatible agent (Claude Code, Claude Desktop, Cursor, Windsurf, Cline, VS Code, JetBrains, Zed) to Garrigues' Digital Trust services: Evidence Manager (qualified digital evidence + timestamping) and Signature Manager (electronic signature workflows).

> Need credentials? See: https://eadtrust.example.com/onboarding

## Quick start

```bash
npx -y @g-digital/mcp-ead-factory
```

You will need Okta credentials (`OKTA_CLIENT_ID` + `OKTA_CLIENT_SECRET`) and at least the Evidence Manager + Signature Manager base URLs for the environment you target (see [Environment URLs](#environment-urls)).

## Tools

### Evidence Manager

| Tool | Description |
|---|---|
| `generate_evidence` | Full workflow: authenticate → SHA-256 hash → register evidence → upload file to S3 → poll until COMPLETED/ERROR |
| `get_evidence` | Retrieve full evidence details by ID (status, timestamps, custody, metadata) |

### Signature Manager

| Tool | Description |
|---|---|
| `create_signature_request` | Creates a new signature request (DRAFT). Supports `fullFlow=true` to complete the entire flow in one call using preconfigured participants |
| `add_document_to_signature_request` | Adds a document to a DRAFT signature request and uploads the file to S3 |
| `add_signatory_to_document` | Adds a signatory to a document within a signature request |
| `add_validator_to_signatory` | Adds a validator to a signatory (must approve before the signatory can sign) |
| `add_observer_to_document` | Adds an observer to a document (receives notifications but does not sign) |
| `activate_signature_request` | Activates a signature request (DRAFT → ACTIVE), triggering notifications to signatories |
| `get_signature_request` | Retrieves full details of a signature request by ID (status, documents, participants, history) |

## Register the MCP in your client

### Claude Code (CLI, recommended)

```bash
claude mcp add --scope user ead-factory -- npx -y @g-digital/mcp-ead-factory
```

You can then export the required env vars in your shell, or set them per-invocation. To inspect or remove:

```bash
claude mcp list
claude mcp remove ead-factory
```

### Claude Desktop / Cursor / Windsurf / Cline / JetBrains / Zed

Add the block below to your client's MCP configuration file (path varies by client and OS — see your client's documentation).

```json
{
  "mcpServers": {
    "ead-factory": {
      "command": "npx",
      "args": ["-y", "@g-digital/mcp-ead-factory"],
      "env": {
        "API_BASE_URL": "",
        "SIGNATURE_API_BASE_URL": "",
        "OKTA_TOKEN_URL": "",
        "OKTA_CLIENT_ID": "",
        "OKTA_CLIENT_SECRET": "<PASTE_OKTA_CLIENT_SECRET_HERE>",
        "OKTA_SCOPE": "",
        "HTTP_PORT": "3000",
        "POLL_INTERVAL_MS": "3000",
        "POLL_MAX_ATTEMPTS": "20",
        "TRANSPORT": "stdio",
        "FULL_FLOW_EMAIL_BASE": "",
        "FULL_FLOW_FILE_PATH": ""
      }
    }
  }
}
```

### VS Code

```json
{
  "servers": {
    "ead-factory": {
      "command": "npx",
      "args": ["-y", "@g-digital/mcp-ead-factory"],
      "env": {
        "API_BASE_URL": "",
        "SIGNATURE_API_BASE_URL": "",
        "OKTA_TOKEN_URL": "",
        "OKTA_CLIENT_ID": "",
        "OKTA_CLIENT_SECRET": "<PASTE_OKTA_CLIENT_SECRET_HERE>",
        "OKTA_SCOPE": "",
        "TRANSPORT": "stdio"
      }
    }
  }
}
```

## Bundled skills (Claude Code)

This package ships with two `/slash` commands for Claude Code under `.claude/commands/`:

- `/create-internal-evidence` — guides the full evidence-creation flow (interactive or fast mode)
- `/create-signature-request` — guides signature-request creation (guided, fast, or full-flow mode)

To enable them, copy the markdown files from the installed package into your Claude Code commands directory:

```bash
# Global — available in all projects
npm pack @g-digital/mcp-ead-factory --pack-destination /tmp
mkdir -p ~/.claude/commands && tar -xzf /tmp/g-digital-mcp-ead-factory-*.tgz -C /tmp \
  && cp /tmp/package/.claude/commands/*.md ~/.claude/commands/
```

Then restart Claude Code so the new commands are picked up.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `API_BASE_URL` | Yes | — | Evidence Manager API base URL |
| `SIGNATURE_API_BASE_URL` | Yes | — | Signature Manager API base URL |
| `OKTA_TOKEN_URL` | Yes | — | Okta token endpoint (client_credentials grant); used both for outbound API calls and for verifying inbound Bearer tokens in HTTP mode |
| `OKTA_CLIENT_ID` | Yes | — | Okta client ID |
| `OKTA_CLIENT_SECRET` | Yes | — | Okta client secret (treat as secret) |
| `OKTA_SCOPE` | No | `token` | OAuth scope |
| `TRANSPORT` | No | `stdio` | `stdio` for local clients, `http` for remote deployment with Bearer auth |
| `HTTP_PORT` | No | `3000` | Port when `TRANSPORT=http` |
| `POLL_INTERVAL_MS` | No | `3000` | Polling interval for evidence-status checks |
| `POLL_MAX_ATTEMPTS` | No | `20` | Maximum polling attempts before timeout |
| `FULL_FLOW_EMAIL_BASE` | Yes* | — | Base email used to derive participant emails (`user+signatory@domain`, etc.). *Only required for `create_signature_request` with `fullFlow=true` |
| `FULL_FLOW_FILE_PATH` | Yes* | — | Default file path for full-flow demos. *Only required for `fullFlow=true` |

### Environment URLs

#### AWS

| Environment | `API_BASE_URL` | `OKTA_TOKEN_URL` |
|---|---|---|
| INT | `https://api.int.gcloudfactory.com/digital-trust` | `https://legalappfactory.okta.com/oauth2/aus5zlw4kr0vhHKyx417/v1/token` |
| PRE | `https://api.pre.gcloudfactory.com/digital-trust` | `https://sso.garrigues.io.builders/oauth2/aus653dgdgTFL2mhw417/v1/token` |
| PRO | `https://api.gcloudfactory.com/digital-trust` | `https://legalappfactory.okta.com/oauth2/aus657e2pcoS6hOS6417/v1/token` |

#### OCI

| Environment | `API_BASE_URL` |
|---|---|
| INT | `https://api.int.eadtrust.gcloudfactory.com/digital-trust` |
| PRO | `https://api.eadtrust.gcloudfactory.com/digital-trust` |


## Remote deployment (HTTP + Bearer auth)

Set `TRANSPORT=http` to run the server as an HTTP service. The `/mcp` endpoint requires a valid Okta Bearer token (verified against the introspection endpoint derived from `OKTA_TOKEN_URL`). The `/health` endpoint is unauthenticated for monitoring.

## Architecture

```
Client (Claude Code / MCP client)
  │
  ├─ stdio ──► McpServer
  │
  └─ HTTP  ──► Express + Bearer auth (Okta introspect) ──► StreamableHTTP ──► McpServer
                                                                │
                                                          tools/call
                                                                │
                                                                ▼
                                                      workflow.service
                                                       ├── auth.service         (Okta client_credentials → token cache)
                                                       ├── hash.service         (SHA-256 from local file)
                                                       ├── evidence.service     (POST /api/v1/private/evidences)
                                                       └── s3-upload.service    (PUT presigned URL + retry)
```

## `generate_evidence` — Input schema

| Field | Type | Required | Description |
|---|---|---|---|
| `filePath` | string | Yes | Absolute path to the file on disk |
| `evidenceId` | string (UUID) | Yes | Unique ID for idempotency |
| `title` | string | Yes | Human-readable title |
| `createdBy` | string | Yes | Creator name (max 50 chars) |
| `capturedAt` | string (ISO 8601) | Yes | Capture datetime |
| `custodyType` | `INTERNAL` \| `EXTERNAL` | No | Defaults to `INTERNAL` |
| `testimonyTSP` | boolean | No | TSP via EADTrust (default `true`) |
| `testimonyDLT` | boolean | No | DLT via Lacnet (requires tenant activation) |
| `requiredTestimonyProviders` | string | No | Comma-separated: `"TSP"`, `"DLT"`, `"TSP,DLT"` |
| `metadata` | string (JSON) | No | Custom key-value pairs as a JSON string |

## API endpoints consumed

- `POST {OKTA_TOKEN_URL}` — OAuth `client_credentials` token
- `POST {API_BASE_URL}/api/v1/private/evidences` — register evidence
- `GET {API_BASE_URL}/api/v1/private/evidences/{id}` — fetch evidence
- `PUT <presigned-s3-url>` — upload file binary

## License

MIT
