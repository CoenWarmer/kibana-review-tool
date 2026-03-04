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
    void vscode.window.showErrorMessage('Kibana PR Reviewer: No workspace folder open.');
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
 * Provides the content of files at a specific git commit.
 * Registered under the `pr-base` URI scheme.
 */
export class GitBaseContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.authority === 'empty') {
      return '';
    }

    const commit = decodeURIComponent(uri.authority);
    const filePath = decodeURIComponent(uri.path.slice(1)); // strip leading /
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!cwd) return '';

    try {
      const { stdout } = await execFileAsync('git', ['show', `${commit}:${filePath}`], {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf8',
      });
      return stdout;
    } catch (err) {
      // File might have been added (not in base) or commit SHA is unavailable
      const message = err instanceof Error ? err.message : String(err);
      return `// Could not load base content for ${filePath} at ${commit}\n// ${message}`;
    }
  }
}
