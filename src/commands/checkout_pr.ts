import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { log } from '../logger';
import type { GhPullRequest } from '../services/github_service';
import type { GitHubService } from '../services/github_service';
import { sortAndGroupFiles } from '../services/file_ordering_service';
import type { PrPanelProvider } from '../providers/pr_panel_provider';

const execFileAsync = promisify(execFile);

/** Minimal interface that any PR-description panel must satisfy. */
export interface PrDescriptionLike {
  readonly viewReady: Promise<void>;
  setPR(pr: GhPullRequest): void;
  clear(): void;
}

export interface CheckoutContext {
  githubService: GitHubService;
  changedFilesProvider: PrPanelProvider;
  prDescriptionProvider: PrDescriptionLike;
  statusBarItem: vscode.StatusBarItem;
  /** Called with each checkout stage label, or null when the operation is complete. */
  onCheckoutProgress?: (stage: string | null) => void;
}

/**
 * Loads PR metadata, orders changed files, and populates all panels —
 * without running `git checkout`. Used both by `checkoutPR` (after the
 * git operation completes) and by the startup branch-detection path.
 */
export async function loadPRData(
  prNumber: number,
  ctx: CheckoutContext,
  progress?: vscode.Progress<{ message?: string }>
): Promise<void> {
  const report = (msg: string) => {
    log(`[loadPRData] ${msg}`);
    progress?.report({ message: msg });
  };

  report('Loading PR details…');
  const detail = await ctx.githubService.getPullRequestDetail(prNumber);
  log(`[loadPRData] Got detail: ${detail.files.length} files`);

  // Wait for the description webview to be initialised before setting data.
  // On a fresh extension host start the webview may not yet have been resolved.
  log('[loadPRData] Waiting for description webview to be ready…');
  await ctx.prDescriptionProvider.viewReady;
  log('[loadPRData] viewReady resolved — setting PR');
  ctx.prDescriptionProvider.setPR(detail);

  report('Fetching base commit…');
  const baseCommit = await ctx.githubService.getPRBaseCommit(prNumber);
  log(`[loadPRData] baseCommit = ${baseCommit}`);

  const ordered = sortAndGroupFiles(detail.files);
  log(`[loadPRData] Grouped ${ordered.length} files by directory`);

  ctx.changedFilesProvider.setFiles(prNumber, baseCommit, ordered);
  ctx.statusBarItem.text = `$(git-pull-request) PR #${prNumber}`;
  ctx.statusBarItem.tooltip = `Currently reviewing: #${prNumber} — ${detail.title}`;
  ctx.statusBarItem.command = 'kibana-pr-reviewer.clearCheckedOutPR';
  log('[loadPRData] Done');
}

/**
 * Called when the user clicks a PR in the list or runs the checkoutPR command.
 * Runs `gh pr checkout <number>` programmatically so we can catch and recover
 * from errors (e.g. stale local ref conflicts), then loads and orders the
 * changed files into the Changed Files panel.
 */
export async function checkoutPR(
  prOrNumber: GhPullRequest | number,
  ctx: CheckoutContext
): Promise<void> {
  const prNumber = typeof prOrNumber === 'number' ? prOrNumber : prOrNumber.number;
  const config = vscode.workspace.getConfiguration('kibana-pr-reviewer');
  const repo = config.get<string>('repo', 'elastic/kibana');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const reportStage = (stage: string | null) => {
    ctx.onCheckoutProgress?.(stage);
  };

  ctx.statusBarItem.text = `$(loading~spin) Checking out PR #${prNumber}…`;
  ctx.statusBarItem.show();
  ctx.changedFilesProvider.setLoading(prNumber);
  reportStage('Fetching branch…');

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Checking out PR #${prNumber}…`,
      cancellable: false,
    },
    async (progress) => {
      try {
        progress.report({ message: 'Fetching branch…' });
        await runCheckout(prNumber, repo, cwd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        if (isRefConflictError(msg)) {
          // Try remote prune first (handles stale remote-tracking refs)
          progress.report({ message: 'Pruning stale remote refs…' });
          await pruneRemotes(cwd);

          // Also check for a conflicting LOCAL branch (the most common cause).
          const localConflict = extractConflictingLocalBranch(msg);
          if (localConflict) {
            log(`Conflicting local branch detected: "${localConflict}"`);
            const choice = await vscode.window.showWarningMessage(
              `Cannot checkout PR #${prNumber}: local branch "${localConflict}" conflicts with the PR branch name.`,
              { modal: true },
              'Delete local branch and retry',
              'Cancel'
            );
            if (choice !== 'Delete local branch and retry') {
              throw new Error(`Checkout cancelled — local branch "${localConflict}" was not deleted.`);
            }
            log(`Deleting local branch "${localConflict}"…`);
            await deleteLocalBranch(localConflict, cwd);
          }

          log('Retrying checkout…');
          progress.report({ message: 'Retrying checkout…' });
          await runCheckout(prNumber, repo, cwd);
        } else {
          throw err;
        }
      }

      log(`PR #${prNumber} checked out successfully — running yarn kbn bootstrap`);
      progress.report({ message: 'Bootstrapping…' });
      reportStage('Bootstrapping…');
      await runBootstrap(cwd);
      log('Bootstrap complete');

      reportStage(null); // clear the button status
      await loadPRData(prNumber, ctx, progress);

      void vscode.commands.executeCommand('kibana-pr-reviewer.prPanel.focus');
    }
  ).then(undefined, (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Checkout failed: ${msg}`);
    reportStage(null); // restore button
    ctx.changedFilesProvider.setError(`Checkout failed: ${msg}`);
    ctx.statusBarItem.text = `$(error) PR #${prNumber} checkout failed`;
    void vscode.window.showErrorMessage(
      `Kibana PR Reviewer: Could not checkout PR #${prNumber}. ${msg}`
    );
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function runCheckout(
  prNumber: number,
  repo: string,
  cwd: string | undefined
): Promise<void> {
  log(`gh pr checkout ${prNumber} --repo ${repo}`);
  const { stdout, stderr } = await execFileAsync(
    'gh',
    ['pr', 'checkout', String(prNumber), '--repo', repo],
    { cwd, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' } }
  );
  if (stdout) log(stdout.trim());
  if (stderr) log(stderr.trim());
}

/**
 * Detects the git "refs/heads/X exists; cannot create refs/heads/X/Y" error
 * that occurs when a flat local branch (e.g. `fix`) conflicts with a
 * slash-namespaced branch (e.g. `fix/my-change`).
 */
function isRefConflictError(message: string): boolean {
  return (
    message.includes('local refs could not be updated') ||
    message.includes('exists; cannot create') ||
    message.includes('unable to update local ref')
  );
}

/**
 * Extracts the conflicting LOCAL branch name from a git ref-conflict error.
 *
 * Example error:
 *   error: 'refs/heads/fix' exists; cannot create 'refs/heads/fix/my-branch'
 * Returns: "fix"
 */
function extractConflictingLocalBranch(errorMessage: string): string | null {
  const match = errorMessage.match(/refs\/heads\/([^\s']+)['"]?\s+exists/);
  return match?.[1] ?? null;
}

async function deleteLocalBranch(branch: string, cwd: string | undefined): Promise<void> {
  log(`git branch -D ${branch}`);
  await execFileAsync('git', ['branch', '-D', branch], { cwd });
  log(`  deleted local branch "${branch}"`);
}

async function pruneRemotes(cwd: string | undefined): Promise<void> {
  for (const remote of ['upstream', 'origin']) {
    try {
      log(`git remote prune ${remote}`);
      await execFileAsync('git', ['remote', 'prune', remote], { cwd });
      log(`  pruned ${remote}`);
    } catch (_err) {
      log(`  could not prune ${remote} (remote may not exist)`);
    }
  }
}

/**
 * Runs `yarn kbn bootstrap` in a dedicated VS Code terminal so the user can
 * watch the output. A temp-file sentinel lets us await completion without
 * losing the exit code.
 */
async function runBootstrap(cwd: string | undefined): Promise<void> {
  const markerPath = path.join(os.tmpdir(), `kbn-bootstrap-${Date.now()}.exit`);

  const terminal = vscode.window.createTerminal({
    name: '🔧 Bootstrap',
    cwd,
  });
  terminal.show(true);
  // Shell writes its exit code to the marker file so we can detect completion.
  terminal.sendText(`yarn kbn bootstrap; echo $? > "${markerPath}"`);

  log(`Bootstrap started in terminal — polling for ${markerPath}`);

  // Poll every 2 s; bail after 10 minutes.
  const timeoutMs = 10 * 60 * 1000;
  const start = Date.now();
  while (!fs.existsSync(markerPath)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('yarn kbn bootstrap timed out after 10 minutes');
    }
    await new Promise<void>((r) => setTimeout(r, 2000));
  }

  const exitCode = parseInt(fs.readFileSync(markerPath, 'utf8').trim(), 10);
  fs.unlinkSync(markerPath);
  log(`Bootstrap finished with exit code ${exitCode}`);

  if (exitCode !== 0) {
    throw new Error(`yarn kbn bootstrap failed (exit code ${exitCode})`);
  }
}

export function disposeTerminal(): void {
  // No-op — checkout no longer uses a terminal
}
