# Architecture Decision Records (ADRs)

This directory captures the **architectural decisions** that shaped the pipeline — the kind of choices that need to outlive their original author's memory, because changing them later requires understanding why they exist.

ADRs are **living documents**. When a decision is replaced by a new one, the old ADR is marked `superseded by 00NN-<new>` rather than deleted — that's the point. The history of decisions is itself the architecture.

Established as part of [Epic 8 Story 8.4](../../_bmad-output/planning-artifacts/epics.md), in response to the lesson from the [Epic 6 retrospective](../../_bmad-output/implementation-artifacts/epic-6-retro-2026-05-26.md) that pinned-policy stories age poorly when the underlying mechanism mutates.

## When to write an ADR

Write an ADR when:

- You're choosing between two or more non-obvious approaches and the rationale would be hard to reconstruct from code alone (e.g. "why does Trusted Publisher point at the source repo, not the pipeline repo?").
- You're replacing an earlier decision (mark the old one superseded; cross-link both ways).
- A policy lives in code + runbook (e.g. slash-command auth) and you want the rationale in one place.

Do NOT write an ADR for:

- Implementation details (those belong in code comments + the relevant runbook).
- Decisions a code reader can infer from the code in 30 seconds.
- Changes that are reversible without coordination (refactors, dependency bumps).

## File naming

```
NNNN-kebab-case-title.md
```

- `NNNN` = zero-padded 4-digit sequence, never reused (even after supersession).
- `kebab-case-title` = noun phrase describing the decision, not the problem. "use-mcpb-for-smithery" not "smithery-broke".

## Lifecycle states

| Status | Meaning |
|---|---|
| `proposed` | Drafted, not yet committed by the team. Open a PR for discussion. |
| `accepted` | Active decision. Anyone making conflicting changes needs to write a new ADR that supersedes this one. |
| `superseded by 00NN` | A later ADR replaces this. The old ADR stays — its content is the historical record. |
| `deprecated` | Decision still applies historically but the area has been removed from the codebase entirely. Rare. |

## Template

```markdown
# ADR NNNN — <Title>

**Status:** accepted
**Date:** YYYY-MM-DD
**Supersedes:** (optional, ADR number this replaces)
**Superseded by:** (filled in if/when a later ADR replaces this — keep the entry, just update the value)

## Context

What is the problem? What forces shape the decision? Brief — one or two paragraphs.

## Decision

What did we choose? Be specific. Cite code paths if applicable.

## Consequences

What happens because of this decision? Both wins and trade-offs. The honest section.

## References

- Related PR(s)
- Related runbook(s)
- Related story / epic
- External docs we relied on (especially when the decision was discovered through external research, e.g. community reports about npm OIDC behaviour)
```

## See also

- [Story 8.4 acceptance criteria](../../_bmad-output/planning-artifacts/epics.md)
- [Epic 6 retrospective lesson 3](../../_bmad-output/implementation-artifacts/epic-6-retro-2026-05-26.md) — the original rationale for this convention
