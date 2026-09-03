# What in here is current

Most of what used to sit in `docs/` was finished build plans — 46 documents,
~89,000 words describing work that shipped months ago, filed next to the
documents that are still true, with nothing marking which was which. Several
were actively misleading: a camera state-machine plan describing an
architecture replaced since, a spec for a plate detector that was retired.

So: **everything under `docs/archive/` is history.** Read it to find out why
something was built the way it was; never read it to find out how the system
works today.

## The living documents

| Document | What it is |
|---|---|
| [`../CLAUDE.md`](../CLAUDE.md) | The rulebook for this repo — architecture, the naming rule, deploy guardrails, what not to touch. Every AI session loads it at startup. (`AGENTS.md` is a pointer to it, not a second copy.) |
| [`../RECOVERY.md`](../RECOVERY.md) | Disaster recovery and handoff: every service, every secret *name* and where its value lives, how to rebuild if the laptop is lost. |
| [`ONBOARDING.md`](./ONBOARDING.md) | Getting a new collaborator access to every service in the stack. |
| [`claude-code-setup.md`](./claude-code-setup.md) | The project-scoped Claude Code / MCP configuration in `.claude/`. |
| `2026-09-03-enterprise-readiness-program.md` | The current work programme — the three waves and the fat decisions coming out of the 2026-09 audit. Lives in `docs/superpowers/specs/` on the branch it was written on, not on `main`. |

The backend repo, `getlotlogic/lotlogic-backend`, keeps its own `CLAUDE.md` and
its own `recovery/` database artefacts. Migrations are the backend repo's source
of truth even though a copy of some of them lives here.

## The archive

| Folder | What it holds |
|---|---|
| `archive/specs/` | 23 design specs, 2026-04 → 2026-08 — the ALPR pipeline, the apartment registry, temp-tag detection, the audits. |
| `archive/plans/` | 17 build plans for the same work, plus handoff notes. |
| `archive/notes/` | Two install-day notes from the April camera bring-up. |
| `archive/backend-patches/` | One patch file from June. |

Nothing under `archive/` is maintained. If a document there still describes how
something works, that fact belongs in `CLAUDE.md`, not in the archive.
