# Kibana PR Reviewer

A VSCode/Cursor extension for Kibana engineers to review pull requests efficiently.

<img alt="Screenshot 2026-03-05 at 19 12 41" src="https://github.com/user-attachments/assets/cdb2ef0a-bd44-41b3-ae84-60e7d89dbdb6" />

## Why?

Kibana has a large influx of new PRs. The introduction of AI assisted coding makes the influx even higher.

Traditionally PRs are reviewed via the Github UI. While this works for some use cases, it could be way better. At the time of writing, Github's UI has been largely stagnant for years.

### Data needed for a good review
There is not an insignficant amount of data points that an engineer (or an LLM) needs to fully judge the quality of a PR.

A reviewer needs:
- the diffs
- the context in which the diffs are placed (the entire file)
- quick access to the existing files and folders surrounding the diffs
- type information
- information on test coverage
- how the proposed feature behaves functionally, at runtime

Therefore, strictly reviewing from the Github UI means a reviewer does not have enough data to come to a good judgement.

### Friction when reviewing in Kibana
In addition to this, reviewing PRs at Kibana has friction. 

Reviewers look at static code. Some reviewers go further and actually check out the branch and see how the feature behaves.

I suspect that the reason for this is the amount of friction that a reviewer has to deal with in getting a Kibana PR ready to review.

A reviewer needs to:
- find the PR that she needs to review
- switch to the branch
- run yarn kbn bootstrap
- start es + kibana
- optionally load test data / fixtures
- understand the code <-- only now do we start reviewing, the steps prior are just ceremony
- understand the intended behavior
- judge the code in terms of coding standards
- judge the code in context of the product
- judge if the code covers both happy and unhappy paths

This, especially the getting started parts, take effort and are slow (bootstrapping can take a while).

The speed of bootstrapping / starting Kibana we can't fix easily, but we can improve our tooling to make things easier.

This is where this extension comes in.

## Features

- **Team-filtered PR queue** — shows only PRs where your team is a requested reviewer
<img width="436" height="517" alt="Screenshot 2026-03-05 at 19 09 41" src="https://github.com/user-attachments/assets/f4154e3b-0b30-4dc6-b8b2-8e25d08bb67d" />


- **One-click PR checkout** — runs `gh pr checkout <number>` for you
<img width="440" height="412" alt="Screenshot 2026-03-05 at 19 10 07" src="https://github.com/user-attachments/assets/6b557499-73d8-4580-b11c-18ea94aba286" />

- **Quickly start ES, Kibana and populate with test data**
<img width="441" height="157" alt="Screenshot 2026-03-06 at 09 44 03" src="https://github.com/user-attachments/assets/511aa086-25af-42f6-8de5-58641e083d16" />

- **Analyze the diff using an LLM** — provide a summary of every changed files so you quickly build context on what the changed files actually do. Also provide two sorting strategies for the order in which to review: top down and bottom up.
<img width="430" height="423" alt="Screenshot 2026-03-06 at 09 28 41" src="https://github.com/user-attachments/assets/351b789a-0ca2-4994-8f4b-e4666842185e" />

- **Inline diff view** — click any file to open a color-highlighted diff, read and reply to comments by authors and reviewers

- **Approve, comment or request changes** — Get the full discussion inside the IDE
<img width="426" height="155" alt="Screenshot 2026-03-05 at 19 12 55" src="https://github.com/user-attachments/assets/734c3cdc-5b6d-4ae3-872e-3f54a46e00b9" />

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
