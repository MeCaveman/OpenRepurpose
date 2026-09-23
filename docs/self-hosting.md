# Headless and LAN deployment

OpenRepurpose binds to `127.0.0.1` by default. It never opens firewall ports, changes router
configuration, or enables UPnP. Background jobs, schedules, watched folders, and webhooks run
without a browser, so a normal server process is already suitable for headless use.

## Explicit LAN mode

Set all of the following before binding beyond loopback or using a non-loopback `APP_URL`:

```text
LAN_ENABLED=true
LAN_ACCESS_TOKEN=<at-least-32-random-characters>
BIND_HOST=0.0.0.0
APP_URL=https://openrepurpose.example.net
PORT=3000
```

`LAN_ACCESS_TOKEN` protects browser/static access with HTTP Basic authentication. Use the username
`openrepurpose`; do not put the token in a URL. REST clients must additionally use a revocable API
token in `Authorization: Bearer ...`; create it locally with:

```text
openrepurpose api token create automation
openrepurpose api token create observer --read-only
```

The created API token is printed once. It is stored only as a verifier and can be revoked with
`openrepurpose api token revoke <token-id>`. `openrepurpose config show` displays the effective
hosting state without printing either token.

LAN mode leaves `GET /api/health` and `GET /api/v1/health` available for constrained health checks.
Every other route, including the browser session endpoint and static UI, requires the LAN browser
credential. API permission checks remain in force after the LAN boundary.

## TLS and reverse proxies

For native TLS, provide both absolute paths:

```text
TLS_CERT_PATH=/etc/openrepurpose/tls/fullchain.pem
TLS_KEY_PATH=/etc/openrepurpose/tls/privkey.pem
```

If both are absent, a LAN binding emits a startup warning because it serves plain HTTP. Prefer a
TLS-terminating reverse proxy. Set `TRUST_PROXY=true` only when OpenRepurpose is reached solely
through the proxy and the proxy connection is protected by host firewall rules; forwarded headers
from arbitrary clients are not trustworthy. Keep the server on `127.0.0.1` behind a local proxy
where practical, but still set `LAN_ENABLED=true` and `LAN_ACCESS_TOKEN` because the public
`APP_URL` is non-loopback.

Do not expose the plain backend port through the firewall. Configure the proxy to terminate HTTPS,
pass the original Host header, and require its own authentication in addition to the application
credential where appropriate. OpenRepurpose does not supply certificates or manage DNS.

## Service operation

Linux systemd example (`/etc/systemd/system/openrepurpose.service`):

```ini
[Unit]
Description=OpenRepurpose
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=openrepurpose
EnvironmentFile=/etc/openrepurpose/openrepurpose.env
ExecStart=/usr/local/bin/openrepurpose start --headless
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Store the environment file with restrictive permissions and keep it out of source control. On
Windows, use Task Scheduler to run `openrepurpose start --headless` at system startup under a
dedicated account. A native Windows service wrapper is intentionally not bundled yet.

## Optional Docker Compose deployment

The repository includes an optional [`Dockerfile`](../Dockerfile) and
[`docker-compose.yml`](../docker-compose.yml). The image is built from `node:24-bookworm-slim`,
installs FFmpeg and ffprobe from Debian, serves the production web bundle from the server, and runs
as the unprivileged `node` user. It is not required for normal Windows/Linux installation.

Compose binds the published port to `127.0.0.1` on the host, but the process inside the container
must listen on `0.0.0.0`. Therefore Compose enables the existing authenticated LAN mode and requires
an operator-provided token; no token, OAuth credential, API token, webhook secret, or `.env` file is
copied into the image or committed to the repository:

```powershell
$env:LAN_ACCESS_TOKEN = (New-Guid).Guid + (New-Guid).Guid
New-Item -ItemType Directory -Force media | Out-Null
docker compose up --build -d
```

Use a secret manager or an untracked environment file for long-lived deployments. If the service
must be reachable beyond the local host, change the host port binding deliberately and follow the
LAN/TLS and reverse-proxy guidance above.

The Compose mounts are intentional:

| Mount                           | Purpose                                                               | Persistence/permission                                              |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `/etc/openrepurpose`            | Session key, encrypted secret-vault key, and other config-owned files | Named writable volume; back up as sensitive data                    |
| `/var/lib/openrepurpose/data`   | SQLite database, imported metadata, derivatives, and application data | Named writable volume; back up while the service is stopped         |
| `/var/lib/openrepurpose/models` | Explicitly downloaded Whisper model files                             | Named writable volume; models are not downloaded during image build |
| `/var/lib/openrepurpose/tmp`    | Managed temporary files                                               | Named writable volume; safe to recreate after shutdown              |
| `/media`                        | User-owned source media supplied to workflows                         | Explicit host bind mount, read-only by default                      |

The image includes FFmpeg/ffprobe, but does not include whisper.cpp or any model. Local
transcription remains unavailable until a compatible whisper.cpp executable is supplied through the
normal executable-discovery configuration and the requested model is explicitly downloaded into the
model volume. The image does not grant the application access to arbitrary host paths: add only the
media directories that the deployment is authorized to read, and use a read-write mount only when a
specific workflow requires it.
