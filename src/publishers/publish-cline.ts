import {
  fileMarketplaceIssue,
  type FileMarketplaceIssueDeps,
  type FileMarketplaceIssueInput,
} from './file-marketplace-issue.js';
import type { PublisherOutput } from '../schemas/publisher-output.schema.js';

// Story 4.4: Cline Marketplace publisher.
//
// Cline's MCP submission process is a GitHub issue against cline/mcp-
// marketplace. The title format is `[<reverse_dns_name>] <mcp_name>` so
// the maintainers' issue triage scripts can sort them deterministically.
// The body (templates/store-descriptions/cline-issue.hbs) includes the
// logo as a raw.githubusercontent image link, install snippets for both
// npx + Docker paths, and the required-env-vars list.

export function publishCline(
  input: FileMarketplaceIssueInput,
  deps?: FileMarketplaceIssueDeps,
): Promise<PublisherOutput> {
  return fileMarketplaceIssue(
    {
      target: 'cline',
      upstreamRepo: 'cline/mcp-marketplace',
      templateFile: 'cline-issue.hbs',
      titlePattern: ({ reverseDns, mcpName }) => `[${reverseDns}] ${mcpName}`,
      // Cline uses a version-less title — every release of the same MCP
      // resolves to the same issue. Without this opt-in, the publisher
      // would return 'skipped' on every release after the first, and
      // the issue's body would forever advertise v1.0.0 even when we're
      // shipping v1.0.4. With it on, every release refreshes the body
      // so reviewers always see the latest install command, env vars,
      // and logo URL. Caught with issue cline/mcp-marketplace#1566 in
      // v1.0.3 — it still said v1.0.0 four releases later.
      updateBodyOnIdempotencyHit: true,
    },
    input,
    deps,
  );
}
