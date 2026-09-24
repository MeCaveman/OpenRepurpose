# Docker and headless deployment

OpenRepurpose can run without an open browser. Jobs, schedules, watched folders, source polling,
webhooks, and retries belong to the server/job runner and survive browser closure.

## Docker Compose

The repository `Dockerfile` and `docker-compose.yml` provide the technical-user path. Generate a
long random LAN boundary token, create the authorized media directory, then build and start:

```powershell
$env:LAN_ACCESS_TOKEN = (New-Guid).Guid + (New-Guid).Guid
New-Item -ItemType Directory -Force media | Out-Null
docker compose up --build -d
```

Compose publishes only to host loopback by default. The container process listens on `0.0.0.0`, so
authenticated LAN mode is still required at the application boundary. Never commit the access
token, OAuth credentials, webhook secrets, or `.env` file.

Named volumes persist configuration, SQLite/application data, models, and managed temporary files.
The `/media` bind mount is read-only by default. The image does not contain FFmpeg/ffprobe,
whisper.cpp, or models. Create a derived image only after choosing and documenting exact binary
provenance and licenses.

## LAN, VPS, and reverse proxy

OpenRepurpose binds to loopback by default. Any non-loopback `BIND_HOST` or public `APP_URL` requires
`LAN_ENABLED=true` and `LAN_ACCESS_TOKEN`. Use HTTPS. Prefer a reverse proxy and expose only the
proxy; set `TRUST_PROXY=true` only when untrusted clients cannot reach the backend directly.

Browser/static access uses the LAN Basic-auth boundary. REST clients also require their own
revocable bearer token. Health endpoints are intentionally narrow. OpenRepurpose does not manage
DNS, certificates, firewall rules, or router configuration.

See [headless and LAN deployment](self-hosting.md) for the complete variables, mount table, systemd
unit, TLS options, and reverse-proxy threat model.
