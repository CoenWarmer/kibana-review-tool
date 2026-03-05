# Kibana PR Reviewer

A VSCode/Cursor extension for Kibana engineers to review pull requests efficiently.

## Why?

Kibana has a large influx of new PRs. The introduction of AI assisted coding already makes the influx even higher.

Traditionally PRs are reviewed via the Github UI. While this is good for some use cases, it could be way better. At the time of writing, Github's UI has been largely stagnant for years.

There is not an insignficant amount of data points that an engineer (or an LLM) needs to fully judge the quality of a PR.

You need:
- the diffs
- the context in which the diffs are placed
- type information
- information on test coverage
- how the proposed feature behaves functionally, at runtime

Therefore, strictly reviewing from the Github UI is fundamentally incomplete. Thus, it leads to low quality reviews.

Some reviewers go further than a look at the code and actually check out the branch and see how the feature behaves. But there is no hard requirement on this.

This is exacerbated by the friction that is imposed on the reviewer in getting a PR ready to review.

A reviewer needs to:
- find the PR that she needs to review
- switch to the branch
- run yarn kbn bootstrap
- start es + kibana
- optionally load test data / fixtures

*Now* the review can start in earnest.

This is slow an unwieldy.

The speed of bootstrapping / starting Kibana we can't fix easily, but we can improve our tooling.

This is where this extension comes in.

## Features

- **Team-filtered PR queue** — shows only PRs where your team is a requested reviewer
- **One-click PR checkout** — runs `gh pr checkout <number>` for you
- **Smart file ordering** — orders changed files from core implementation to peripheral (tests, config, docs), with optional LLM enhancement
- **Inline diff view** — click any file to open a color-highlighted diff

## Prerequisites

- [GitHub CLI (`gh`)](https://cli.github.com/) installed and authenticated (`gh auth login`)
- Authenticated against the `elastic` org for team detection

## Getting Started

1. **Build and install:**
   ```bash
   cd dev_tools/kibana-pr-reviewer
   npm install
   npm run compile
   # Package as .vsix:
   npm run package
   # Then: Extensions panel → Install from VSIX...
   ```

2. **Open the panel** — click the PR Reviewer icon in the Activity Bar (left sidebar).

3. **First run** — the extension auto-detects which `@elastic/team-*` teams you belong to via the GitHub API. This is cached. Override via settings if needed.

## Configuration

Open `Settings > Kibana PR Reviewer`:

| Setting | Default | Description |
|---|---|---|
| `kibana-pr-reviewer.repo` | `elastic/kibana` | GitHub repo to watch |
| `kibana-pr-reviewer.userTeams` | `[]` | Override team detection (e.g. `["@elastic/kibana-core"]`) |
| `kibana-pr-reviewer.llmProvider` | `none` | `openai` or `anthropic` for LLM file ordering |
| `kibana-pr-reviewer.llmModel` | _(auto)_ | Model override |
| `kibana-pr-reviewer.prLimit` | `50` | Max PRs to fetch |

### Setting your LLM API key

Run `> Kibana PR Reviewer: Set LLM API Key` from the command palette. The key is stored in VS Code's encrypted `SecretStorage`.

## How File Ordering Works

Files are ordered from most important to review first:

1. **Core implementation** — non-test `.ts`/`.tsx` source files
2. **Entry points & APIs** — `index.ts`, `plugin.ts`, route handlers
3. **Tests** — `.test.ts`, `.spec.ts` (review after you understand the change)
4. **Configuration** — `package.json`, `kibana.jsonc`, `tsconfig.json`
5. **Documentation** — `*.md`, `*.mdx`

With an LLM API key configured, the extension sends the PR title, description, and file list to the model and uses its judgment to refine the ordering, annotating each file with a group label (e.g. _"core change"_, _"supporting"_).

## Development

```bash
npm install
npm run watch   # rebuild on change

# In VS Code: F5 to launch Extension Development Host
```
