# Changelog

## [0.1.7] - 2026-03-08

### Added
- **Discussion commenter filter**: a filter button in the Discussion section header opens a dropdown with a checkbox per commenter; unchecking a user hides all their comments; preference persisted in `localStorage`
- **Collapsible PR header**: when the reviewers/info section exceeds 370 px, it is clamped with a fade and a "See all" button to expand it
- **Collapsible file list preview**: when a PR is not checked out and the changed-files list exceeds 500 px, it is clamped with a "See all N files" expand button

### Fixed
- Large PRs (e.g. 1 000+ files) crashing the panel: replaced `gh pr view --json files` (capped at 100) with paginated REST API calls using `--paginate --jq '.[]'` to produce valid NDJSON, parsed line-by-line
- `TypeError: Cannot read properties of undefined (reading 'split')` in `FilesSection` caused by the REST API returning `filename` instead of the expected `path` field — normalized in a `fetchPrFiles` mapping layer
- `currentBranch` state threaded correctly through `AppState`, `PrPanelProvider`, and `App.tsx` so the "My Branch" tab label reflects the live Git branch

### Removed
- Previous/next diff navigation buttons (keybindings, menu items, and commands) — they were non-functional

---

## [0.1.6] - 2026-03-07

### Fixed
- Extension showing "Reviewing #X" after manually switching branches outside VS Code and restarting the IDE
- Fork PRs with `main` as the head branch (e.g. `alvintuo:main → elastic:main`) falsely triggering the PR restore flow on startup
- Checkout button becoming re-enabled after re-selecting an already checked-out PR
- "Open Kibana" button remaining disabled after a successful checkout
- "Owned by me" filter toggle causing the panel to jump

### Added
- Real-time branch-change detection: when VS Code regains focus, the extension checks if the current git branch still matches the checked-out PR and resets to "My Branch" if not
- Marketplace icon (PNG) and updated `.gitignore`

### Changed
- Second tab label renamed from "Reviewing" to **"My Branch"** when no PR is being reviewed

---

## [0.1.5] - 2026-03-06

### Added
- **Wrong repository detection**: when a non-Kibana repository is open, the panel shows a "Not a Kibana workspace" placeholder instead of the full UI, and all GitHub API calls are suppressed
- **`react-markdown`** replaces the custom regex-based markdown parser, enabling full GitHub Flavored Markdown rendering (tables, task lists, strikethrough, fenced code blocks)
- **Collapsible `<details>`/`<summary>` elements** in PR bodies and comments, including nested levels
- **Buildkite CI status** row in the PR info header (status badge + link to latest build)
- **File ownership bar** in the PR header showing the split between files owned by the selected team vs. other teams — visible even when a PR is not checked out
- **Loading spinner** component replacing all `⟳` icons; Build and Files rows always show their labels with a spinner while data loads
- **Synthtrace row** in the ActionSection: scenario selector, settings icon, "Run synthtrace" button, and "live" checkbox
- **Toggle button** in ActionSection to show/hide "Start Elasticsearch", "Start Kibana", "Open Kibana", and the synthtrace row
- **Kibana boot status**: yellow icon while Kibana is starting, green when fully available; "Run synthtrace" disabled when Kibana is not running
- **Team selector** in the Review Queue (persisted across restarts); filters Unreviewed/In Review/Approved buckets by selected team
- **"Show/hide own PRs"** toggle button next to the team selector
- **Reviewer names** from the selected team shown on PR cards in the queue
- **Team name** appended to bucket labels ("Unreviewed by obs-onboarding-team", etc.)
- **Uncommitted changes dialog** on checkout: prompts to discard changes (`git reset --hard` + `git clean -f -d`) before proceeding
- **Semi-transparent overlay** on the Changed Files section when a PR is not checked out, with "Check out branch to see files in IDE" message
- **Approve** and **Request changes** buttons in the Discussion section
- **GitHub Actions workflow** for automated publishing to VS Code Marketplace and Open VSX Registry on version tag push, with manual trigger support
- ESLint with TypeScript + React support; Prettier integrated via ESLint and run on save
- `repository` field added to `package.json`; `LICENSE.md` (MIT) added

### Fixed
- File list now unblocks immediately after checkout, without waiting for `yarn kbn bootstrap`
- Progress toast removed during checkout (error toasts are kept)
- Scroll position reset to 0 when switching tabs
- PR queue count in tab title matching the visible (non-draft) PR list
- Extension Output panel no longer opens automatically on startup

### Changed
- Review Queue keeps existing PRs visible while refreshing; loading spinner replaces the count in the tab title during fetch
- Draft PRs excluded from the Review Queue entirely
- `coderabbitai` excluded from "in review" logic

---

## [0.1.4] - 2026-03-04

### Added
- PR Review Queue divided into three foldable buckets: **Unreviewed**, **In Review**, **Approved** (each sorted newest-first)
- Bot reviewers in the reviewers table show a 🤖 icon instead of ⚡
- "Awaiting review" badges use a yellow disc instead of grey
- Bare GitHub PR/issue URLs shortened to references (e.g. `#254943 (comment)`)
- GitHub issue/PR references (e.g. `Fixes #232699`) rendered as links
- `<img>` tags in PR bodies rendered as actual images
- Markdown tables with images rendered correctly
- GitHub emoji shortcodes (`:yellow_heart:`) rendered as actual emojis
- LLM prompt for "Suggest review order" logged to extension output

### Fixed
- PR #256096 not appearing in "In review" bucket despite team member comments
- `flash1293` appearing twice in the reviewers table
- `couvq` missing team membership in the reviewers table

### Changed
- "Start reviewing" button removed from ActionSection

---

## [0.1.3] - 2026-03-01

### Added
- Author avatar displayed in the Discussion section
- Approve and Request Changes buttons associated with the comment textarea
- Syntax-highlighted, collapsible Buildkite CI metadata blocks extracted from HTML comments
- React migration: the entire webview UI rebuilt as a React app

### Fixed
- Panel scrolling broken after React migration
- Markdown links in the format `[[text]](url)` now render correctly
- `Jest Tests #6`-style links (GitHub's empty-span suppression) now render correctly
- Review Queue tab switching broken after React migration

---

## [0.1.2] - 2026-02-20

### Added
- Smart file ordering: groups changed files by directory and sorts by relevance
- Inline PR comment threads shown in the diff editor
- "Owned by me" filter for the Changed Files section (based on CODEOWNERS)
- Prev/Next file navigation when reviewing diffs
- Suggest review order via LLM
- Server status monitoring for Elasticsearch and Kibana (Start/Stop buttons)
- `gh pr checkout` integration with bootstrap step
- Status bar item showing the currently reviewed PR

---

## [0.1.1] - 2026-02-10

### Added
- Initial release
- PR Review Queue fetched from GitHub via `gh` CLI
- PR description panel with Markdown rendering
- Changed Files panel with diff viewer
- Discussion / comment thread section
