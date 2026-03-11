# Changelog

## [0.1.20] - 2026-03-11

### Fixed
- **Review Queue empty when using the extension outside of Kibana**: the target repository is now auto-detected from the workspace's git remotes instead of always defaulting to `elastic/kibana`. `upstream` is tried first (canonical repo in a fork workflow), then `origin` (direct clone). The explicit `elastic-pr-reviewer.repo` setting still takes priority. Falls back to `elastic/kibana` if no remote can be parsed

---

## [0.1.19] - 2026-03-10

### Added
- **New commits indicator on PR cards**: PR cards in the Review Queue now show a small amber dot when new commits have been pushed since the last time you opened that PR. Hovering the dot shows a "New commits added" tooltip. The dot disappears once you click the card. Works across all queue buckets (Unreviewed, In review, Approved) and persists across sessions via `localStorage`

### Changed
- **"My Branch" description updated**: the message shown when on a local branch without an open PR now reads "Compared to upstream main, these are your committed changed files:" to more accurately describe what the file list represents

---

## [0.1.18] - 2026-03-10

### Fixed
- **Reviewed PRs missing from Review Queue**: `reviewed-by:<member_login>` supplementary queries were accidentally removed in a refactor, causing PRs where a team member had already submitted a review to disappear from the queue. The queries (and `runWithConcurrency` helper) have been restored
- **60-second PR detail cache lost in refactor**: `detailCache` and `invalidateDetailCache` were also removed in the same refactor, causing redundant back-to-back GitHub API calls when selecting a checked-out PR. Both have been restored, including the cache-invalidation calls after posting a comment or submitting a review

---

## [0.1.17] - 2026-03-10

### Fixed
- **Checkout button did nothing when clicked**: `postMessage` was missing its import in `SectionNavBar`, so the Checkout, Refresh, and ⚡ buttons were all silently calling the browser's native `window.postMessage` instead of the VS Code API
- **Terminal commands run before `.zshrc` finishes loading**: all spawned terminals (Elasticsearch, Kibana, Synthtrace, Bootstrap) now use a shared `runInTerminal` helper that waits for VS Code shell integration before sending the command, with a 4-second `sendText` fallback for shells without integration support
- **Lazy-loaded NVM not activated before terminal commands**: when the workspace contains a `.nvmrc` or `.node-version` file, `nvm use 2>/dev/null` is automatically prepended to the command so the correct Node version is active before execution — suppressed with `2>/dev/null` so non-NVM setups are unaffected
- **Double command execution in terminals**: a `sent` flag now ensures only one path (shell integration or fallback timer) can send the command, preventing the race condition where both fired and the command ran twice

---

## [0.1.16] - 2026-03-10

### Fixed
- **Clicking a PR in the Review Queue no longer switches tabs**: `postMessage` was missing its import in `PRCard`, causing every click to fall through to the browser's native `window.postMessage` instead of the VS Code API — the extension never received the `selectPR` message and the tab never switched

---

## [0.1.15] - 2026-03-10

### Changed
- **Dev environment panel moved into sticky nav container**: the Elasticsearch/Kibana/Synthtrace panel now expands directly below the section nav bar and sticks to the top of the pane while open, rather than appearing at the bottom of the page
- **Dev environment panel extracted to `DevEnvPanel` component**: the panel content is now a standalone component with its own `selectedScenario` and `live` state
- **Refresh button shows spinner while loading**: clicking the refresh button in the section nav bar now shows a spinner until the updated PR data arrives, and the button is disabled during that time to prevent duplicate requests

---

## [0.1.14] - 2026-03-09

### Added
- **"In review by you" bucket in the Review Queue**: a fourth bucket now appears between "Unreviewed" and "In review" for PRs where you personally have submitted a `COMMENTED` or `CHANGES_REQUESTED` review but have not yet approved; it is always labelled "In review by you" (no team suffix) and works with or without a team filter active

---

## [0.1.13] - 2026-03-09

### Performance
- **Eliminated redundant `getPRBaseCommit` API call**: `baseRefOid` is now fetched as part of `getPullRequestDetail`, removing a separate serial API call on every PR load and checkout
- **60-second TTL cache for PR detail**: `getPullRequestDetail` now caches results for 60 seconds, so back-to-back calls (e.g. `fetchAndUpdateDetail` + `refreshFilesAndComments` firing together when selecting a checked-out PR) hit the cache instead of making a duplicate network round-trip; the cache is invalidated after posting a comment or submitting a review
- **`getLineComments` parallelised with `getPullRequestDetail`**: inline review comments are now fetched in parallel with the PR detail in `refreshFilesAndComments`, reducing the serial chain from 3 sequential calls to 1 parallel batch
- **`viewReady` wait parallelised with `getPullRequestDetail`** in `loadPRData`: the webview initialisation wait and the GitHub API fetch now happen concurrently
- **Concurrency cap on queue search queries**: `listOpenPRsForTeams` previously fired all `team-review-requested:` and `reviewed-by:` queries at once; they are now throttled to 6 concurrent requests via a new `runWithConcurrency` helper, reducing the risk of hitting GitHub API rate limits
- **Parallel remote pruning**: `git remote prune upstream` and `git remote prune origin` now run in parallel during checkout conflict recovery
- **Throttled auto-refresh on tab switch**: switching to the Review Queue tab no longer triggers a full GitHub fetch if the last refresh was under 15 seconds ago; explicit user-initiated refreshes (button, config change, startup) always bypass the throttle

---

## [0.1.12] - 2026-03-09

### Fixed
- **Review Queue tab count matches visible list**: the count in the "Review Queue (N)" tab title now applies the same team, draft, and own-PR filters as the list itself, so it always matches the "N / N PRs" summary shown in the pane
- **PRs reviewed by team members stay visible**: PRs where a colleague has already reviewed were silently dropped from the queue because GitHub removes a PR from `team-review-requested:` results once any team member submits a review; the extension now also queries `reviewed-by:<member>` for all members of the selected team so those PRs remain visible in the correct bucket
- **React hooks order crash in FilesSection**: a `useCallback` placed after an early return caused React to see a different number of hooks between renders, crashing the panel; the hook is now unconditionally called before any early return
- **`currentBranch` accessibility error**: `PrPanelProvider.currentBranch` was marked `private`, preventing `extension.ts` from reading it for the "Create PR" flow; the modifier has been removed
- **`reviewers` typo in `TeamReviewInfo`**: a duplicate `reviewer` key in the `IN_PROGRESS` status object (second entry was meant to be `reviewers`) caused a TypeScript error and silently dropped the full reviewer list at runtime

### Changed
- **"My Branch" description**: the message shown when on a local branch is now "You're on `<branch>`. Ready to open a PR when you are." — more concise and action-oriented

---

## [0.1.11] - 2026-03-09

### Added
- **Commit files in My Branch view**: file rows in the "My Branch" view now show checkboxes for selecting files to include in a commit; a "Commit files" button opens an inline commit-message textarea; submitting runs `git add` + `git commit` and refreshes the file list; supports `⌘↵` / `Ctrl↵` to submit and `Escape` to cancel
- **Sticky Changed Files toolbar**: the search, filter, suggest-order, and commit-stepper toolbar now sticks to the top of the panel when scrolling through a long file list
- **"Check out branch" overlay is now a button**: the semi-transparent overlay on unreviewed PRs now shows a clickable "Check out branch to see files" button that triggers the checkout flow directly
- **Commit stepper shown with zero commits**: the stepper bar is always visible in the Changed Files section; when there are no commits yet it shows "no commits yet" with all nav buttons disabled

### Changed
- **Reviewing pane resets on queue tab switch**: when the user switches to the Review Queue tab after previewing a PR that is not checked out, the Reviewing pane automatically resets to the correct state — "My Branch" if no PR is checked out, or the currently checked-out PR otherwise
- **"Suggest review order" works in My Branch mode**: the button no longer requires a checked-out PR; it runs against the local branch's files and diffs against the working tree (including uncommitted changes)

---

## [0.1.9] - 2026-03-09

### Added
- **Author team membership badge**: each PR card in the Review Queue shows a small `team` (blue) or `external` (grey) pill badge next to the author login when a team filter is active, indicating whether the PR author is a member of the selected team
- **Commit stepper in Changed Files**: a stepper bar above the file list lets you step through each commit in a PR chronologically; defaults to "All" mode showing the full PR diff; selecting a commit dims (0.45 opacity, non-clickable) files not touched by that commit, and highlights touched files with their commit-specific `+additions -deletions` counts
- **Per-commit diff from file list**: clicking a touched file while a commit is selected opens a side-by-side diff scoped to that commit (reuses the existing `pr-base://commit-base/` / `pr-base://commit-head/` URI scheme); handles renamed files
- **Commit-only files in stepper**: files that were added and later deleted within the same PR (net-zero, absent from GitHub's PR diff) are injected as extra rows when the commit that deleted them is selected
- **Shared `CommitLabel` component**: the clickable SHA, truncated first-line message, and full-message CSS tooltip are now a single reusable component used identically in both the Discussion timeline and the commit stepper

### Changed
- Changed Files header count shows `(N/M)` when a commit is selected, where N is the number of PR files touched by that commit and M is the total PR file count
- Navigating between commits (← →) no longer causes the file list to disappear; the previous commit's dimming state is kept visible while the new commit's data loads, with a small inline spinner in the stepper bar replacing the SHA/message during loading
- The `⊕ commit-only` indicator explains files visible in a commit view that are absent from "All" mode

### Fixed
- `Changed Files (5/4)` impossible count: the numerator now counts how many of the PR's own files are touched by the selected commit, not the raw `git diff-tree` file count (which can exceed the net PR diff when a commit touches files later reverted)

---

## [0.1.8] - 2026-03-08

### Added
- **Commit events in Discussion timeline**: commits pushed to a PR are now interleaved chronologically with comments; each row shows the author avatar, login, short SHA (clickable), and first line of the commit message
- **Commit diff viewer**: clicking a commit SHA opens a QuickPick listing all files changed in that commit; selecting a file opens a side-by-side VS Code diff (`git show <sha>^:<file>` vs `git show <sha>:<file>`); handles added, deleted, and renamed files
- **Full commit message tooltip**: hovering over a truncated commit message reveals the complete multi-line message in a styled CSS tooltip (native `title` is suppressed in VS Code webviews)
- **Auto-refresh on tab switch**: switching to "Review Queue" triggers a queue refresh; switching to the "Reviewing" tab re-fetches PR details and (if checked out) files and inline comments
- **Deferred tab label**: the second tab shows `…` on startup until the PR-restore check completes, preventing the "My Branch" label from flashing before resolving to "Reviewing #XXXXX"

### Changed
- Extension renamed to **Elastic PR Reviewer** — works in any GitHub repository, not just Kibana; the `⚡` dev-environment toggle is disabled with a tooltip when the workspace is not `elastic/kibana`; command palette category, output channel, config namespace, and all internal IDs updated to `elastic-pr-reviewer`
- PR header fade/mask only appears when content actually overflows the 370 px clamp, not on every PR

### Fixed
- `pr-base://COMMIT/…` virtual URI failing because VS Code lowercases URI authorities (`COMMIT` → `commit`)

---

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
