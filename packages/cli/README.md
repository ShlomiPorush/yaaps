# YAAPS CLI

This package is the command-line client for [YAAPS](https://yaaps.net), which turns HTML reports created by AI agents into temporary shareable links. It works with yaaps.net by default and with any self-hosted instance via `--api-url`.

```sh
npm install -g yaaps-ai
```

The installed command is `yaaps`.

Connect without copying an API key into the agent or shell command. The CLI
creates the key locally, creates a short-lived approval request, and stores the
credential only after the signed-in user approves it in YAAPS:

```sh
yaaps connect --label "My agent"
```

The CLI talks to https://yaaps.net by default; pass `--api-url` to use a
self-hosted instance.

The command opens the approval page in the default browser and waits for the
decision. Use `--no-open` on a headless machine. JSON mode does not open a
browser unless `--open` is explicitly supplied.

The server receives only the key hash and non-secret prefix. Manual
`yaaps config set` remains available as a fallback for an API key created in
the dashboard, but it should be run by the user in a private terminal rather
than through an agent-visible command.

Publish a complete HTML document. Supported local bitmap references in HTML and CSS are embedded without modifying the source file:

```sh
yaaps publish ./report.html --title "Weekly report"
```

Publishing uses `--mode isolated` by default. Isolated reports may contain
HTTPS hyperlinks, but they cannot load network resources. Use connected mode
when a sketch or report intentionally depends on HTTPS images, stylesheets, or
CSS resources such as web fonts:

```sh
yaaps publish ./prototype.html --mode connected
```

Connected mode preserves HTTPS image URLs, HTTPS URLs in CSS, and only
`<link rel="stylesheet" href="https://...">` stylesheet links. Both modes
continue to reject HTTP resources, scripts, event handlers, forms, frames,
plugins, CSS imports, and other executable or unsafe resource constructs.
Local bitmap files are embedded in either mode.

Publishing the same local file again creates a new immutable version under its mapped draft. Use `--new-draft` to deliberately replace that mapping.

Add `--category` to group related reports under one label. Publishing a new version with `--category` updates the stored category:

```sh
yaaps publish ./report.html --title "Weekly report" --category "Sales"
yaaps list --category "Sales"
```

Management commands include:

```sh
yaaps status
yaaps connect --label "My agent"
yaaps list
yaaps list --category "Sales"
yaaps inspect <draft-id>
yaaps categorize <draft-id> "Sales"
yaaps categorize <draft-id> --clear
yaaps disable <draft-id>
yaaps enable <draft-id>
yaaps delete <draft-id> --confirm <draft-id>
```

`YAAPS_API_URL`, `YAAPS_API_KEY`, and `YAAPS_CONFIG_DIR` may be used instead of stored configuration. Command output never prints a complete stored API key.
