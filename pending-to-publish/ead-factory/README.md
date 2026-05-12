# Evidence Manager MCP Server

MCP server that connects to the Evidence Manager API (g-digital-trust-api) to create and query digital evidences with internal custody, including file upload and timestamping.

---

## Guía de instalación paso a paso

Esta guía permite a cualquier miembro del equipo poner en marcha el MCP y la skill `/create-internal-evidence` en Claude Code desde cero.

### Requisitos previos

- [Node.js](https://nodejs.org/) v18 o superior
- [Claude Code CLI](https://claude.ai/code) instalado (`npm install -g @anthropic-ai/claude-code`)
- Credenciales Okta (`OKTA_CLIENT_ID` y `OKTA_CLIENT_SECRET`) — solicítalas al equipo

### Paso 1 — Clonar y compilar

```bash
git clone https://gitlab.com/garrigues_newlaw/projects/eng/digital-trust/g-mcp-server.git
cd g-mcp-server
npm install
npm run build
```

### Paso 2 — Configurar credenciales

```bash
cp .env.example .env
```

Edita `.env` y rellena los valores para el entorno que vayas a usar:

```env
OKTA_CLIENT_ID=<tu-client-id>
OKTA_CLIENT_SECRET=<tu-client-secret>
```

El resto de valores ya están preconfigurados para el entorno INT. Para otros entornos consulta la tabla de URLs más abajo.

### Paso 3 — Registrar el MCP en Claude Code

Puedes registrar el servidor en dos ámbitos distintos. Las variables de entorno se leen automáticamente desde el fichero `.env` que configuraste en el paso anterior.

#### Opción A — Ámbito global (recomendado)

Disponible en **todos tus proyectos** de Claude Code. Usa el flag `--scope user`:

```bash
claude mcp add --scope user g-mcp-server -- node /ruta/absoluta/al/repo/dist/server.js
```

El MCP se guarda en:
- **Mac (instalación nativa):** `~/.claude.json` — fichero JSON único en el home
- **Linux / Windows:** `~/.claude/mcp_servers.json`

#### Opción B — Ámbito local (por proyecto)

Solo disponible en el proyecto donde ejecutes el comando. Usa el flag `--scope project`:

```bash
claude mcp add --scope project g-mcp-server -- node /ruta/absoluta/al/repo/dist/server.js
```

El MCP se guarda en `.mcp.json` en la raíz del proyecto (puedes comitearlo con el repo).

---

> **Mac — ficheros de configuración según el cliente:**
>
> | Cliente | Fichero de configuración |
> |---|---|
> | Claude Code CLI (instalación nativa, `.dmg`) | `~/.claude.json` |
> | Claude Code CLI (instalación npm) | `~/.claude/mcp_servers.json` |
> | Claude Desktop (app) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
>
> Si usas la aplicación **Claude Desktop**, el fichero es:
>
> Añade manualmente la entrada bajo `mcpServers`:
> ```json
> {
>   "mcpServers": {
>     "g-mcp-server": {
>       "command": "node",
>       "args": ["/ruta/absoluta/al/repo/dist/server.js"]
>     }
>   }
> }
> ```
> Guarda el fichero y **reinicia Claude Desktop** para que cargue el nuevo MCP.

---

Verifica que el MCP quedó registrado (solo con Claude Code CLI):

```bash
claude mcp list
# Debe aparecer: g-mcp-server
```

### Paso 4 — Instalar las skills

Este repositorio incluye dos skills en `.claude/commands/`:

- `/create-internal-evidence` — guía el flujo completo de creación de evidencia digital
- `/create-signature-request` — guía la creación de una solicitud de firma

#### Instalación global (disponible en todos tus proyectos)

```bash
cp .claude/commands/create-internal-evidence.md ~/.claude/commands/
cp .claude/commands/create-signature-request.md ~/.claude/commands/
```

#### Instalación por proyecto (solo en un proyecto concreto)

```bash
cp .claude/commands/create-internal-evidence.md /ruta/a/tu/proyecto/.claude/commands/
cp .claude/commands/create-signature-request.md /ruta/a/tu/proyecto/.claude/commands/
```

### Paso 5 — Reiniciar Claude Code

Cierra y vuelve a abrir Claude Code para que cargue el nuevo MCP y la skill.

### Paso 6 — Probar

#### `/create-internal-evidence`

Abre Claude Code en cualquier proyecto y ejecuta:

```
/create-internal-evidence /ruta/a/cualquier/fichero.pdf
```

Sigue el flujo guiado: te pedirá título, creador, metadatos opcionales y tipo de sello (TSP o TSP+DLT). Al finalizar recibirás el certificado de evidencia con el Evidence ID y el sello de tiempo EADTrust.

Para el **modo rápido** (sin preguntas interactivas):

```
/create-internal-evidence /ruta/fichero.pdf --title "Mi título" --by "Nombre Apellido" --tsp-only
```

---

#### `/create-signature-request`

La skill tiene tres modos de uso:

**Modo guiado** (por defecto) — pasa solo el fichero y responde las preguntas paso a paso:

```
/create-signature-request /ruta/a/contrato.pdf
```

**Modo rápido** — pasa todos los parámetros directamente y ejecuta sin preguntas:

```
/create-signature-request /ruta/a/contrato.pdf --name "Contrato cliente X" --by "Nombre Apellido" --signatory "Ana García,ana@example.com" --type INTERPOSITION
```

Parámetros opcionales adicionales: `--lang ES|EN`, `--close "2025-12-31T23:59:59Z"`.

**Modo full-flow** — el servidor MCP gestiona el documento, firmante, validador y observador predefinidos del entorno (ideal para pruebas):

```
/create-signature-request --full-flow --name "Test SR" --by "Nombre Apellido"
```

> **Nota:** el modo full-flow requiere que la variable `FULL_FLOW_FILE_PATH` esté configurada en el servidor MCP.

---

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

## Quick Start

### Claude Desktop

```json
{
  "mcpServers": {
    "ead-factory": {
      "args": [
        "-y",
        "@g-digital/mcp-ead-factory"
      ],
      "command": "npx",
      "env": {
        "API_BASE_URL": "",
        "FULL_FLOW_EMAIL_BASE": "",
        "FULL_FLOW_FILE_PATH": "",
        "HTTP_PORT": "",
        "OKTA_CLIENT_ID": "",
        "OKTA_CLIENT_SECRET": "<PASTE_OKTA_CLIENT_SECRET_HERE>",
        "OKTA_SCOPE": "",
        "OKTA_TOKEN_URL": "",
        "POLL_INTERVAL_MS": "",
        "POLL_MAX_ATTEMPTS": "",
        "SIGNATURE_API_BASE_URL": "",
        "TRANSPORT": ""
      }
    }
  }
}
```

> Need credentials? See: https://eadtrust.example.com/onboarding

### Claude Code (CLI)

```json
{
  "mcpServers": {
    "ead-factory": {
      "args": [
        "-y",
        "@g-digital/mcp-ead-factory"
      ],
      "command": "npx",
      "env": {
        "API_BASE_URL": "",
        "FULL_FLOW_EMAIL_BASE": "",
        "FULL_FLOW_FILE_PATH": "",
        "HTTP_PORT": "",
        "OKTA_CLIENT_ID": "",
        "OKTA_CLIENT_SECRET": "<PASTE_OKTA_CLIENT_SECRET_HERE>",
        "OKTA_SCOPE": "",
        "OKTA_TOKEN_URL": "",
        "POLL_INTERVAL_MS": "",
        "POLL_MAX_ATTEMPTS": "",
        "SIGNATURE_API_BASE_URL": "",
        "TRANSPORT": ""
      }
    }
  }
}
```

> Need credentials? See: https://eadtrust.example.com/onboarding

### Cursor

```json
{
  "mcpServers": {
    "ead-factory": {
      "args": [
        "-y",
        "@g-digital/mcp-ead-factory"
      ],
      "command": "npx",
      "env": {
        "API_BASE_URL": "",
        "FULL_FLOW_EMAIL_BASE": "",
        "FULL_FLOW_FILE_PATH": "",
        "HTTP_PORT": "",
        "OKTA_CLIENT_ID": "",
        "OKTA_CLIENT_SECRET": "<PASTE_OKTA_CLIENT_SECRET_HERE>",
        "OKTA_SCOPE": "",
        "OKTA_TOKEN_URL": "",
        "POLL_INTERVAL_MS": "",
        "POLL_MAX_ATTEMPTS": "",
        "SIGNATURE_API_BASE_URL": "",
        "TRANSPORT": ""
      }
    }
  }
}
```

> Need credentials? See: https://eadtrust.example.com/onboarding

### Windsurf

```json
{
  "mcpServers": {
    "ead-factory": {
      "args": [
        "-y",
        "@g-digital/mcp-ead-factory"
      ],
      "command": "npx",
      "env": {
        "API_BASE_URL": "",
        "FULL_FLOW_EMAIL_BASE": "",
        "FULL_FLOW_FILE_PATH": "",
        "HTTP_PORT": "",
        "OKTA_CLIENT_ID": "",
        "OKTA_CLIENT_SECRET": "<PASTE_OKTA_CLIENT_SECRET_HERE>",
        "OKTA_SCOPE": "",
        "OKTA_TOKEN_URL": "",
        "POLL_INTERVAL_MS": "",
        "POLL_MAX_ATTEMPTS": "",
        "SIGNATURE_API_BASE_URL": "",
        "TRANSPORT": ""
      }
    }
  }
}
```

> Need credentials? See: https://eadtrust.example.com/onboarding

### Cline

```json
{
  "mcpServers": {
    "ead-factory": {
      "args": [
        "-y",
        "@g-digital/mcp-ead-factory"
      ],
      "command": "npx",
      "env": {
        "API_BASE_URL": "",
        "FULL_FLOW_EMAIL_BASE": "",
        "FULL_FLOW_FILE_PATH": "",
        "HTTP_PORT": "",
        "OKTA_CLIENT_ID": "",
        "OKTA_CLIENT_SECRET": "<PASTE_OKTA_CLIENT_SECRET_HERE>",
        "OKTA_SCOPE": "",
        "OKTA_TOKEN_URL": "",
        "POLL_INTERVAL_MS": "",
        "POLL_MAX_ATTEMPTS": "",
        "SIGNATURE_API_BASE_URL": "",
        "TRANSPORT": ""
      }
    }
  }
}
```

> Need credentials? See: https://eadtrust.example.com/onboarding

### VS Code

```json
{
  "servers": {
    "ead-factory": {
      "args": [
        "-y",
        "@g-digital/mcp-ead-factory"
      ],
      "command": "npx",
      "env": {
        "API_BASE_URL": "",
        "FULL_FLOW_EMAIL_BASE": "",
        "FULL_FLOW_FILE_PATH": "",
        "HTTP_PORT": "",
        "OKTA_CLIENT_ID": "",
        "OKTA_CLIENT_SECRET": "<PASTE_OKTA_CLIENT_SECRET_HERE>",
        "OKTA_SCOPE": "",
        "OKTA_TOKEN_URL": "",
        "POLL_INTERVAL_MS": "",
        "POLL_MAX_ATTEMPTS": "",
        "SIGNATURE_API_BASE_URL": "",
        "TRANSPORT": ""
      }
    }
  }
}
```

> Need credentials? See: https://eadtrust.example.com/onboarding

### JetBrains

```json
{
  "mcpServers": {
    "ead-factory": {
      "args": [
        "-y",
        "@g-digital/mcp-ead-factory"
      ],
      "command": "npx",
      "env": {
        "API_BASE_URL": "",
        "FULL_FLOW_EMAIL_BASE": "",
        "FULL_FLOW_FILE_PATH": "",
        "HTTP_PORT": "",
        "OKTA_CLIENT_ID": "",
        "OKTA_CLIENT_SECRET": "<PASTE_OKTA_CLIENT_SECRET_HERE>",
        "OKTA_SCOPE": "",
        "OKTA_TOKEN_URL": "",
        "POLL_INTERVAL_MS": "",
        "POLL_MAX_ATTEMPTS": "",
        "SIGNATURE_API_BASE_URL": "",
        "TRANSPORT": ""
      }
    }
  }
}
```

> Need credentials? See: https://eadtrust.example.com/onboarding

### Zed

```json
{
  "mcpServers": {
    "ead-factory": {
      "args": [
        "-y",
        "@g-digital/mcp-ead-factory"
      ],
      "command": "npx",
      "env": {
        "API_BASE_URL": "",
        "FULL_FLOW_EMAIL_BASE": "",
        "FULL_FLOW_FILE_PATH": "",
        "HTTP_PORT": "",
        "OKTA_CLIENT_ID": "",
        "OKTA_CLIENT_SECRET": "<PASTE_OKTA_CLIENT_SECRET_HERE>",
        "OKTA_SCOPE": "",
        "OKTA_TOKEN_URL": "",
        "POLL_INTERVAL_MS": "",
        "POLL_MAX_ATTEMPTS": "",
        "SIGNATURE_API_BASE_URL": "",
        "TRANSPORT": ""
      }
    }
  }
}
```

> Need credentials? See: https://eadtrust.example.com/onboarding

```bash
npm install
npm run build
```

### Local (stdio, for Claude Code)

```bash
cp .env.example .env
# Fill in OKTA_CLIENT_ID, OKTA_CLIENT_SECRET, API_BASE_URL
npm start
```

E**Register via CLI** (recommended):

```bash
# Global — available in all projects
claude mcp add --scope user g-mcp-server -- node /absolute/path/to/dist/server.js

# Local — only in current project (saved to .mcp.json)
claude mcp add --scope project g-mcp-server -- node /absolute/path/to/dist/server.js
```

**Register manually** (edit the config file directly):

| OS | Claude Code CLI | Claude Desktop (Mac) |
|---|---|---|
| OS | Claude Code CLI (nativo) | Claude Code CLI (npm) | Claude Desktop |
|---|---|---|---|
| Mac | `~/.claude.json` | `~/.claude/mcp_servers.json` | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.claude/mcp_servers.json` | `~/.claude/mcp_servers.json` | — |
| Windows | `~/.claude/mcp_servers.json` | `~/.claude/mcp_servers.json` | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "g-mcp-server": {
      "command": "node",
      "args": ["/absolute/path/to/dist/server.js"]
    }
  }
}
```

### Remote (HTTP with auth)

```bash
TRANSPORT=http HTTP_PORT=3000 npm start
```

The `/mcp` endpoint requires a valid Okta Bearer token. Tokens are verified against the Okta introspection endpoint derived from `OKTA_TOKEN_URL`.

The `/health` endpoint is unauthenticated (for monitoring).

## Configuration

| Name | Required | Secret | Description |
| --- | --- | --- | --- |
| `API_BASE_URL` | Yes | No | Evidence Manager API base URL |
| `FULL_FLOW_EMAIL_BASE` | Yes | No | Full flow base email — used to compose participant emails (user+signatory@domain, etc.) |
| `FULL_FLOW_FILE_PATH` | Yes | No | Full flow default file path |
| `HTTP_PORT` | Yes | No | HTTP_PORT |
| `OKTA_CLIENT_ID` | Yes | No | OKTA_CLIENT_ID |
| `OKTA_CLIENT_SECRET` | Yes | Yes | OKTA_CLIENT_SECRET (See https://eadtrust.example.com/onboarding for credential acquisition.) |
| `OKTA_SCOPE` | Yes | No | OKTA_SCOPE |
| `OKTA_TOKEN_URL` | Yes | No | OAuth credentials (Okta client_credentials flow) Used both for calling Evidence Manager API and for verifying incoming Bearer tokens (HTTP mode) |
| `POLL_INTERVAL_MS` | Yes | No | Polling configuration for evidence status |
| `POLL_MAX_ATTEMPTS` | Yes | No | POLL_MAX_ATTEMPTS |
| `SIGNATURE_API_BASE_URL` | Yes | No | Signature Manager API base URL |
| `TRANSPORT` | Yes | No | Transport: "stdio" for local Claude Code, "http" for remote deployment with auth |

| Variable | Required | Default | Description |
|---|---|---|---|
| `TRANSPORT` | No | `stdio` | `stdio` for local, `http` for remote deployment |
| `HTTP_PORT` | No | `3000` | Port for HTTP mode |
| `OKTA_TOKEN_URL` | Yes | — | Okta token endpoint (e.g. `https://.../oauth2/{authServerId}/v1/token`) |
| `OKTA_CLIENT_ID` | Yes | — | Okta client ID (client_credentials grant) |
| `OKTA_CLIENT_SECRET` | Yes | — | Okta client secret |
| `OKTA_SCOPE` | No | `token` | OAuth scope |
| `API_BASE_URL` | Yes | — | Evidence Manager API base URL |
| `SIGNATURE_API_BASE_URL` | Yes | — | Signature Manager API base URL |
| `TENANT_ID` | No | — | Tenant ID header, only needed for local development |
| `POLL_INTERVAL_MS` | No | `3000` | Polling interval for evidence status |
| `POLL_MAX_ATTEMPTS` | No | `20` | Max polling attempts before timeout |
| `FULL_FLOW_FILE_PATH` | Yes* | — | Relative path (from repo root) to the file used in `fullFlow` mode. *Required only if using `create_signature_request` with `fullFlow=true` |
| `FULL_FLOW_EMAIL_BASE` | Yes* | — | Base email address used to generate preconfigured signatory/validator/observer emails in `fullFlow` mode (e.g. `user@example.com` → `user+signatory@example.com`). *Required only if using `fullFlow=true` |

### Environment URLs

#### AWS

| Environment | API_BASE_URL | OKTA_TOKEN_URL |
|---|---|---|
| INT | `https://api.int.gcloudfactory.com/digital-trust` | `https://legalappfactory.okta.com/oauth2/aus5zlw4kr0vhHKyx417/v1/token` |
| PRE | `https://api.pre.gcloudfactory.com/digital-trust` | `https://sso.garrigues.io.builders/oauth2/aus653dgdgTFL2mhw417/v1/token` |
| PRO | `https://api.gcloudfactory.com/digital-trust` | `https://legalappfactory.okta.com/oauth2/aus657e2pcoS6hOS6417/v1/token` |

#### OCI

| Environment | API_BASE_URL |
|---|---|
| INT | `https://api.int.eadtrust.gcloudfactory.com/digital-trust` |
| PRE (Facilitea) | `https://api.pre.fc.eadtrust.gcloudfactory.com/digital-trust` |
| PRO | `https://api.eadtrust.gcloudfactory.com/digital-trust` |
| PRO (Facilitea) | `https://api.fc.eadtrust.gcloudfactory.com/digital-trust` |

## Architecture

```
Client (Claude Code / MCP client)
  │
  ├─ stdio ──► McpServer
  │
  └─ HTTP ──► Express + Bearer auth (Okta introspect) ──► StreamableHTTP ──► McpServer
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

## generate_evidence — Input

| Field | Type | Required | Description |
|---|---|---|---|
| `filePath` | string | Yes | Absolute path to the file on disk |
| `evidenceId` | string (UUID) | Yes | Unique ID for idempotency |
| `title` | string | Yes | Human-readable title |
| `createdBy` | string | Yes | Creator name (max 50 chars) |
| `capturedAt` | string (ISO 8601) | Yes | Capture datetime |
| `custodyType` | `INTERNAL` \| `EXTERNAL` | No | Defaults to `INTERNAL` |
| `testimonyTSP` | boolean | No | TSP via EADTrust (default true) |
| `testimonyDLT` | boolean | No | DLT via Lacnet (requires tenant activation) |
| `requiredTestimonyProviders` | string | No | Comma-separated: `"TSP"`, `"DLT"`, `"TSP,DLT"` |
| `metadata` | string (JSON) | No | Custom key-value pairs as JSON string |

## API Endpoints Used

- `POST {OKTA_TOKEN_URL}` — OAuth client_credentials token
- `POST {API_BASE_URL}/api/v1/private/evidences` — Register evidence
- `GET {API_BASE_URL}/api/v1/private/evidences/{id}` — Get evidence details
- `PUT <presigned-s3-url>` — Upload file binary

## Development

```bash
npm run dev    # Run with ts-node (no build needed)
npm run build  # Compile TypeScript
npm start      # Run compiled JS
```
