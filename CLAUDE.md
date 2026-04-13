# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Run the server (production)
npm run dev        # Run with nodemon (auto-restart on changes)
```

No test framework, linter, or build step is configured. The app is plain Node.js (no transpilation).

## Configuration

All config lives in `.env` (copy `.env.example` to start). Key variables:
- `ANTHROPIC_API_KEY` — required for AI features (summaries, chat)
- `SCAN_ROOTS` — comma-separated `path:label` pairs (e.g. `~/dev:Dev,~/projects:Projects`)
- `CLAUDE_MODEL` — model alias for all Anthropic API calls (default: `claude-haiku-4-5`)
- `HOST`/`PORT` — server bind address (default: `127.0.0.1:7777`)

## Architecture

Sauron is a local project dashboard that scans dev directories, tracks git activity, and generates AI summaries. Backend is Express + SQLite (better-sqlite3). Frontend is vanilla HTML/CSS/JS served as static files.

### Module layout (`src/`)

- **`index.js`** — Entry point. Starts Express server and optional cron schedules.
- **`config.js`** — Reads `.env` into a config object. Parses `SCAN_ROOTS` and `IGNORE_PATHS`.
- **`models.js`** — Exports `MODEL` name and per-token pricing constants from env.
- **`api/index.js`** — Express routes. REST API for projects, scans, chat, and config. Serves `ui/` as static.
- **`db/index.js`** — SQLite layer. Auto-migrates schema on first access (WAL mode). Two tables: `projects` and `scan_runs`. Uses upsert on project path.
- **`scanner/index.js`** — Filesystem crawler. Walks `SCAN_ROOTS` up to depth 4, classifies directories as projects by markers (`.git`, `package.json`, `pyproject.toml`, `*.xcodeproj`). Non-project dirs are treated as grouping folders and recursed into.
- **`scanner/orchestrator.js`** — Coordinates the three scan phases: discover -> analyze -> summarize. Manages scan state, progress tracking, and stop requests. Only deep scans trigger AI summaries.
- **`analyzer/index.js`** — Per-project analysis. Gathers git metadata (last commit, 30-day count, branch, uncommitted status), detects project type and languages, finds integrations in `package.json`/`pyproject.toml`, reads README/CLAUDE.md for AI context.
- **`summarizer/index.js`** — Calls Claude API to generate 2-3 sentence project summaries with status classification. Tracks token usage and cost.
- **`chat/index.js`** — Per-project AI chat with tool use. Provides 5 read-only tools (list_directory, read_file, get_file_info, search_files, git_command). Sessions are in-memory Maps keyed by project ID. Supports conversation condensation via AI.

### Frontend (`ui/`)

Single-page app: `index.html`, `style.css`, `app.js`. Communicates with backend via REST + SSE (for chat streaming).

### Data flow

1. **Quick scan**: crawler finds projects -> analyzer gathers git/integration metadata -> upserted to SQLite
2. **Deep scan**: same as quick + summarizer sends project context to Claude API -> summary stored in DB
3. **Chat**: SSE stream, tool-use loop — Claude calls read-only tools, results fed back until final text response

### Key design decisions

- Project IDs are SHA-1 hashes of the absolute path (first 12 chars)
- Chat tool execution is sandboxed: paths are resolved and validated to stay within project root; git commands are allowlisted to read-only subcommands
- Summaries are cached by commit hash — deep scan regenerates all summaries (sorted by recency, capped by `MAX_SUMMARIES_PER_SCAN`)
- Database migrations are additive (ALTER TABLE ADD COLUMN wrapped in try/catch)
