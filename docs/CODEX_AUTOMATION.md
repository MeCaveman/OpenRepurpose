# Codex roadmap automation

The roadmap runner executes one bounded packet at a time in a fresh `codex exec` task. It dynamically parses `### Packet N — title` headings from the roadmap and uses the corresponding progress file to resume safely.

## Prerequisites

Install the Codex CLI and sign in before running an actual packet:

```text
codex login
codex doctor
```

The runner requires Python 3.11+ (for the standard-library TOML reader), Git, and Codex CLI. It never supplies credentials or creates a Git identity.

## Dry run

Use a dry run to inspect the current version, next packet, selected role/model/reasoning, required review, prompt, and expected verification without invoking Codex:

```powershell
.\scripts\run-roadmap.ps1 -DryRun
.\scripts\run-packet.ps1 -Version v0.1 -Packet 3 -DryRun
```

```bash
./scripts/run-roadmap.sh --dry-run
./scripts/run-packet.sh --version v0.1 --packet 3 --dry-run
```

## Run and resume

Run the next incomplete packet:

```powershell
.\scripts\run-roadmap.ps1
```

Run a specific next-valid packet:

```powershell
.\scripts\run-packet.ps1 -Version v0.1 -Packet 3
```

The runner invokes Codex with the installed CLI's explicit safe combination: `--ask-for-approval on-request exec --sandbox workspace-write` for implementation, and `--ask-for-approval on-request exec --sandbox read-only` for review. It never combines either sandbox flag with `--approve-for-me`. It requires a clean working tree, records the starting commit, checks the progress-file completion marker, runs `pnpm typecheck`, `pnpm lint`, and `pnpm test`, then creates a checkpoint commit when Git author name and email are configured. It prints the diff before checkpointing. Rerun it after interruption; completed packets are detected from each progress file.

## Routing and overrides

Role defaults live in `.codex/agents/`. Architect-sensitive packets route to Sol High, mechanical test/documentation packets can route to Luna Medium, and implementation defaults to Terra Medium. Override an invocation when necessary:

```powershell
.\scripts\run-packet.ps1 -Version v0.1 -Packet 4 -Model gpt-5.6-terra -Reasoning high
```

For a genuinely difficult implementation failure, use only this escalation order: `normal` (Terra Medium), `terra-high`, `sol-high`, then `astra-high`. Do not use XHigh, Ultra, or Max. Stop and request human intervention after the final escalation.

## Safety and recovery

The agent must emit `ROADMAP_STOP: <reason>; HUMAN_ACTION: <action>` for credentials, developer-app setup, external review/audit, destructive migrations, licensing choices, platform restriction conflicts, architecture deviations, releases, or publish operations. The runner stops without checkpointing and prints that instruction.

Review-required packets (OAuth, secrets, scheduler/jobs, migrations, FFmpeg, webhooks, MCP, LAN exposure, and plugins) get a separate read-only Sol High review. A checkpoint requires `REVIEW_PASS`.

If Codex or verification fails, inspect `git diff`, fix or revert only the known failed packet work, restore a clean/understood tree, and rerun the same packet. Use `codex /status` or the Codex/ChatGPT usage panel to inspect usage. Do not use `git reset --hard`, force push, or publish a release through this runner.

## Runner self-test

```powershell
python .\scripts\roadmap_runner.py self-test
```

This validates all roadmap discovery, heading parsing, model routing, and a mocked completed-packet resume without launching Codex.
