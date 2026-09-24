# Third-party notices

This file describes third-party material redistributed by the Windows x64 and Linux x64 portable artifacts built from this repository. The dependency lockfile and artifact `SHA256SUMS.txt` are part of the provenance record.

## Packaged runtime and application

| Component                          | Version / provenance                                                                                                                                                                                                                                                                                                                                                                         | License and redistribution                                                                                                                                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                            | v24.21.0 official archives: [Windows x64](https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip), [Linux x64](https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz). SHA-256 values are pinned in `scripts/release/windows-runtime.json` and `scripts/release/linux-runtime.json`; artifact metadata records the archive digest and `SHA256SUMS.txt` hashes extracted files. | MIT for Node.js core. Node's distributed `LICENSE` contains notices and license texts for bundled components. Preserve the runtime `LICENSE` file when redistributing.                                                                                               |
| Production JavaScript dependencies | Exact resolved versions are in `pnpm-lock.yaml`; portable builders run `pnpm deploy --prod` for `@openrepurpose/cli`.                                                                                                                                                                                                                                                                        | Each package's declared license and license files are retained under `app/node_modules`. Review the deployed graph (not all workspace/dev dependencies) when changing dependencies. Lockfile integrity values and artifact checksums identify the sources and bytes. |

Portable archives do **not** contain FFmpeg/ffprobe, a whisper.cpp executable, or Whisper model weights. Users provide FFmpeg and may separately install whisper.cpp and explicitly download a model. Those materials are outside the portable artifact's redistribution.

## Fonts in the web distribution

The web bundle includes Latin WOFF2 subsets from `@fontsource/geist` 5.3.0 and `@fontsource/jetbrains-mono` 5.3.0. Exact font bytes are covered by artifact SHA-256 manifests.

- **Geist** — Copyright 2024 The Geist Project Authors. SIL Open Font License 1.1 (OFL-1.1). Source: [vercel/geist-font](https://github.com/vercel/geist-font); package: [Fontsource Geist 5.3.0](https://www.npmjs.com/package/@fontsource/geist/v/5.3.0).
- **JetBrains Mono** — Copyright JetBrains s.r.o. SIL Open Font License 1.1 (OFL-1.1). Source: [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono); package: [Fontsource JetBrains Mono 5.3.0](https://www.npmjs.com/package/@fontsource/jetbrains-mono/v/5.3.0).

OFL-1.1 permits embedding and redistribution with software, provided the copyright notice and full license accompany copies. The upstream package `LICENSE` files are retained in the deployed dependency tree. Do not sell font files by themselves or apply another license to the fonts. The applicable notices and full license texts are included in [`docs/licenses`](docs/licenses/).

## Docker and system-installed media tools

The Dockerfile uses the official `node:24.21.0-bookworm-slim` image pinned to index digest
`sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`, as listed on the
[Docker Hub tag details](https://hub.docker.com/layers/library/node/24.21-bookworm-slim/images/sha256-416b98170fe691cb97f8462baca6d83fcb951cc510175779ae0833b510ee287c).
It does not install or bundle FFmpeg/ffprobe. This avoids redistributing a Debian FFmpeg package
whose codec configuration and license inventory were not pinned and audited. The upstream Node
image includes Node.js and Debian system components with their own license files/notices in the base
image. Docker users who create a derived image with FFmpeg are responsible for auditing that exact
binary, codecs, source, notices, and checksum and including its obligations with their image.

## whisper.cpp and model catalog

OpenRepurpose does not distribute a whisper.cpp executable. The adapter accepts a configured, user-managed, or PATH-resolved executable. Upstream identifies whisper.cpp as MIT-licensed; optional build components may have different terms, so inspect the exact build configuration and notices before redistributing. Source: [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp).

Models remain user-controlled downloads. The catalog uses converted OpenAI Whisper weights from [the whisper.cpp Hugging Face repository](https://huggingface.co/ggerganov/whisper.cpp) and verifies upstream SHA-1 values recorded in `packages/media/src/model-manager.ts`. SHA-1 detects transfer/content mismatch but is not a modern provenance signature. OpenAI states Whisper code and weights are MIT-licensed ([OpenAI Whisper license](https://github.com/openai/whisper#license)). A checksum does not independently establish authorship, training-data rights, or suitability.

## Project license

OpenRepurpose is licensed under the GNU Affero General Public License version 3 only (AGPL-3.0-only).
The complete license is provided in the root `LICENSE` file and in each distribution artifact. The
canonical text is available from the [GNU Project](https://www.gnu.org/licenses/agpl-3.0.html).

For every binary release, publish its corresponding source from the same distribution location,
identified by the artifact's `build-metadata.json` source commit. Keep the source, lockfile, and build
scripts available for as long as the binary is offered. Modified versions that allow remote network
interaction must prominently offer users access to the corresponding source as required by AGPLv3
section 13; see the license for the complete terms.
