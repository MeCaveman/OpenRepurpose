# Codex Model and Usage Guide — September 2026

This file is deliberately separate from the release files because Codex model names and usage policy can change.

## Recommended default

Use **GPT-5.6 Terra at Medium reasoning** for most OpenRepurpose implementation work.

Current OpenAI guidance describes:
- **GPT-5.6 Sol** as the flagship choice for complex reasoning/coding;
- **GPT-5.6 Terra** as the balance between intelligence and cost;
- **GPT-5.6 Luna** as the cost-sensitive/high-volume choice.

For Codex signed in with ChatGPT, GPT-5.4 and GPT-5.4 mini were retired on August 31, 2026. Current guidance is to replace them with Terra and Luna respectively.

Official references:
- https://help.openai.com/en/articles/11369540
- https://openai.com/index/gpt-5-6/
- https://platform.openai.com/docs/models

## Practical policy for this repository

| Work | Model | Reasoning |
|---|---|---|
| Normal feature implementation | GPT-5.6 Terra | Medium |
| Straightforward bug fix | GPT-5.6 Terra | Medium |
| Unit tests after code exists | GPT-5.6 Luna | Medium |
| Docs/changelog/renames | GPT-5.6 Luna | Low/Medium |
| Repetitive UI wiring | GPT-5.6 Luna or Terra | Medium |
| Initial architecture decision | GPT-5.6 Sol | High |
| Persistent job concurrency/idempotency | GPT-5.6 Sol | High |
| OAuth/security review | GPT-5.6 Sol | High |
| Hard FFmpeg correctness bug | GPT-5.6 Sol | High |
| Cross-platform release/installer failure | GPT-5.6 Sol | High |
| Very hard bounded issue after prior failures | GPT-5.6 Sol | Max only if justified |

## Do not use Sol for everything

A stronger model on every mechanical task wastes allowance and does not necessarily improve simple work.

Preferred flow:

```text
Plan hard subsystem once with Sol High
              |
              v
Implement packets with Terra Medium
              |
              v
Tests/docs/mechanical cleanup with Luna
              |
              v
Escalate a specific failure back to Sol only if needed
```

## Usage is not a fixed messages-per-version budget

OpenAI states that Codex usage varies based on:
- model;
- task size;
- reasoning effort;
- context;
- tools;
- how long the task runs.

Therefore these files use **relative** budgets instead of pretending there is an exact token/message number.

Check current usage with:
- `/status` in an active Codex CLI session where supported;
- the usage/limit area shown by ChatGPT/Codex for your account.

Do not hard-code plan limits into this project documentation.

## Relative release budgets

| Version | Expected Codex load | Main reason |
|---|---:|---|
| v0.1 | Very high | foundation + DB + jobs + OAuth + first destination |
| v0.2 | Medium | one destination adapter |
| v0.3 | High | Meta OAuth + async publishing semantics |
| v0.4 | Medium-high | source polling, cursors, dedupe, authorized media resolution |
| v0.5 | High | scheduling + concurrency + visual workflow UX |
| v0.6 | High | deterministic FFmpeg pipeline |
| v0.7 | Medium | local transcription/subtitles |
| v0.8 | Medium-high | multiple streaming-source APIs + OBS workflows |
| v0.9 | Medium-high | MCP + API surface + headless hardening |
| v1.0 | Very high | packaging, migrations, security, plugin stability, release engineering |

## Context-saving rules

### Rule 1 — one packet per turn
Do not say:

> Build everything in v0.5.

Say:

> Read AGENTS.md, v0.5.md and docs/progress/v0.5.md. Implement Packet 3 only. Run its verification commands and update the progress file.

### Rule 2 — use a fresh chat when context becomes noisy
A new chat should load:
1. `AGENTS.md`;
2. current `vX.Y.md`;
3. current progress file;
4. directly relevant code.

It does **not** need all older roadmap documents.

### Rule 3 — ask Codex to inspect before reading broadly
Prefer:

> Locate the job runner and scheduler implementation, then inspect only the files relevant to the lease/retry bug.

Avoid:

> Read the entire repository.

### Rule 4 — keep progress summaries compact
Do not paste full logs into progress files. Store:
- command;
- pass/fail;
- one-line failure reason if still unresolved.

### Rule 5 — avoid repeated generated output
Do not ask Codex to repeatedly regenerate:
- lockfiles;
- long architecture explanations;
- unchanged code;
- entire schemas;
- full test logs.

### Rule 6 — separate thinking from mechanical work
Use Sol for a short architecture/security decision, record it in `docs/adr/`, then use Terra/Luna to implement that already-made decision.

## Suggested model by release

### v0.1
- One **Sol High** turn for foundational architecture/queue/security review.
- Mostly **Terra Medium** implementation.
- **Luna Medium** for test expansion/docs.

### v0.2
- **Terra Medium**.
- Sol only if TikTok OAuth/upload/audit constraints create a genuine design issue.

### v0.3
- **Terra Medium** for implementation.
- **Sol High** for Meta auth and asynchronous container/retry correctness review.

### v0.4
- **Terra Medium**.
- Sol only for dedupe/idempotency or content-rights boundary decisions.

### v0.5
- **Sol High** for scheduler/job semantics once.
- **Terra Medium** for implementation.
- Luna for UI/docs.

### v0.6
- **Terra High** is usually enough.
- Escalate difficult FFmpeg filter graphs or cross-platform process bugs to **Sol High**.

### v0.7
- **Terra Medium**.
- Luna for caption-theme UI/docs.

### v0.8
- **Terra Medium**.
- Sol only for API ambiguity, event ordering, or security.

### v0.9
- **Terra Medium**.
- **Sol High** for MCP/local API threat model.

### v1.0
- **Sol High** for release architecture, security pass, migration strategy and packaging failures.
- **Terra Medium** for implementing the plan.
- **Luna Medium** for docs/changelog/checklists.

## Prompt template

Use this for most packets:

```text
Read:
- AGENTS.md
- docs/roadmap/vX.Y.md
- docs/progress/vX.Y.md

Implement Packet N only.

Before editing, inspect the current implementation relevant to this packet and state the minimal file set you expect to touch.

Follow existing architecture and do not expand scope into later releases.
Use current official platform documentation for external API behavior.
Do not require real credentials for automated tests.
Run the packet verification commands.
Fix regressions caused by your changes.
Update docs/progress/vX.Y.md.
Stop after this packet and give me:
1. changed files,
2. tests/commands run,
3. remaining blocker(s),
4. next packet.
```

For Luna mechanical work, remove the request for architecture commentary and give an even narrower explicit task.
