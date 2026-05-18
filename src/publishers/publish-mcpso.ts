import {
  fileMarketplaceIssue,
  type FileMarketplaceIssueDeps,
  type FileMarketplaceIssueInput,
} from './file-marketplace-issue.js';
import type { PublisherOutput } from '../schemas/publisher-output.schema.js';

// Story 4.5: mcp.so directory publisher.
//
// mcp.so's curator repo is chatmcp/mcp-directory. Submissions are GitHub
// issues with the canonical body template (templates/store-descriptions/
// mcpso-issue.hbs). Same idempotency + 403-rate-limit semantics as Story
// 4.4 (Cline) — both share the file-marketplace-issue.ts helper.

export function publishMcpSo(
  input: FileMarketplaceIssueInput,
  deps?: FileMarketplaceIssueDeps,
): Promise<PublisherOutput> {
  return fileMarketplaceIssue(
    {
      target: 'mcpso',
      upstreamRepo: 'chatmcp/mcp-directory',
      templateFile: 'mcpso-issue.hbs',
      titlePattern: ({ mcpName, version }) => `[Submission] ${mcpName} v${version}`,
      // mcpso's title carries the version, so each release opens a new
      // issue. Over four releases (v1.0.0/1/2/3) we accumulated 4 open
      // submissions for ead-factory alone, all competing for the
      // maintainer's attention. Enable close-on-supersede so each new
      // release leaves a single OPEN issue for that MCP.
      closeStaleIssues: true,
      stalePrefix: ({ mcpName }) => `[Submission] ${mcpName} v`,
    },
    input,
    deps,
  );
}
