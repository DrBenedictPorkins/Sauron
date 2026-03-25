# Sauron

**The Eye that watches all your projects.**

Sauron is a local dashboard that scans your development directories, tracks every project's git activity, flags uncommitted changes, detects tech stacks and integrations, and generates AI-powered summaries. It groups projects by how recently they were touched so you can see at a glance what needs your attention.

![Dashboard](assets/screenshots/dashboard.jpeg)

Projects are organized into temporal buckets (last 7 days, 14 days, 30 days, etc.) with color-coded sections. Each card shows the project type, uncommitted status, detected integrations, AI summary, and last commit info.

![Project Detail](assets/screenshots/project-detail.jpeg)

Click any project to see full details including git metadata, detected integrations, documentation status, and an AI-generated summary. From here you can trigger a rescan or open an AI chat session scoped to that project.

![AI Chat](assets/screenshots/ai-chat.jpeg)

The per-project AI chat can browse files, search code, run read-only git commands, and answer questions about the project. It uses Claude's tool-use to explore the codebase on demand.

---

## Quick Start

```bash
git clone https://github.com/DrBenedictPorkins/Sauron.git
cd Sauron
npm install
cp .env.example .env
```

Edit `.env` with your settings:

```
ANTHROPIC_API_KEY=sk-ant-...
SCAN_ROOTS=~/projects:Projects,~/dev:Dev
CLAUDE_MODEL=claude-haiku-4-5
```

Run it:

```bash
npm start
```

Open `http://127.0.0.1:7777` (or whatever `HOST:PORT` you set). Click **Quick Scan** to discover projects and gather metadata, then **Deep Scan** to regenerate all AI summaries.

---

## How It Works

### Scanning

Sauron recursively walks the directories listed in `SCAN_ROOTS`. A directory is identified as a project if it contains `.git`, `package.json`, `pyproject.toml`, or `*.xcodeproj`. Directories without these markers are treated as grouping folders (e.g. `~/dev/firefox-extensions/` contains projects, but isn't one itself).

Two scan modes:

- **Quick Scan** -- Full directory crawl, collects git metadata (last commit, branch, uncommitted changes, 30-day commit count), detects project type, languages, integrations. No AI calls. Fast and free.
- **Deep Scan** -- Everything Quick Scan does, plus sends project context (README, CLAUDE.md, recent git log) to Claude for a 2-3 sentence summary and status classification (Active, Stale, Abandoned, Early Stage). Summaries are cached and only regenerated when new commits are detected.

Scans can also be triggered per temporal bucket or per individual project from the UI.

### Project Detection

| Signal | Detected As |
|--------|------------|
| `package.json` with `electron` dep | Electron |
| `package.json` with `react-native` dep | React Native |
| `package.json` with `next` dep | Next.js |
| `package.json` with `react` dep | React |
| `package.json` + `tsconfig.json` | TypeScript |
| `package.json` (plain) | Node.js |
| `pyproject.toml` or `setup.py` | Python |
| `*.xcodeproj` | Swift |
| `.git` only (no config files) | Scans file extensions to detect language |

### Integration Detection

Sauron checks `package.json` dependencies and `pyproject.toml` contents for known libraries: Slack, Discord, MCP, Electron, OpenAI, Anthropic, LangChain, AWS, Supabase, Stripe, Pulumi. It also detects Docker via `Dockerfile` or `docker-compose.yml`.

### AI Chat

Each project gets a scoped chat session powered by Claude. The AI has access to read-only tools:

- **list_directory** -- Browse the file tree
- **read_file** -- Read file contents (with offset/limit for large files)
- **get_file_info** -- File metadata (size, modified date, line count)
- **search_files** -- Grep for patterns across the project
- **git_command** -- Run read-only git commands (log, diff, blame, branch, etc.)

No write operations are allowed. File access is sandboxed to the project directory.

Chat sessions persist per project. **Condense** compresses the conversation history using AI (aggressive compression for old turns, light compression for recent ones) to save context. **Clear** wipes the session entirely.

### Configuration

All configuration lives in `.env`. Copy `.env.example` to get started.

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Claude API key (required) | -- |
| `SCAN_ROOTS` | Comma-separated `path:label` pairs | -- |
| `CLAUDE_MODEL` | Model alias for all AI calls | `claude-haiku-4-5` |
| `HOST` | Server bind address | `127.0.0.1` |
| `PORT` | Server port | `7777` |
| `ACTIVE_CUTOFF_DAYS` | How far back to look for "active" projects | `30` |
| `QUICK_SCAN_TOP_N` | Max projects in a targeted quick scan | `20` |
| `MAX_SUMMARIES_PER_SCAN` | Max AI summaries per deep scan (recent projects first) | `50` |
| `IGNORE_PATHS` | Comma-separated directory paths to skip | -- |
| `SCHEDULE_ENABLED` | Enable automatic scanning | `false` |
| `SCHEDULE_QUICK_CRON` | Cron for automatic quick scans (metadata only) | `*/30 * * * *` (every 30 min) |
| `SCHEDULE_DEEP_CRON` | Cron for automatic deep scans (metadata + AI summaries) | `0 18 * * *` (6pm daily) |

### Cost

All AI calls use the model specified in `CLAUDE_MODEL` (defaults to Haiku). Costs are tracked per scan and displayed in the UI header.

Typical costs:
- Quick Scan: **$0.00** (no AI calls)
- Deep Scan (50 summaries): **~$0.05-0.10**
- Chat message: **~$0.001-0.005** per turn

### Tech Stack

- **Backend**: Node.js, Express, better-sqlite3
- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **AI**: Anthropic Claude API (streaming, tool use)
- **Scheduling**: node-cron

### Data

All data stays local. `sauron.db` (SQLite) stores project metadata and scan history. The `.env` file holds your API key and scan paths. Neither is committed to git.

## License

MIT
