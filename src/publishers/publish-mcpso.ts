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
    },
    input,
    deps,
  );
}
