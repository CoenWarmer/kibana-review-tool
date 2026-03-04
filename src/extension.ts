import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitHubService } from './services/github_service';
import { CodeOwnersService } from './services/codeowners_service';
import { sortAndGroupFiles } from './services/file_ordering_service';
import type { OrderedFile } from './services/file_ordering_service';
import { ServerStatusService } from './services/server_status_service';
import { suggestReviewOrder } from './services/review_order_service';
import { PrPanelProvider } from './providers/pr_panel_provider';
import { checkoutPR, loadPRData, disposeTerminal } from './commands/checkout_pr';
import { openDiff, GitBaseContentProvider } from './commands/open_diff';
import { initLogger, log, showLog } from './logger';

/**
 * Reads `config/kibana.dev.yml` and returns the URL of the local dev server.
 * Falls back to http://localhost:5601 if the file is missing or unparseable.
 */
function getKibanaDevUrl(workspaceRoot: string): string {
  const configFile = path.join(workspaceRoot, 'config', 'kibana.dev.yml');
  let port = 5601;
  let host = 'localhost';
  let basePath = '';

  try {
    const content = fs.readFileSync(configFile, 'utf8');

    const portMatch = content.match(/^server\.port\s*:\s*(\d+)/m);
    if (portMatch) port = parseInt(portMatch[1], 10);

    const hostMatch = content.match(/^server\.host\s*:\s*['"]?([^\s'"#\r\n]+)['"]?/m);
    // 0.0.0.0 means "bind all interfaces" — connect via localhost
    if (hostMatch && hostMatch[1] !== '0.0.0.0') host = hostMatch[1];

    const basePathMatch = content.match(/^server\.basePath\s*:\s*['"]?([^\s'"#\r\n]+)['"]?/m);
    if (basePathMatch) basePath = basePathMatch[1];
  } catch {
    // File absent or unreadable — use defaults
  }

  return `http://${host}:${port}${basePath}`;
}
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogger(context);
  log('Extension activating…');

  // ─── Services ──────────────────────────────────────────────────────────────
  const config = vscode.workspace.getConfiguration('kibana-pr-reviewer');
  const repo = config.get<string>('repo', 'elastic/kibana');
  log(`Repo: ${repo}`);

  const githubService = new GitHubService(repo);
  const codeOwnersService = new CodeOwnersService(githubService, context);

  // Clear any cache written by a previous version (wrong API endpoint)
  codeOwnersService.clearCache();

  // ─── Check gh is installed and authenticated ───────────────────────────────
  const ghOk = await githubService.isGhAuthenticated();
  if (!ghOk) {
    void vscode.window.showWarningMessage(
      'Kibana PR Reviewer: `gh` CLI is not authenticated. Run `gh auth login` first.',
      'Open Terminal'
    ).then((choice) => {
      if (choice === 'Open Terminal') {
        vscode.commands.executeCommand('workbench.action.terminal.new');
      }
    });
  }

  // ─── Status bar ────────────────────────────────────────────────────────────
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.text = '$(git-pull-request) PR Reviewer';
  statusBarItem.tooltip = 'Kibana PR Reviewer — click to clear current PR';
  statusBarItem.command = 'kibana-pr-reviewer.clearCheckedOutPR';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // ─── Providers ─────────────────────────────────────────────────────────────
  const prPanelProvider = new PrPanelProvider(githubService, codeOwnersService);
  const changedFilesProvider = prPanelProvider; // unified panel

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PrPanelProvider.viewId, prPanelProvider, {
      // Preserve webview DOM while the panel is hidden so live JS-updated state
      // (server status dots, active file highlight, etc.) survives view switches.
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // ─── Dev server status ─────────────────────────────────────────────────────
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const serverStatusService = new ServerStatusService();

  serverStatusService.onStatusChange((state) => {
    prPanelProvider.updateServerStatus(state.es, state.kibana);
  });

  serverStatusService.startPolling();
  context.subscriptions.push({ dispose: () => serverStatusService.dispose() });

  prPanelProvider.onStartEs = () => serverStatusService.startEs(workspaceRoot);
  prPanelProvider.onStartKibana = () => serverStatusService.startKibana(workspaceRoot);
  prPanelProvider.onSuggestOrder = () => {
    const pr = prPanelProvider.currentPr;
    const files = prPanelProvider.getCurrentFiles();
    const baseCommit = prPanelProvider.getCurrentBaseCommit();
    if (!pr || files.length === 0 || !baseCommit) {
      void vscode.window.showWarningMessage(
        'Checkout a PR first to use the review order suggestion.'
      );
      return;
    }
    const cts = new vscode.CancellationTokenSource();
    prPanelProvider.setOrderLoading(true);
    suggestReviewOrder(pr, files, baseCommit, workspaceRoot, cts.token)
      .then((suggestion) => {
        prPanelProvider.setOrderSuggestion(suggestion);
      })
      .catch((err) => {
        prPanelProvider.setOrderLoading(false);
        const msg = err instanceof Error ? err.message : String(err);
        const isConfigError = msg.includes('llmProvider') || msg.includes('No language model');
        const actions = isConfigError ? ['Open Settings'] : [];
        void vscode.window.showErrorMessage(
          `Review order suggestion failed: ${msg}`,
          ...actions
        ).then((choice) => {
          if (choice === 'Open Settings') {
            void vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'kibana-pr-reviewer.llm'
            );
          }
        });
      })
      .finally(() => cts.dispose());
  };

  prPanelProvider.onOpenKibana = () => {
    const url = getKibanaDevUrl(workspaceRoot);
    log(`Opening Kibana at ${url}`);
    void vscode.commands.executeCommand('simpleBrowser.show', url);
  };

  // Wire up checkout button in panel → checkout command
  prPanelProvider.onCheckout = (pr) => {
    void vscode.commands.executeCommand('kibana-pr-reviewer.checkoutPR', pr);
  };

  // Wire up file clicks in the Changed Files webview → open diff command
  changedFilesProvider.onOpenFile = (file, prNumber, baseCommit) => {
    void vscode.commands.executeCommand('kibana-pr-reviewer.openDiff', file, prNumber, baseCommit);
  };

  // Wire up owned-by-me toggle from the webview toolbar
  changedFilesProvider.onToggleOwnedByMe = () => {
    if (changedFilesProvider.isOwnedByMeFilterActive) {
      void vscode.commands.executeCommand('kibana-pr-reviewer.disableOwnedByMeFilter');
    } else {
      void vscode.commands.executeCommand('kibana-pr-reviewer.enableOwnedByMeFilter');
    }
  };

  // When the user selects a PR from the queue, refresh its state.
  // If it matches the checked-out branch: reload changed files and inline comments.
  // If it differs: clear both so stale data from a previous checkout is not shown.
  prPanelProvider.onSelectPR = (pr) => {
    prPanelProvider.checkedOutPrNumber = changedFilesProvider.getCurrentPrNumber();
    const checkedOutPrNumber = changedFilesProvider.getCurrentPrNumber();
    if (pr.number === checkedOutPrNumber) {
      void refreshFilesAndComments(pr.number);
    } else {
      changedFilesProvider.clear();
      clearCommentThreads();
    }
  };

  // Refresh button: re-fetch description, files and comments for the current PR.
  prPanelProvider.onRefreshPR = (pr) => {
    prPanelProvider.checkedOutPrNumber = changedFilesProvider.getCurrentPrNumber();
    prPanelProvider.refreshDetail();
    if (pr.number === changedFilesProvider.getCurrentPrNumber()) {
      void refreshFilesAndComments(pr.number);
    }
  };

  // ─── Git base content provider ─────────────────────────────────────────────
  const gitContentProvider = new GitBaseContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('pr-base', gitContentProvider)
  );

  // ─── Inline PR comment threads ─────────────────────────────────────────────
  const commentController = vscode.comments.createCommentController(
    'kibana-pr-reviewer',
    'PR Review Comments'
  );
  // Allow users to start new threads from the gutter in PR diff editors
  commentController.commentingRangeProvider = {
    provideCommentingRanges(document) {
      const isPrFile =
        document.uri.scheme === 'pr-base' ||
        (changedFilesProvider.getCurrentPrNumber() !== null &&
          vscode.workspace.asRelativePath(document.uri, false) !== document.uri.fsPath);
      return isPrFile ? [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)] : [];
    },
  };
  context.subscriptions.push(commentController);

  let activeCommentThreads: vscode.CommentThread[] = [];

  function clearCommentThreads(): void {
    activeCommentThreads.forEach((t) => t.dispose());
    activeCommentThreads = [];
  }

  /**
   * Re-fetches the changed files and inline comments for a PR that is already
   * checked out. Called when the user re-selects the active PR in the queue.
   */
  async function refreshFilesAndComments(prNumber: number): Promise<void> {
    log(`[refreshFilesAndComments] Refreshing PR #${prNumber}…`);
    changedFilesProvider.setLoading(prNumber);
    try {
      const [detail, baseCommit] = await Promise.all([
        githubService.getPullRequestDetail(prNumber),
        githubService.getPRBaseCommit(prNumber),
      ]);
      const ordered = sortAndGroupFiles(detail.files);
      changedFilesProvider.setFiles(prNumber, baseCommit, ordered);
      statusBarItem.text = `$(git-pull-request) PR #${prNumber}`;
      statusBarItem.tooltip = `Currently reviewing: #${prNumber} — ${detail.title}`;
      await loadCommentThreads(prNumber, baseCommit);
      log(`[refreshFilesAndComments] Done — ${ordered.length} file(s), comments reloaded`);
    } catch (err) {
      log(`[refreshFilesAndComments] Failed: ${err instanceof Error ? err.message : String(err)}`);
      changedFilesProvider.setError(`Failed to refresh PR #${prNumber}`);
    }
  }

  async function loadCommentThreads(prNumber: number, baseCommit: string): Promise<void> {
    clearCommentThreads();
    log(`Loading inline comments for PR #${prNumber}…`);

    let comments: import('./services/github_service').GhPRLineComment[];
    try {
      comments = await githubService.getLineComments(prNumber);
    } catch (err) {
      log(`Failed to load inline comments: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    log(`Fetched ${comments.length} inline comment(s)`);
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!wsRoot) return;

    // Group into threads: collect roots, then attach replies.
    // GitHub models threads as a flat list where replies carry in_reply_to_id.
    const roots = comments.filter((c) => !c.in_reply_to_id);
    const repliesByRoot = new Map<number, typeof comments>();
    for (const reply of comments.filter((c) => c.in_reply_to_id)) {
      const bucket = repliesByRoot.get(reply.in_reply_to_id!) ?? [];
      bucket.push(reply);
      repliesByRoot.set(reply.in_reply_to_id!, bucket);
    }

    for (const root of roots) {
      const side = root.side ?? root.original_side ?? 'RIGHT';
      const lineNumber = Math.max(0, ((side === 'LEFT' ? root.original_line : root.line) ?? 1) - 1);
      const range = new vscode.Range(lineNumber, 0, lineNumber, 0);

      const uri =
        side === 'LEFT'
          ? vscode.Uri.parse(
              `pr-base://${encodeURIComponent(baseCommit)}/${encodeURIComponent(root.path)}`
            )
          : vscode.Uri.joinPath(wsRoot, root.path);

      const threadComments: vscode.Comment[] = [root, ...(repliesByRoot.get(root.id) ?? [])].map(
        (c) => ({
          author: { name: c.user.login },
          body: new vscode.MarkdownString(c.body),
          mode: vscode.CommentMode.Preview,
          timestamp: new Date(c.created_at),
          label: new Date(c.created_at).toLocaleDateString(),
        })
      );

      const thread = commentController.createCommentThread(uri, range, threadComments);
      thread.label = `PR #${prNumber}`;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.canReply = true;
      activeCommentThreads.push(thread);
    }

    log(`Created ${activeCommentThreads.length} comment thread(s)`);
  }

  // After every checkout/refresh: reload inline comments and sync the checkout
  // state so the panel can disable/enable the Checkout button correctly.
  context.subscriptions.push(
    changedFilesProvider.onDidSetFiles(({ prNumber, baseCommit }) => {
      prPanelProvider.checkedOutPrNumber = prNumber;
      prPanelProvider.refreshDetail(); // re-render so button state updates immediately
      void loadCommentThreads(prNumber, baseCommit);
    })
  );

  // ─── Commands ──────────────────────────────────────────────────────────────

  // Refresh PR list
  context.subscriptions.push(
    vscode.commands.registerCommand('kibana-pr-reviewer.refresh', async () => {
      await prPanelProvider.refresh();
    })
  );

  // Checkout a PR (triggered from tree item click or command palette)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'kibana-pr-reviewer.checkoutPR',
      async (prOrNumber: import('./services/github_service').GhPullRequest | number | undefined) => {
        let target: number | import('./services/github_service').GhPullRequest;

        if (prOrNumber && typeof prOrNumber === 'object' && 'number' in prOrNumber) {
          target = prOrNumber;
        } else if (typeof prOrNumber === 'number') {
          target = prOrNumber;
        } else {
          // Called from command palette without args — prompt for PR number
          const input = await vscode.window.showInputBox({
            prompt: 'Enter PR number to checkout',
            placeHolder: '12345',
            validateInput: (v) =>
              /^\d+$/.test(v.trim()) ? null : 'Enter a valid PR number',
          });
          if (!input) return;
          target = parseInt(input.trim(), 10);
        }

        await checkoutPR(target, {
          githubService,
          changedFilesProvider,
          prDescriptionProvider: prPanelProvider,
          statusBarItem,
          onCheckoutProgress: (stage) => prPanelProvider.setCheckoutButtonStatus(stage),
        });
      }
    )
  );

  // Open diff for a changed file
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'kibana-pr-reviewer.openDiff',
      async (
        fileOrItem: OrderedFile | undefined,
        prNumber?: number,
        baseCommit?: string
      ) => {
        let file: OrderedFile;
        let pr: number;
        let base: string;

        if (fileOrItem && prNumber !== undefined && baseCommit !== undefined) {
          file = fileOrItem;
          pr = prNumber;
          base = baseCommit;
        } else {
          void vscode.window.showWarningMessage(
            'Kibana PR Reviewer: No file selected to diff.'
          );
          return;
        }

        // Record which file is open so Prev/Next can navigate from it.
        const allFiles = changedFilesProvider.getCurrentFiles();
        const idx = allFiles.findIndex((f) => f.path === file.path);
        if (idx !== -1) {
          currentFileIndex = idx;
          log(`[nav] opened file ${idx} "${file.path}"`);
        }

        await openDiff(file, pr, base);
        changedFilesProvider.setActiveFile(file.path);
        void vscode.commands.executeCommand('setContext', 'kibana-pr-reviewer.prDiffOpen', true);
      }
    )
  );

  // ─── Prev / Next file navigation ────────────────────────────────────────────

  // Index of the file currently shown in the diff editor.
  let currentFileIndex: number | null = null;

  // Clear the context key whenever the user switches to a non-PR editor.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      const scheme = editor.document.uri.scheme;
      const isPrDiff = scheme === 'pr-base' || (() => {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) return false;
        const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
        return changedFilesProvider.getCurrentFiles().some((f) => f.path === rel);
      })();
      if (!isPrDiff) {
        void vscode.commands.executeCommand('setContext', 'kibana-pr-reviewer.prDiffOpen', false);
      }
    })
  );

  /** Open the diff for the file at `index` and reset hunk tracking. */
  async function navigateToFileAt(index: number): Promise<void> {
    const files = changedFilesProvider.getCurrentFiles();
    const prNumber = changedFilesProvider.getCurrentPrNumber();
    const baseCommit = changedFilesProvider.getCurrentBaseCommit();
    if (files.length === 0 || prNumber === null) return;

    const clamped = Math.max(0, Math.min(index, files.length - 1));
    currentFileIndex = clamped;
    log(`[nav] navigating to file ${clamped}: "${files[clamped].path}"`);

    await openDiff(files[clamped], prNumber, baseCommit);
    void vscode.commands.executeCommand('setContext', 'kibana-pr-reviewer.prDiffOpen', true);
    changedFilesProvider.setActiveFile(files[clamped].path);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('kibana-pr-reviewer.nextFile', async () => {
      const files = changedFilesProvider.getCurrentFiles();
      if (files.length === 0) return;
      await navigateToFileAt((currentFileIndex ?? -1) + 1);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kibana-pr-reviewer.prevFile', async () => {
      const files = changedFilesProvider.getCurrentFiles();
      if (files.length === 0) return;
      await navigateToFileAt((currentFileIndex ?? 1) - 1);
    })
  );

  // Add inline diff comment
  context.subscriptions.push(
    vscode.commands.registerCommand('kibana-pr-reviewer.addLineComment', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('Kibana PR Reviewer: No active editor.');
        return;
      }

      const prNumber = changedFilesProvider.getCurrentPrNumber();
      if (prNumber === null) {
        void vscode.window.showWarningMessage(
          'Kibana PR Reviewer: No PR checked out. Check out a PR first.'
        );
        return;
      }

      // Determine file path and diff side from the URI scheme.
      // Left side uses scheme "pr-base"; right side is the real workspace file.
      const uri = editor.document.uri;
      let filePath: string;
      let side: 'LEFT' | 'RIGHT';

      if (uri.scheme === 'pr-base') {
        filePath = decodeURIComponent(uri.path.slice(1)); // strip leading /
        side = 'LEFT';
      } else {
        filePath = vscode.workspace.asRelativePath(uri, false);
        side = 'RIGHT';
      }

      const line = editor.selection.active.line + 1; // convert to 1-indexed

      // Resolve the PR head commit from git (HEAD after checkout == PR head)
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      let headSha: string;
      try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        headSha = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
      } catch {
        void vscode.window.showErrorMessage(
          'Kibana PR Reviewer: Could not resolve HEAD commit — are you in the Kibana repo?'
        );
        return;
      }

      const body = await vscode.window.showInputBox({
        prompt: `Comment on ${side === 'LEFT' ? 'base' : 'head'} line ${line} of ${filePath}`,
        placeHolder: 'Write your comment…',
        ignoreFocusOut: true,
      });
      if (!body?.trim()) return;

      try {
        await githubService.postLineComment(prNumber, headSha, filePath, line, side, body.trim());
        void vscode.window.showInformationMessage(
          `Comment posted on ${filePath}:${line} (PR #${prNumber}).`
        );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Kibana PR Reviewer: Failed to post comment — ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    })
  );

  // ─── Shared helper: submit a comment from a CommentReply widget ───────────────

  async function submitCommentReply(reply: vscode.CommentReply): Promise<void> {
    const text = reply.text.trim();
    if (!text) return;

    const prNumber = changedFilesProvider.getCurrentPrNumber();
    if (prNumber === null) {
      void vscode.window.showWarningMessage('Kibana PR Reviewer: No PR checked out.');
      reply.thread.dispose();
      return;
    }

    const uri = reply.thread.uri;
    let filePath: string;
    let side: 'LEFT' | 'RIGHT';
    if (uri.scheme === 'pr-base') {
      filePath = decodeURIComponent(uri.path.slice(1));
      side = 'LEFT';
    } else {
      filePath = vscode.workspace.asRelativePath(uri, false);
      side = 'RIGHT';
    }

    const line = (reply.thread.range?.start.line ?? 0) + 1; // 1-indexed
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    let headSha: string;
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      headSha = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    } catch {
      void vscode.window.showErrorMessage(
        'Kibana PR Reviewer: Could not resolve HEAD commit.'
      );
      return;
    }

    try {
      await githubService.postLineComment(prNumber, headSha, filePath, line, side, text);
      // Add the posted comment to the thread so it persists in the UI
      const posted: vscode.Comment = {
        author: { name: 'You' },
        body: new vscode.MarkdownString(text),
        mode: vscode.CommentMode.Preview,
        timestamp: new Date(),
      };
      reply.thread.comments = [...reply.thread.comments, posted];
      reply.thread.canReply = true;
      void vscode.window.showInformationMessage(
        `Comment posted on ${filePath}:${line} (PR #${prNumber}).`
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Kibana PR Reviewer: Failed to post comment — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Submit button for new (empty) threads created via gutter click
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'kibana-pr-reviewer.createNote',
      (reply: vscode.CommentReply) => { void submitCommentReply(reply); }
    )
  );

  // Reply button for existing threads that already have comments
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'kibana-pr-reviewer.replyNote',
      (reply: vscode.CommentReply) => { void submitCommentReply(reply); }
    )
  );

  // Delete/cancel a pending thread
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'kibana-pr-reviewer.deleteThread',
      (thread: vscode.CommentThread) => { thread.dispose(); }
    )
  );

  // Set LLM API key (stored in SecretStorage)
  context.subscriptions.push(
    vscode.commands.registerCommand('kibana-pr-reviewer.setApiKey', async () => {
      const cfg = vscode.workspace.getConfiguration('kibana-pr-reviewer');
      const provider = cfg.get<string>('llmProvider', 'none');

      if (provider === 'none') {
        void vscode.window.showInformationMessage(
          'Set kibana-pr-reviewer.llmProvider to "openai" or "anthropic" first.'
        );
        return;
      }

      const key = await vscode.window.showInputBox({
        prompt: `Enter your ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key`,
        password: true,
        ignoreFocusOut: true,
      });

      if (key) {
        await context.secrets.store('kibana-pr-reviewer.llmApiKey', key);
        void vscode.window.showInformationMessage(
          `Kibana PR Reviewer: ${provider} API key saved.`
        );
      }
    })
  );

  // Refresh inline PR comments manually (e.g. after someone else posts a review)
  context.subscriptions.push(
    vscode.commands.registerCommand('kibana-pr-reviewer.refreshComments', async () => {
      const prNumber = changedFilesProvider.getCurrentPrNumber();
      const baseCommit = changedFilesProvider.getCurrentBaseCommit();
      if (prNumber === null) {
        void vscode.window.showInformationMessage(
          'Kibana PR Reviewer: No PR checked out.'
        );
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Refreshing PR comments…' },
        async () => loadCommentThreads(prNumber, baseCommit)
      );
    })
  );

  // Owned-by-me filter — two commands so the icon changes when active
  const setOwnedByMeContext = (active: boolean) =>
    vscode.commands.executeCommand('setContext', 'kibana-pr-reviewer.ownedByMeFilterActive', active);

  context.subscriptions.push(
    vscode.commands.registerCommand('kibana-pr-reviewer.enableOwnedByMeFilter', async () => {
      const allPaths = changedFilesProvider.getCurrentFiles().map((f) => f.path);

      if (allPaths.length === 0) {
        void vscode.window.showInformationMessage(
          'Kibana PR Reviewer: No changed files to filter. Check out a PR first.'
        );
        return;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Finding files owned by your teams…' },
        async () => {
          const ownedPaths = await codeOwnersService.getOwnedFiles(allPaths);
          changedFilesProvider.setOwnedByMeFilter(new Set(ownedPaths));
          void setOwnedByMeContext(true);
          log(`Owned-by-me filter: ${ownedPaths.length}/${allPaths.length} files`);
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kibana-pr-reviewer.disableOwnedByMeFilter', () => {
      changedFilesProvider.setOwnedByMeFilter(null);
      void setOwnedByMeContext(false);
    })
  );


  // Diagnostics — show detected teams and a sample of PR reviewRequests
  context.subscriptions.push(
    vscode.commands.registerCommand('kibana-pr-reviewer.showDiagnostics', async () => {
      const teams = await codeOwnersService.refreshTeams();

      let prSample = '';
      try {
        const prs = await githubService.listOpenPRsForTeams(teams);
        if (prs.length > 0) {
          const sample = prs.slice(0, 3).map((pr) =>
            `  #${pr.number} reviewRequests: ${JSON.stringify(pr.reviewRequests)} | reviewDecision: ${pr.reviewDecision}`
          ).join('\n');
          prSample = `\n\nFirst ${Math.min(prs.length, 3)} of ${prs.length} PRs for your teams:\n${sample}`;
        } else {
          prSample = '\n\nNo PRs found for your teams.';
        }
      } catch (err) {
        prSample = `\n\nFailed to fetch PRs: ${err instanceof Error ? err.message : String(err)}`;
      }

      void vscode.window.showInformationMessage(
        `Detected teams: ${teams.length > 0 ? teams.join(', ') : '(none)'}${prSample}`,
        { modal: true }
      );
    })
  );

  // Clear checked-out PR state
  context.subscriptions.push(
    vscode.commands.registerCommand('kibana-pr-reviewer.clearCheckedOutPR', () => {
      prPanelProvider.checkedOutPrNumber = null;
      prPanelProvider.clear(true); // clears files + PR description
      clearCommentThreads();
      void setOwnedByMeContext(false);
      statusBarItem.text = '$(git-pull-request) PR Reviewer';
      statusBarItem.tooltip = 'Kibana PR Reviewer';
    })
  );

  // ─── Configuration change handler ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('kibana-pr-reviewer.repo')) {
        const newRepo = vscode.workspace
          .getConfiguration('kibana-pr-reviewer')
          .get<string>('repo', 'elastic/kibana');
        Object.assign(githubService, new GitHubService(newRepo));
        void prPanelProvider.refresh();
      }
      if (e.affectsConfiguration('kibana-pr-reviewer.userTeams')) {
        void prPanelProvider.refresh();
      }
    })
  );

  // ─── Terminal cleanup ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => {
      if (t.name === 'Kibana PR Reviewer') {
        // Terminal closed externally; nothing to do — we'll create a new one next time
      }
    })
  );

  // ─── Initial load ──────────────────────────────────────────────────────────
  showLog();
  void prPanelProvider.refresh();

  // ─── Branch-based PR restore ───────────────────────────────────────────────
  void (async () => {
    try {
      log('[restore] Starting branch PR detection…');

      const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      log(`[restore] workspaceCwd = ${workspaceCwd ?? '(none)'}`);
      if (!workspaceCwd) {
        log('[restore] No workspace folder — skipping.');
        return;
      }

      log('[restore] Calling gh pr view…');
      const pr = await githubService.getPRForCurrentBranch(workspaceCwd);
      log(`[restore] getPRForCurrentBranch returned: ${pr ? `PR #${pr.number} "${pr.title}"` : 'null'}`);

      if (!pr) {
        log('[restore] No PR for current branch — nothing to restore.');
        return;
      }

      const ctx = {
        githubService,
        changedFilesProvider,
        prDescriptionProvider: prPanelProvider,
        statusBarItem,
      };

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Kibana PR Reviewer: Resuming PR #${pr.number}`,
          cancellable: false,
        },
        async (progress) => {
          log('[restore] Opening sidebar…');
          await vscode.commands.executeCommand('workbench.view.extension.kibana-pr-reviewer');
          log('[restore] Sidebar opened, waiting for webview…');

          // Give VS Code a tick to call resolveWebviewView after the sidebar opens
          await new Promise((r) => setTimeout(r, 300));
          log(`[restore] viewReady resolved: calling loadPRData for PR #${pr.number}`);

          await loadPRData(pr.number, ctx, progress);
          log(`[restore] loadPRData complete for PR #${pr.number}`);
        }
      );

      log(`[restore] Done — PR #${pr.number} restored.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[restore] FAILED: ${msg}`);
      void vscode.window.showWarningMessage(
        `Kibana PR Reviewer: Could not restore PR state — ${msg}`
      );
    }
  })();

  // Cleanup on deactivate
  context.subscriptions.push({ dispose: disposeTerminal });
}

export function deactivate(): void {
  disposeTerminal();
}
