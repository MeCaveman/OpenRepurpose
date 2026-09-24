# Uninstall and data removal

Uninstalling the executable does not delete local state. Back up anything you need before removal.

1. Stop every OpenRepurpose server, worker, scheduled task, service, and CLI process.
2. Optionally create a portable backup. Remember that it excludes secrets and media.
3. Remove the extracted portable release or source checkout.
4. Remove any Task Scheduler/systemd entry, reverse-proxy configuration, firewall rule, and Docker
   container/image that you created.
5. To erase local state, locate exact paths with `openrepurpose config show`, verify them, then remove
   the OpenRepurpose configuration, data, and managed temp directories deliberately.
6. Remove separately configured media directories, FFmpeg/whisper binaries, models, and backups only
   if they are no longer needed by another installation.
7. Revoke access in each platform connected-app dashboard and rotate any LAN, REST API, webhook, or
   reverse-proxy credentials that may have been copied elsewhere.

For Docker, `docker compose down` keeps named volumes. Removing volumes is a separate destructive
choice; inspect them first. Deleting a source checkout never removes host-native application data.

If only one account should be removed, disconnect it in **Accounts** instead of deleting the entire
installation. Platform-side revocation remains the authoritative way to invalidate issued tokens.
