#!/bin/sh
set -eu

artifact_directory=${1:?Usage: scripts/smoke-linux-artifact.sh <artifact-directory>}
artifact_directory=$(CDPATH= cd -- "$artifact_directory" && pwd)
archive="$artifact_directory/OpenRepurpose-linux-x64.tar.xz"
[ -f "$archive" ] || { echo "Artifact archive was not found: $archive" >&2; exit 1; }

clean_install="$artifact_directory/clean-install"
clean_profile="$artifact_directory/clean-user-profile"
rm -rf "$clean_install" "$clean_profile"
mkdir -p "$clean_install" "$clean_profile/tmp"
tar -xJf "$archive" -C "$clean_install"
launcher="$clean_install/OpenRepurpose/openrepurpose"
[ -x "$launcher" ] || { echo "Artifact launcher was not executable: $launcher" >&2; exit 1; }

run_clean() {
  env -i \
    HOME="$clean_profile/home" \
    XDG_CONFIG_HOME="$clean_profile/config" \
    XDG_DATA_HOME="$clean_profile/data" \
    TMPDIR="$clean_profile/tmp" \
    PATH=/usr/bin:/bin \
    PORT=39100 \
    APP_URL=http://127.0.0.1:39100 \
    "$@"
}

run_clean "$launcher" doctor
[ -d "$clean_profile/config/OpenRepurpose" ]
[ -d "$clean_profile/data/OpenRepurpose" ]

run_clean "$launcher" start --headless >"$artifact_directory/linux-artifact-server.log" 2>&1 &
server_pid=$!
cleanup() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

"$clean_install/OpenRepurpose/runtime/bin/node" -e '
const base = process.argv[1];
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    const health = await fetch(`${base}/api/health`);
    const ui = await fetch(`${base}/`);
    if (health.ok && (await health.json()).status === "ok" && ui.ok && (await ui.text()).includes("<div id=\"root\">")) process.exit(0);
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 250));
}
process.exit(1);
' http://127.0.0.1:39100
