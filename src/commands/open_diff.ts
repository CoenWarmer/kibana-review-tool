import * as vscode from 'vscode';
import * as path from 'path';
import type { OrderedFile } from '../services/file_ordering_service';

/**
 * Opens the VS Code diff editor for a changed file, comparing the PR base
 * commit's version of the file against the checked-out HEAD version.
 *
 * Uses `git show <baseCommit>:<filePath>` to fetch the base content as a
 * virtual document, then `vscode.diff` to show the side-by-side comparison.
 */
export async function openDiff(
  file: OrderedFile,
  prNumber: number,
  baseCommit: string
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage('Elastic PR Reviewer: No workspace folder open.');
    return;
  }

  const headUri = vscode.Uri.joinPath(workspaceRoot, file.path);
  const title = `PR #${prNumber}: ${path.basename(file.path)} (${file.group})`;

  if (file.status === 'added') {
    // File didn't exist on base — show empty left side vs current file
    const emptyUri = buildGitUri(file.path, baseCommit, true);
    await vscode.commands.executeCommand('vscode.diff', emptyUri, headUri, title);
    return;
  }

  if (file.status === 'deleted') {
    // File no longer exists on HEAD — show base content vs empty right side
    const baseUri = buildGitUri(file.path, baseCommit, false);
    const emptyUri = vscode.Uri.parse(`untitled:${file.path}`);
    await vscode.commands.executeCommand('vscode.diff', baseUri, emptyUri, title);
    return;
  }

  const baseUri = buildGitUri(file.path, baseCommit, false);
  await vscode.commands.executeCommand('vscode.diff', baseUri, headUri, title);
}

/**
 * Builds a URI that the GitContentProvider can resolve to base-commit content.
 * Scheme: `pr-base` — handled by the registered TextDocumentContentProvider.
 */
function buildGitUri(filePath: string, commit: string, empty: boolean): vscode.Uri {
  if (empty) {
    return vscode.Uri.parse(`pr-base://empty/${encodeURIComponent(filePath)}`);
  }
  return vscode.Uri.parse(
    `pr-base://${encodeURIComponent(commit)}/${encodeURIComponent(filePath)}`
  );
}

// ─── Content provider ─────────────────────────────────────────────────────────

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Provides virtual document content for the `pr-base` URI scheme.
 *
 * Authority values (all lowercase — VS Code lowercases authority):
 *   `empty`        → empty string (left side for added-file diffs)
 *   `commit-base`  → path = `/<sha>/<encoded-file>` → `git show <sha>^:<file>` (parent version)
 *   `commit-head`  → path = `/<sha>/<encoded-file>` → `git show <sha>:<file>`  (commit version)
 *   otherwise      → authority = base commit SHA, path = file path (existing PR diff use-case)
 */
export class GitBaseContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return '';

    if (uri.authority === 'empty') {
      return '';
    }

    if (uri.authority === 'commit-base' || uri.authority === 'commit-head') {
      // Path format: /<sha>/<encodeURIComponent(filePath)>
      // encodeURIComponent encodes '/' as '%2F', so the only real '/' after the
      // leading one is the separator between sha and the encoded file path.
      const sep = uri.path.indexOf('/', 1);
      const sha = uri.path.slice(1, sep);
      const filePath = decodeURIComponent(uri.path.slice(sep + 1));
      const ref =
        uri.authority === 'commit-base'
          ? `${sha}^:${filePath}` // parent commit
          : `${sha}:${filePath}`; // this commit
      try {
        const { stdout } = await execFileAsync('git', ['show', ref], {
          cwd,
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'utf8',
        });
        return stdout;
      } catch {
        return ''; // added (no parent) or deleted (no head) — show empty side
      }
    }

    // Existing PR diff use-case: authority = base commit, path = file path.
    const commit = decodeURIComponent(uri.authority);
    const filePath = decodeURIComponent(uri.path.slice(1));

    try {
      const { stdout } = await execFileAsync('git', ['show', `${commit}:${filePath}`], {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf8',
      });
      return stdout;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `// Could not load base content for ${filePath} at ${commit}\n// ${message}`;
    }
  }
}

/**
 * Opens a side-by-side diff for a specific file within a commit, without a
 * QuickPick. Used when the user clicks a file row while the commit stepper is
 * active.
 *
 * @param sha       Short or full commit SHA
 * @param afterPath Path of the file in the commit (after version)
 * @param beforePath Path of the file in the parent commit (before version);
 *                   equals afterPath for non-renames
 */
export async function openCommitFileDiff(
  sha: string,
  afterPath: string,
  beforePath: string
): Promise<void> {
  const beforeUri = vscode.Uri.parse(
    `pr-base://commit-base/${sha}/${encodeURIComponent(beforePath)}`
  );
  const afterUri = vscode.Uri.parse(
    `pr-base://commit-head/${sha}/${encodeURIComponent(afterPath)}`
  );
  const title = `${sha}: ${path.basename(afterPath)}`;
  await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title);
}

/**
 * Opens a QuickPick with all files changed in the given commit. When the user
 * selects a file, opens a side-by-side diff of parent vs commit version.
 */
export async function openCommitInIde(sha: string): Promise<void> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) {
    void vscode.window.showErrorMessage('Elastic PR Reviewer: No workspace folder open.');
    return;
  }

  let diffTreeOut: string;
  try {
    const result = await execFileAsync(
      'git',
      ['diff-tree', '--no-commit-id', '-r', '--name-status', sha],
      { cwd, encoding: 'utf8' }
    );
    diffTreeOut = result.stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Could not read commit ${sha}: ${message}`);
    return;
  }

  type FileEntry = { status: string; before: string; after: string };
  const statusIcons: Record<string, string> = {
    A: '$(diff-added)',
    M: '$(diff-modified)',
    D: '$(diff-removed)',
    R: '$(diff-renamed)',
    C: '$(copy)',
  };

  const files: FileEntry[] = diffTreeOut
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const status = parts[0][0];
      if (status === 'R' || status === 'C') {
        return { status, before: parts[1], after: parts[2] };
      }
      return { status, before: parts[1], after: parts[1] };
    });

  if (files.length === 0) {
    void vscode.window.showInformationMessage(`No file changes found in commit ${sha}.`);
    return;
  }

  const items = files.map((f) => ({
    label: `${statusIcons[f.status] ?? '$(file)'} ${f.after}`,
    description: f.status === 'R' ? `renamed from ${f.before}` : undefined,
    file: f,
  }));

  const pick =
    items.length === 1
      ? items[0]
      : await vscode.window.showQuickPick(items, {
          title: `Files changed in ${sha}`,
          placeHolder: 'Select a file to diff',
          matchOnDescription: true,
        });

  if (!pick) return;

  const { file } = pick;

  // Before side: parent version (empty for added files)
  const beforeUri =
    file.status === 'A'
      ? vscode.Uri.parse(`pr-base://empty/${encodeURIComponent(file.before)}`)
      : vscode.Uri.parse(`pr-base://commit-base/${sha}/${encodeURIComponent(file.before)}`);

  // After side: commit version (empty for deleted files)
  const afterUri =
    file.status === 'D'
      ? vscode.Uri.parse(`pr-base://empty/${encodeURIComponent(file.after)}`)
      : vscode.Uri.parse(`pr-base://commit-head/${sha}/${encodeURIComponent(file.after)}`);

  const title = `${sha}: ${path.basename(file.after)}`;
  await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title);
}
