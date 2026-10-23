# Risk model

## Severity is about evidence, not size

| Level | Requires | Example |
|---|---|---|
| high | Proof the system is already broken | LaunchAgent's `Program` path does not exist |
| medium | A concrete, nameable fix | `/etc/paths.d/10-pmk-global` points to a missing dir; 7 symlinks into a deleted `Docker.app` |
| low | Correctness or hygiene, no failure today | Duplicate rc line, same PATH dir added by two files |
| info | Missing provenance only | 24 apps with no cask/MAS receipt |

Never raise severity because something is old, large, unfamiliar, or unused-looking. Never lower severity because a fix is easy.

## Evidence bar for a removal plan

Every proposed item must carry:

1. Absolute path.
2. Why it is considered removable (one of: target missing, owning app absent, duplicate of item X, explicitly disabled by user).
3. What still depends on it — check for running processes, other symlinks, and mentions in rc files.
4. Reversal: where it goes (Trash, backup copy) and what to restore.
5. Blast radius: user-level, system-wide, or requires sudo.

If any of 1–4 cannot be filled in, the item stays in the report as `info`, not in the plan.

## Never propose removal without explicit intent

- Anything under `~/Documents`, `~/Desktop`, `~/Pictures`, `~/Movies`, `~/Music`.
- Active git repositories (uncommitted changes or unpushed commits).
- Files opened in the last 30 days.
- Anything under `/System`, `/usr/lib`, SIP-protected paths, or owned by a signed system package.
- Preferences or containers of apps that are still installed.
- TCC, keychain, and Full Disk Access entries.

## Fixed boundaries

- The audit itself must not need sudo. If a check would require it, report the limitation instead of escalating.
- A future apply phase must boot out launchd jobs before removing their files, use Trash or a manifest-backed backup instead of `rm`, and write an undo record for every action.
- One confirmation covers one item. A blanket "yes" to a plan listing 20 items does not authorize item 21 discovered later.
