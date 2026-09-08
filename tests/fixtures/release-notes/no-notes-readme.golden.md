# EAD Factory — n8n connector

> EAD Factory connector for n8n.

Install this connector and use EAD Factory operations as steps inside any n8n workflow. Each operation maps to one capability of the underlying EAD Factory platform.

## Install (self-hosted n8n)

```bash
npm install @g-digital/n8n-nodes-ead-factory
```

Then restart n8n. The node will appear in the Nodes panel under "EAD Factory".

## Using with n8n AI Agent

For AI-driven automation, configure an **n8n AI Agent node** with the following system prompt. It covers all lifecycle workflows: evidence creation, certified notifications, signature processes, dossier certification.

**→ Full system prompt and workflow guide:** [`@g-digital/n8n-agent-system-prompt`](https://www.npmjs.com/package/@g-digital/mcp-gocertius) — see the `docs/n8n-agent-workflows/gocertius-ead-system-prompt.md` in [MCP_Market_Distribution](https://github.com/g-digital-by-Garrigues/MCP_Market_Distribution/blob/main/docs/n8n-agent-workflows/gocertius-ead-system-prompt.md).

### Quick system prompt snippet

Paste this into your AI Agent node's **System Message**:

```
You are a Digital Trust assistant using the EAD Factory n8n connector.
UUID generation: generate UUID v4 for all `id` fields you must supply.
IDs from responses: never invent path parameters — always use values returned by previous tool calls.
Async operations: after evidence_seal, dossier_certify, signature activation — poll the corresponding list/status tool until the terminal state is reached before proceeding.
File uploads: when a tool returns uploadFileUrl or url, PUT the file bytes there with a separate HTTP Request node before calling the next step.
See the full lifecycle guide at: https://github.com/g-digital-by-Garrigues/MCP_Market_Distribution/blob/main/docs/n8n-agent-workflows/gocertius-ead-system-prompt.md
```

## Operations

| Operation | Description |
|---|---|
| `evidence_create` | Create an evidence record. |
| `evidence_list` | List evidence records. |

## Credentials

This node requires a "EAD Factory API" credential with the following fields:

| Field | Description | Required? | Secret? |
|---|---|---|---|
| `API Base URL` | Gateway ROOT URL (e.g. https://api.int.gcloudfactory.com) — each manager's path prefix is appended automatically; do NOT include a manager path here | no | no |
> **Need credentials?** Sign up or log in at [https://example.com/onboarding](https://example.com/onboarding).

## Use as an AI Agent tool

This node is flagged `usableAsTool: true`, so any n8n AI Agent (n8n ≥ 1.79.0) can consume it dynamically: drag it into the workflow and wire its main output to an AI Agent's "Tool" input.

For best results pair with an AI Agent node running **V2** — V3 has a known empty-tool-response bug in some recent n8n versions (see [n8n issue #26202](https://github.com/n8n-io/n8n/issues/26202)).

## License

MIT. See [LICENSE](./LICENSE).
