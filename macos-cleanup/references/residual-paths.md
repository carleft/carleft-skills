# Residual paths (for planning only)

Use this map to tell the user what a future uninstall would also touch. The audit itself never deletes.

## Ownership key

`<id>` is the app's `CFBundleIdentifier`, or the package id from `pkgutil --pkgs`, or the cask token. Prefer the bundle id; fall back to the app name only when no bundle id exists.

## Paths to check

| Path | Present when |
|---|---|
| `~/Library/LaunchAgents/<label>.plist` | the app registered a user agent |
| `/Library/LaunchAgents`, `/Library/LaunchDaemons` | system-wide agent or daemon (needs sudo to remove) |
| `~/Library/Application Support/<id or name>` | app data |
| `~/Library/Preferences/<id>.plist` | preferences |
| `~/Library/Preferences/ByHost/<id>.*.plist` | per-machine preferences |
| `~/Library/Caches/<id>` | caches (safe to drop first) |
| `~/Library/Saved Application State/<id>.savedState` | window restore state |
| `~/Library/Containers/<id>` | sandboxed app data |
| `~/Library/Group Containers/<team>.<group>` | shared container; may be used by several apps |
| `~/Library/Logs/<name>` | logs |
| `~/Library/WebKit/<id>` | web storage |
| `/private/var/db/receipts/<pkgid>.plist` and `.bom` | installed via pkg installer |
| `/usr/local/bin/<tool>`, `/opt/<vendor>` | manual or legacy install |
| System Settings → Login Items / "Allow in Background" | SMAppService registrations |

## Apply order for a future phase

1. Quit the app; confirm no process holds its files (`lsof`).
2. Boot out launchd jobs: `launchctl bootout gui/$UID/<label>`.
3. Move the `.app` to Trash (never `rm`), or use the vendor's uninstaller.
4. Move residue to Trash, one owner at a time, recording each move in a manifest.
5. After files are gone, `pkgutil --forget <pkgid>` for stale receipts only.
6. Verify: no launchd job reloads, no broken symlink remains, app list unchanged elsewhere.

## Do not touch

- `Containers` / `Group Containers` of apps that are still installed.
- Keychain items (`security delete-*`) without an explicit request; they are not recoverable from Trash.
- `/Library/Application Support` shared by multiple apps — check references first.
- Anything SIP-protected or under `/System`.
