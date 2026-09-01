# Open Walnut Documentation

Documentation is organized first by purpose, then by subject. New documents
must live under one of these top-level categories instead of directly under
`docs/`.

| Category | Purpose |
|---|---|
| [Plan](plan/) | Proposed implementation and rollout plans |
| [Investigation](investigation/) | Reproducible studies, benchmarks, and root-cause analysis |
| [Decision](decision/) | Accepted decisions, evidence, and anti-regression guardrails |
| [Design](design/) | Product, UX, and technical design specifications |
| [Reference](reference/) | Stable contracts, examples, maps, and operational reference |
| [Assets](assets/) | Images and other media referenced by project documentation |

## Investigation

- [QMD search performance](investigation/qmd-search-performance/README.md) -
  multilingual embedding quality, reranker latency, search races, and index
  maintenance.
- [Duplicate task rows](investigation/duplicate-task-rows/README.md) - one remote
  item owning several task rows, and the orphaned sessions left when a twin is
  deleted.

## Decisions

- [ACP agent lifecycle](decision/acp-agent-lifecycle.md) - one daemon-owned ACP
  worker per session, with lazy `session/load` recovery.
- [No session-end gist](decision/no-session-end-gist.md) - `session:ended` is a
  per-turn event and must not drive process-death hooks.
- [Permission bypass capability](decision/permission-bypass-capability.md) -
  preauthorize runtime Bypass changes and persist only confirmed modes.
- [Summarizer self-report](decision/summarizer-self-report.md) - the session
  writes its own task note while code decides phase and notification behavior.

## Designs

- [Mail base and Chat base](design/mail-chat-base.md) - two core domains with
  plugin providers, approval-gated sends, and the provider contract.
- [Notes redesign](design/notes-redesign/) - product, UX, editor, search, and
  implementation contracts for notes.
- [Session changed view](design/session-changed-view.md) - changed-files review
  experience.

## References

- [Testing pipeline](reference/testing-pipeline.md) - the four layers, which one
  to run when, the known-failure baseline, and the free CI setup.
- [Heartbeat example](reference/heartbeat-example.md)
- [ACP seam map](reference/acp-seam-map.md)
- [Frozen API v1 contract](reference/api-v1.md)
- [Plugin development](reference/plugin-development.md): the authoritative plugin guide. One-command authoring, the full-trust model and its real security boundaries, the manifest, server and native web entries, the `walnut.ui.app` atom with its host-derived route, deep links and badge, the shared App Registry, storage and secrets, lifecycle, publish-check, and troubleshooting. The runnable companion is [examples/plugins/walnut-demo](../examples/plugins/walnut-demo), the Walnut Plugin Demo.
- [Cloud sync](reference/cloud-sync.md) - one-click cloud-companion setup, the
  git-over-HTTPS data plane, and the live-session bridge.
- [Claude model configuration](reference/claude-model-configuration.md)
- [Notification lifecycle](reference/notification-lifecycle.md) - the condition
  system: every error/permission notification declares how it ends (recover,
  expire, one-shot), enforced by a ratchet test

## Plans

- [Coding-agent ACP provider](plan/coding-agent-acp-provider.md)
- [Codex ACP UI test plan](plan/codex-acp-ui-test-plan.md)
- [Daemon source-of-truth events](plan/daemon-source-of-truth-versioned-events.md)
- [Memory v2 plan](plan/validated-snacking-ocean.md)
