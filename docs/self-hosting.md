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
dedicated account. A native Windows service wrapper is intentionally not bundled yet. Docker and
Compose are owned by v0.9 Packet 6 and are not required for headless operation.
