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

| File                   | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `AGENTS.md`            | Permanent repository rules Codex should always follow                |
| `MODEL_USAGE_GUIDE.md` | Which Codex model/effort to use and how to conserve usage            |
| `docs/roadmap/v0.1.md` | Foundation + usable YouTube/local MVP                                |
| `docs/roadmap/v0.2.md` | TikTok publishing                                                    |
| `docs/roadmap/v0.3.md` | Instagram + Facebook publishing                                      |
| `docs/roadmap/v0.4.md` | Remote/source automation, especially YouTube                         |
| `docs/roadmap/v0.5.md` | Scheduling + reliable automation + visual workflow UX                |
| `docs/roadmap/v0.6.md` | FFmpeg transformation pipeline                                       |
| `docs/roadmap/v0.7.md` | Local transcription and subtitles                                    |
| `docs/roadmap/v0.8.md` | Twitch, Kick, OBS, streamer workflows                                |
| `docs/roadmap/v0.9.md` | MCP, public local API, webhooks, headless/server mode                |
| `docs/roadmap/v1.0.md` | Stable plugin SDK, packaging, security, migrations, docs and release |

## Manual Codex workflow

1. Open the OpenRepurpose repository in Codex Chat.
2. Select the recommended model/reasoning for the current packet.
3. Tell Codex to read:
   - `AGENTS.md`
   - `docs/roadmap/<current-version>.md`
   - `docs/progress/<current-version>.md`
4. Implement exactly one packet.
5. Run its verification commands.
6. Update the progress file.
7. Start a new Codex chat for the next packet when appropriate.

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

The v0.1 workspace/tooling foundation is present. Application features begin in later v0.1 packets.

## Development

Prerequisites:

- Node.js 24.21.0 (the pinned Active LTS release);
- pnpm 12.4.2.

Install and verify the workspace from Windows PowerShell or a Linux shell:

```text
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

`pnpm dev` starts the Fastify API on `127.0.0.1:3000`, the Vite UI on `127.0.0.1:5173`, and the
current CLI watcher. Vite proxies `/api` to Fastify. `pnpm build` followed by `pnpm start` runs the
production server and serves the built React UI from the same loopback origin.

Runtime paths, port, and browser origins are configured through the variables documented in
`.env.example`. Packet 3 intentionally rejects non-loopback `BIND_HOST` and public `APP_URL` values;
LAN/VPS exposure remains disabled until its roadmap packet adds authentication and proxy trust.
The first server start generates a persistent encrypted-session key at `SESSION_KEY_PATH` (or the
host-native configuration directory by default).

## Branch convention

`main` is the stable development branch. Future feature branches should use names such as `feature/v0.1-repository-tooling`, `feature/v0.1-database`, and `feature/v0.1-media`.
