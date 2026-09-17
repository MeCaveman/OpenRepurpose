# OpenRepurpose — Codex Build Pack

This folder is a sequential build plan for an open-source, local-first, self-hosted alternative to Repurpose.io.

## Product definition

OpenRepurpose runs on the user's own Windows or Linux machine. It provides:

- a localhost web UI;
- a CLI;
- a persistent local workflow/job engine;
- local media ingestion and FFmpeg processing;
- BYO developer credentials for supported social platforms;
- direct publishing through official platform APIs where available;
- source monitoring and automatic source -> transform -> destination workflows;
- scheduling;
- local transcription/subtitles;
- Twitch/Kick/OBS-oriented ingestion;
- MCP/automation interfaces;
- a plugin SDK;
- portable Windows/Linux releases;
- Docker/headless operation as an optional deployment mode.

It must not depend on an OpenRepurpose-hosted backend.

## Files

| File | Purpose |
|---|---|
| `AGENTS.md` | Permanent repository rules Codex should always follow |
| `MODEL_USAGE_GUIDE.md` | Which Codex model/effort to use and how to conserve usage |
| `docs/roadmap/v0.1.md` | Foundation + usable YouTube/local MVP |
| `docs/roadmap/v0.2.md` | TikTok publishing |
| `docs/roadmap/v0.3.md` | Instagram + Facebook publishing |
| `docs/roadmap/v0.4.md` | Remote/source automation, especially YouTube |
| `docs/roadmap/v0.5.md` | Scheduling + reliable automation + visual workflow UX |
| `docs/roadmap/v0.6.md` | FFmpeg transformation pipeline |
| `docs/roadmap/v0.7.md` | Local transcription and subtitles |
| `docs/roadmap/v0.8.md` | Twitch, Kick, OBS, streamer workflows |
| `docs/roadmap/v0.9.md` | MCP, public local API, webhooks, headless/server mode |
| `docs/roadmap/v1.0.md` | Stable plugin SDK, packaging, security, migrations, docs and release |

## How to use with Codex Desktop

1. Read `AGENTS.md`, `docs/roadmap/current-version.md`, and `docs/progress/current-version.md` before implementing a work packet.
2. Open the repository in ChatGPT Desktop/Codex.
3. Start development with `docs/roadmap/v0.1.md`.
4. Do **one work packet per Codex turn**. Do not ask Codex to implement an entire version in one turn.
5. At the end of every packet, Codex must update `docs/progress/vX.Y.md`.
6. When starting a fresh Codex chat, give it only:
   - root `AGENTS.md`;
   - the current version file;
   - `docs/progress/vX.Y.md`;
   - any source file directly relevant to the next packet.
7. Merge/commit after a packet is green.
8. Move to the next version only when its release gate passes.

## Recommended model policy

- Default implementation: **GPT-5.6 Terra, Medium**.
- Mechanical edits, tests, docs, repetitive UI: **GPT-5.6 Luna, Low/Medium**.
- Architecture, OAuth/security, queue correctness, difficult FFmpeg problems, release engineering: **GPT-5.6 Sol, High**.
- Avoid `Max` as the default. Use it only for a bounded problem that has already resisted Terra/Sol at lower effort.

See `MODEL_USAGE_GUIDE.md` for details.

## Repository status

### Planned

The roadmap documents describe planned functionality. Development begins with `docs/roadmap/v0.1.md`.

### Implemented

This repository currently contains planning documentation and the initial project structure only. No application features have been implemented.

## Branch convention

`main` is the stable development branch. Future feature branches should use names such as `feature/v0.1-repository-tooling`, `feature/v0.1-database`, and `feature/v0.1-media`.
