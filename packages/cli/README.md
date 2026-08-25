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

Publishing the same local file again creates a new immutable version under its mapped draft. Use `--new-draft` to deliberately replace that mapping.

Management commands include:

```sh
yaaps status
yaaps connect --label "My agent"
yaaps list
yaaps inspect <draft-id>
yaaps disable <draft-id>
yaaps enable <draft-id>
yaaps delete <draft-id> --confirm <draft-id>
```

`YAAPS_API_URL`, `YAAPS_API_KEY`, and `YAAPS_CONFIG_DIR` may be used instead of stored configuration. Command output never prints a complete stored API key.
