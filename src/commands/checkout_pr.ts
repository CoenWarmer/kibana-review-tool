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
  // Fetch PR detail and wait for the webview to be ready in parallel — both
  // are independent and the webview is typically already resolved on startup.
  const [detail] = await Promise.all([
    ctx.githubService.getPullRequestDetail(prNumber),
    ctx.prDescriptionProvider.viewReady,
  ]);
  log(`[loadPRData] Got detail: ${detail.files.length} files`);

  log('[loadPRData] viewReady resolved — setting PR');
  ctx.prDescriptionProvider.setPR(detail);

  // baseRefOid is now included in the PR detail; no separate API call needed.
  const baseCommit = detail.baseRefOid ?? (await ctx.githubService.getPRBaseCommit(prNumber));
  log(`[loadPRData] baseCommit = ${baseCommit}`);

  const ordered = sortAndGroupFiles(detail.files);
  log(`[loadPRData] Grouped ${ordered.length} files by directory`);

  ctx.changedFilesProvider.setFiles(prNumber, baseCommit, ordered);
  ctx.statusBarItem.text = `$(git-pull-request) PR #${prNumber}`;
  ctx.statusBarItem.tooltip = `Currently reviewing: #${prNumber} — ${detail.title}`;
  ctx.statusBarItem.command = 'elastic-pr-reviewer.clearCheckedOutPR';
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
  // headRefName is used to verify the checkout succeeded when gh fails at the
  // tracking-info setup step (see isTrackingInfoError below).
  const headRefName = typeof prOrNumber === 'object' ? prOrNumber.headRefName : undefined;
  const config = vscode.workspace.getConfiguration('elastic-pr-reviewer');
  const repo = config.get<string>('repo', 'elastic/kibana');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Guard: warn the user if there are uncommitted changes before we touch git.
  const dirty = await hasUncommittedChanges(cwd);
  if (dirty) {
    const choice = await vscode.window.showWarningMessage(
      'You have uncommitted changes. Checking out a different PR will discard them.',
      { modal: true },
      'Discard changes',
      'Cancel'
    );
    if (choice !== 'Discard changes') return;

    log('[checkout] Discarding uncommitted changes (git reset --hard && git clean -fd)…');
    await execFileAsync('git', ['reset', '--hard'], { cwd });
    await execFileAsync('git', ['clean', '-f', '-d'], { cwd });
    log('[checkout] Working tree cleaned.');
  }

  const reportStage = (stage: string | null) => {
    ctx.onCheckoutProgress?.(stage);
  };

  ctx.statusBarItem.text = `$(loading~spin) Checking out PR #${prNumber}…`;
  ctx.statusBarItem.show();
  ctx.changedFilesProvider.setLoading(prNumber);
  reportStage('Fetching branch…');

  void (async () => {
    try {
      log(`Fetching branch for PR #${prNumber}…`);
      try {
        await runCheckout(prNumber, repo, cwd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        if (isTrackingInfoError(msg)) {
          // gh pr checkout failed at the tracking-info setup step, but the branch
          // was likely already created and switched to before the error. Verify by
          // checking the current branch — if it matches the expected PR branch the
          // checkout was actually successful; we just skip the tracking setup.
          log(`Tracking-info error detected — verifying current branch…`);
          const currentBranch = await getCurrentBranch(cwd);
          log(
            `Current branch after error: "${currentBranch}", expected: "${headRefName ?? '(unknown)'}"`
          );
          if (headRefName && currentBranch === headRefName) {
            log('Branch matches — treating tracking-info error as benign, proceeding.');
            // Fall through to loadPRData below.
          } else {
            throw err;
          }
        } else if (isRefConflictError(msg)) {
          // Try remote prune first (handles stale remote-tracking refs)
          log('Pruning stale remote refs…');
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
              throw new Error(
                `Checkout cancelled — local branch "${localConflict}" was not deleted.`
              );
            }
            log(`Deleting local branch "${localConflict}"…`);
            await deleteLocalBranch(localConflict, cwd);
          }

          log('Retrying checkout…');
          await runCheckout(prNumber, repo, cwd);
        } else {
          throw err;
        }
      }

      log(`PR #${prNumber} checked out successfully — loading PR data and bootstrapping`);

      // Load PR data immediately after checkout so the file list unblocks
      // without waiting for the (slow) bootstrap to complete.
      reportStage(null); // clear the button status
      await loadPRData(prNumber, ctx);
      void vscode.commands.executeCommand('elastic-pr-reviewer.prPanel.focus');

      // Bootstrap runs after the UI is already updated.
      reportStage('Bootstrapping…');
      await runBootstrap(cwd);
      log('Bootstrap complete');
      reportStage(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Checkout failed: ${msg}`);
      reportStage(null); // restore button
      ctx.changedFilesProvider.setError(`Checkout failed: ${msg}`);
      ctx.statusBarItem.text = `$(error) PR #${prNumber} checkout failed`;
      void vscode.window.showErrorMessage(
        `Elastic PR Reviewer: Could not checkout PR #${prNumber}. ${msg}`
      );
    }
  })();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true when `git status --porcelain` reports any tracked or untracked
 * modifications — i.e. the working tree is not clean.
 */
async function hasUncommittedChanges(cwd: string | undefined): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
    return stdout.trim().length > 0;
  } catch {
    // If git fails for some reason, don't block the checkout.
    return false;
  }
}

async function runCheckout(prNumber: number, repo: string, cwd: string | undefined): Promise<void> {
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
 * Detects the "cannot set up tracking information" error that gh pr checkout
 * raises when the remote-tracking ref doesn't exist locally yet. The local
 * branch is typically already created and checked out at this point — the
 * error only occurs at the final tracking-setup step.
 */
function isTrackingInfoError(message: string): boolean {
  return message.includes('cannot set up tracking information');
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

async function getCurrentBranch(cwd: string | undefined): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function deleteLocalBranch(branch: string, cwd: string | undefined): Promise<void> {
  log(`git branch -D ${branch}`);
  await execFileAsync('git', ['branch', '-D', branch], { cwd });
  log(`  deleted local branch "${branch}"`);
}

async function pruneRemotes(cwd: string | undefined): Promise<void> {
  await Promise.all(
    ['upstream', 'origin'].map(async (remote) => {
      try {
        log(`git remote prune ${remote}`);
        await execFileAsync('git', ['remote', 'prune', remote], { cwd });
        log(`  pruned ${remote}`);
      } catch {
        log(`  could not prune ${remote} (remote may not exist)`);
      }
    })
  );
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
