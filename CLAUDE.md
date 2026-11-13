# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Run the server (production)
npm run dev        # Run with nodemon (auto-restart on changes)
```

No test framework, linter, or build step is configured. The app is plain Node.js (no transpilation).

## Launcher

`~/Applications/Sauron.app` is an AppleScript applet whose only action is:

```
do shell script "/Users/makram/dev/sauron/start.sh > /tmp/sauron-launch.log 2>&1"
```

`start.sh` starts the server if port 7777 isn't already listening (logs to `/tmp/sauron.log`), waits for it, then opens the dashboard in a **dedicated Chrome instance** — its own profile at `~/.sauron-chrome`, launched with `--app=` so it's a chromeless window, not a tab in the user's normal browser. Chrome, not Firefox.

To kill the server, target the listener only:

```bash
lsof -nP -iTCP:7777 -sTCP:LISTEN | awk 'NR>1 {print $2}' | xargs kill
```

## Configuration

All config lives in `.env` (copy `.env.example` to start). Key variables:
- `ANTHROPIC_API_KEY` — required for AI features (summaries, chat)
- `SCAN_ROOTS` — comma-separated `path:label` pairs (e.g. `~/dev:Dev,~/projects:Projects`)
- `CLAUDE_MODEL` — model alias for all Anthropic API calls (default: `claude-haiku-5-5`; Claude 5.x only)
- `HOST`/`PORT` — server bind address (default: `127.0.0.1:7777`)

## Architecture

Sauron is a local project dashboard that scans dev directories, tracks git activity, and generates AI summaries. Backend is Express + SQLite (better-sqlite3). Frontend is vanilla HTML/CSS/JS served as static files.

### Module layout (`src/`)

- **`index.js`** — Entry point. Starts the Express server.
- **`config.js`** — Reads `.env` into a config object. Parses `SCAN_ROOTS` and `IGNORE_PATHS`.
- **`models.js`** — Exports `MODEL` name and per-token pricing constants from env.
- **`api/index.js`** — Express routes. REST API for projects, scans, chat, and config. Serves `ui/` as static.
- **`db/index.js`** — SQLite layer. Auto-migrates schema on first access (WAL mode). Three tables: `projects`, `scan_runs` and `project_links`. Uses upsert on project path.
- **`scanner/index.js`** — Filesystem crawler. Walks `SCAN_ROOTS` up to depth 4, classifies directories as projects by markers (`.git`, `package.json`, `pyproject.toml`, `*.xcodeproj`). Non-project dirs are treated as grouping folders and recursed into.
- **`scanner/orchestrator.js`** — Coordinates the scan phases: discover -> analyze -> check deps -> summarize -> find links (Deep Scan with `findLinks` only). Manages scan state, progress tracking, and stop requests. Only Deep Scan runs the summarize phase, and Deep Scan always targets an explicit project selection (a recency bucket or a single project) — there's no fleet-wide Deep Scan trigger.
- **`analyzer/index.js`** — Per-project analysis. Gathers git metadata (last commit, 30-day count, branch, uncommitted status), detects project type and languages, finds integrations in `package.json`/`pyproject.toml`, reads README/CLAUDE.md for AI context.
- **`docgen/index.js`** — One-shot CLAUDE.md / README.md drafting. Runs the same read-only tool loop as the chat, outside any chat session, and writes the result to `$TMPDIR/sauron-drafts/<project-id>/`. Never writes into the project; drafts are deleted when the UI dialog closes.
- **`links/index.js`** — Cross-project link finding, an optional Deep Scan phase ("Find links", ticked by default in the UI, off by default at the API). AI reads one project with the read-only chat tools (`.env` blocked) and reports identifiers it consumes/provides via a `report_links` tool; a local ripgrep then matches them across every tracked project, so the counterpart is found even if never Deep Scanned. Edges live in `project_links`, written from the scanned side and read from either side (`linksFor`). Route-only matches are dropped; identifiers matching >15 projects are dropped as boilerplate. Requires `rg`.
- **`summarizer/index.js`** — Calls Claude API to generate 2-3 sentence project summaries with status classification. Tracks token usage and cost.
- **`chat/index.js`** — Per-project AI chat with tool use. Provides 5 read-only tools (list_directory, read_file, get_file_info, search_files, git_command). There is deliberately no write tool: the AI never modifies a project. Sessions are in-memory Maps keyed by project ID. Supports conversation condensation via AI. Global chat gets `search_all_projects` (ripgrep across every tracked, non-ignored project) plus the same five tools with a `project` argument.

### Frontend (`ui/`)

Single-page app: `index.html`, `style.css`, `app.js`. Communicates with backend via REST + SSE (for chat streaming).

### Data flow

1. **Quick Scan**: crawler finds projects -> analyzer gathers git/dependency metadata -> upserted to SQLite. Free (no AI calls), can target the whole fleet or a scoped selection.
2. **Deep Scan**: same as Quick Scan + summarizer sends project context to Claude API -> summary stored in DB. Always scoped to an explicit `projectIds` selection (never fleet-wide); the UI shows a confirmation with a real historical cost estimate before it runs, and only regenerates summaries that actually need it (unless a single-project explicit force).
3. **Chat**: SSE stream, tool-use loop — Claude calls read-only tools, results fed back until final text response

### Key design decisions

- Three separate "ignore" concepts, easily confused:
  - `IGNORE_PATHS` (`.env`) — paths the filesystem crawler never descends into.
  - `projects.ignored` — the per-project **Ignore** toggle. Hides the project from the dashboard *and* excludes it from fleet scans (orchestrator filters discovered paths against it). An explicit `projectIds` selection still scans it, so a project can be refreshed by name from its own card.
  - `projects.deep_scan_ignored` — **Skip AI summaries**. Metadata still refreshes; only the summarize phase skips it.

- Project IDs are SHA-1 hashes of the absolute path (first 12 chars)
- Chat tool execution is sandboxed: paths are resolved and validated to stay within project root; git commands are allowlisted to read-only subcommands
- Summaries are cached by commit hash — Deep Scan only regenerates summaries that are missing or outdated for the confirmed selection (unless the single-project explicit force), and rejects selections larger than `MAX_SUMMARIES_PER_SCAN`
- Database migrations are additive (ALTER TABLE ADD COLUMN wrapped in try/catch)
