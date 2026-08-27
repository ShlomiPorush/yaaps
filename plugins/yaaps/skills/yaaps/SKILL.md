---
name: yaaps
description: Connect to YAAPS and publish or manage temporary HTML reports. Use when a user wants to share a report through YAAPS or list, inspect, categorize, disable, enable, or delete YAAPS drafts.
license: MIT
---

# YAAPS

Use the bundled OS helper. Do not install Node.js, npm, Python, jq, or a separate YAAPS CLI as a workaround; the helper reuses whatever JSON runtime is already present.

## Select the helper

- Windows: run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<skill-directory>\scripts\yaaps.ps1" <command>`. Use `pwsh` instead when that is the available PowerShell host.
- macOS and Linux: run `/bin/sh "<skill-directory>/scripts/yaaps.sh" <command>`. The helper needs `curl` plus one already-installed JSON runtime, chosen automatically in this order: `osascript` (macOS), `node`, then `python3`. If none is present it exits with a clear message instead of guessing.

Resolve `<skill-directory>` to this skill's installed directory. Keep it quoted. Each helper writes JSON events or results to stdout and diagnostics to stderr.

## Safety and authorization

- Never ask for, print, inspect, log, or place an API key in a command. The helper generates and reads credentials internally.
- If a key appears in chat, do not use or repeat it. Tell the user to revoke it and reconnect.
- Publishing, categorizing, disabling, enabling, and deleting mutate the user's YAAPS account. Perform only the requested operation.
- Delete only after explicit authorization for the exact draft ID. First inspect it and state its title and public URL. Then pass the same ID as the positional ID and `--confirm` value. Offer `disable` when permanent deletion is unnecessary.
- Do not blindly retry an ambiguous publish. Use `list` and `inspect` to determine whether the version was created.

## Connect

1. Run `<helper> config show`.
2. When configuration is missing, run `<helper> connect --label <label>`. The helper connects to https://yaaps.net by default; pass `--api-url <origin>` only for a self-hosted instance. Use a recognizable label of at most 100 characters without secrets. Add `--no-open` only in a headless environment.
3. Keep that process attached. Its first JSON line has `status: "pending"`, `verificationUrl`, `userCode`, and `expiresAt`. Present the URL and code immediately and ask the user to approve them. The helper normally opens the default browser too.
4. Wait for the second JSON line. Treat connection as successful only when it has `status: "approved"`. Denial or expiry requires a new connection attempt only if the user wants to retry.
5. Confirm with `<helper> config show`, `<helper> list --limit 1`, and `<helper> status`.

The full key is created locally, the server receives only its hash and non-secret prefix before approval, and the key is stored only after approval. Never implement separate polling or parallel connection attempts.

## Publish

Publish only when asked. The input must already be one complete HTML file. The helpers send the file unchanged, so embed local files before publishing. Never add scripts, event handlers, forms, frames, plugins, HTTP resources, or fetch-capable constructs.

Before running `publish`, inspect the final HTML and choose the resource policy mechanically:

- Use `connected` whenever the HTML contains an automatically loaded HTTPS image, an external HTTPS stylesheet, or an HTTPS CSS `url()`, including a web font in `@font-face`. Tell the user that opening the report contacts third-party servers and that those resources can change or disappear later.
- Use `isolated` only when every automatically loaded resource is embedded in the HTML and the only HTTPS URLs are hyperlinks that a reader chooses to open. `isolated` is the default, but the default does not override this inspection.

If the user requires `isolated` publishing or declines third-party contact, remove or embed the external dependencies before publishing. Never publish HTML with automatic external loads as `isolated`, and do not rely on a failed isolated publish to choose the mode.

Both modes reject HTTP resources, scripts, event handlers, forms, frames, plugins, CSS imports, and other executable or unsafe resource constructs.

- New draft: `<helper> publish <file> [--mode isolated|connected] [--category <name>] [--title <title>] [--ttl <seconds>]`
- New immutable version: identify the intended draft first, then run `<helper> publish <file> --draft-id <draft-id> [--mode isolated|connected] [--category <name>] [--title <title>] [--ttl <seconds>]`

A category is a single free-text label of at most 100 characters that groups related reports; a draft has at most one. Pass `--category` only when the user names a group or an existing category clearly applies. Publishing a new version with `--category` replaces the draft's stored category, so omit the flag to keep it.

The helpers intentionally do not infer drafts from local file paths. Inspect the JSON response and return `draft.publicUrl`, plus the draft ID and `version.versionNumber` when useful.

## Manage drafts

- List: `<helper> list [--limit <number>] [--offset <number>] [--category <name>]`. The category filter is an exact, case-sensitive match; use `list` without it to discover the categories in use.
- Inspect with versions: `<helper> inspect <draft-id>`
- Categorize: `<helper> categorize <draft-id> <category>` to set or change the category, `<helper> categorize <draft-id> --clear` to remove it. Pass exactly one of the two.
- Disable: `<helper> disable <draft-id>`, then inspect it.
- Enable: `<helper> enable <draft-id>`, then inspect it.
- Delete after exact authorization: `<helper> delete <draft-id> --confirm <draft-id>`.

Always include relevant `publicUrl` values when reporting results. After deletion, report the previously inspected URL without implying that it remains available.
