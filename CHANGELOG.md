# Changelog

All notable changes to Sauron are recorded here. Dates are commit dates.

## 1.2.0 — Unreleased

### Added
- **Find links to other projects**: an optional Deep Scan step, ticked by default. Claude reads the selected project's code and reports the hostnames, API routes, domains and cloud resource IDs it uses and serves. A local ripgrep search then finds those identifiers across every tracked project, including ones never Deep Scanned. Results appear under **Links to other projects** in each project, and Ask AI uses them. Requires `rg`.
- Global Ask AI can now search and read code across all tracked projects: `search_all_projects`, plus the per-project read-only tools with a `project` argument. It traces which project serves, handles or supports another through endpoints and resource IDs, not folder names.
- **Generate Docs**: drafts `CLAUDE.md` / `README.md` for a project into a temp folder, with Download and Open in Finder. It never writes into the project, and drafts are deleted when the dialog closes.
- Quick Scan confirmation shows when the last full-fleet scan ran, its result and typical duration, the directories to be walked, and that it costs nothing.
- The Deep Scan and Quick Scan dialogs list exactly what is examined, what is sent to Claude, and what is never sent.
- The active model name appears next to every cost figure.
- Doc-generation and link-finding costs are tracked per scan. Link-finding cost is estimated from its own history.

### Changed
- Default model is now `claude-haiku-5-5`. Only Claude 5.x models are supported.
- Pricing comes from a model-keyed table in `src/models.js`. `PRICE_INPUT_MTOK` / `PRICE_OUTPUT_MTOK` are now optional overrides, and the server refuses to start if `CLAUDE_MODEL` cannot be priced.
- Fleet Quick Scans skip projects marked **Ignore**. Scanning one by name from its card still works.
- The Deep Scan dialog is wider, and says how many projects were left out because they are already up to date.
- Output limits were raised for summaries (600), project chat (4096), condensation (4096) and global chat (32768), because thinking tokens count toward them.
- Dependencies upgraded to their latest versions: `@anthropic-ai/sdk` 0.133, Express 5, better-sqlite3 13, dotenv 18, nodemon 3.1.
- The launcher opens the dashboard in a dedicated Chrome app window (`~/.sauron-chrome` profile) instead of Firefox.

### Removed
- The chat `write_file` tool. The AI can no longer modify a project.

### Fixed
- The cost meter under-reported by about 3.75x when `CLAUDE_MODEL` and the price variables disagreed.
- Summaries and condensation crashed or came back empty when the first content block was a thinking block.
- A tool error, such as an invalid regex, no longer ends the whole chat. It is returned to the model as an error result.
- A chat reply now says when it was cut off at the output limit, instead of showing nothing.
- The chat path sandbox let a project reach a sibling folder whose name started with the same prefix.
- Patched dependency vulnerabilities (`npm audit fix`).

## 1.1.0 — 2026-04-13

### Added
- Markdown rendering in chat, and a resizable chat panel.
- Monorepo detection through subdirectory introspection.
- `has_git` tracking, with no-git and uncommitted labels.
- `CLAUDE.md` project docs and the `start.sh` launcher.

### Changed
- Default model set to `claude-sonnet-4-6`.

## 1.0.0 — 2026-03-25

### Added
- Initial release: scans the directories in `SCAN_ROOTS`, tracks git activity and dependencies, and generates AI summaries, with a local web dashboard and per-project AI chat.
- All configuration moved to `.env`.
- README with screenshots, and the MIT license.
