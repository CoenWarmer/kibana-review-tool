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
import {
  openDiff,
  openCommitInIde,
  openCommitFileDiff,
  GitBaseContentProvider,
} from './commands/open_diff';
import { initLogger, log, logError } from './logger';

/**
 * Returns true when the workspace root is the Kibana repository, detected by
 * checking that `package.json` at the root has `"name": "kibana"`.
 */
function isKibanaWorkspace(root: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      name?: string;
    };
    return pkg.name === 'kibana';
  } catch {
    return false;
  }
}

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
  const config = vscode.workspace.getConfiguration('elastic-pr-reviewer');
  const repo = config.get<string>('repo', 'elastic/kibana');
  log(`Repo: ${repo}`);

  const githubService = new GitHubService(repo);
  const codeOwnersService = new CodeOwnersService(githubService, context);

  // Clear any cache written by a previous version (wrong API endpoint)
  codeOwnersService.clearCache();

  // ─── Check gh is installed and authenticated ───────────────────────────────
  const ghOk = await githubService.isGhAuthenticated();
  if (!ghOk) {
    void vscode.window
      .showWarningMessage(
        'Elastic PR Reviewer: `gh` CLI is not authenticated. Run `gh auth login` first.',
        'Open Terminal'
      )
      .then((choice) => {
        if (choice === 'Open Terminal') {
          vscode.commands.executeCommand('workbench.action.terminal.new');
        }
      });
  }

  // ─── Status bar ────────────────────────────────────────────────────────────
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(git-pull-request) PR Reviewer';
  statusBarItem.tooltip = 'Elastic PR Reviewer — click to clear current PR';
  statusBarItem.command = 'elastic-pr-reviewer.clearCheckedOutPR';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // ─── Providers ─────────────────────────────────────────────────────────────
  const prPanelProvider = new PrPanelProvider(
    githubService,
    codeOwnersService,
    context.extensionUri
  );
  const changedFilesProvider = prPanelProvider; // unified panel

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PrPanelProvider.viewId, prPanelProvider, {
      // Preserve webview DOM while the panel is hidden so live JS-updated state
      // (server status dots, active file highlight, etc.) survives view switches.
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // ─── Workspace validation ───────────────────────────────────────────────────
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  prPanelProvider.setWrongRepo(!isKibanaWorkspace(workspaceRoot));

  // Re-check whenever the user adds or removes workspace folders.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const newRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      prPanelProvider.setWrongRepo(!isKibanaWorkspace(newRoot));
    })
  );

  // ─── Dev server status ─────────────────────────────────────────────────────
  const serverStatusService = new ServerStatusService(getKibanaDevUrl(workspaceRoot));

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
        void vscode.window
          .showErrorMessage(`Review order suggestion failed: ${msg}`, ...actions)
          .then((choice) => {
            if (choice === 'Open Settings') {
              void vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'elastic-pr-reviewer.llm'
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

  // ─── Synthtrace ────────────────────────────────────────────────────────────
  const SYNTHTRACE_SCENARIOS_DIR = path.join(
    workspaceRoot,
    'src/platform/packages/shared/kbn-synthtrace/src/scenarios'
  );

  function loadSynthtraceScenarios(): string[] {
    try {
      return fs
        .readdirSync(SYNTHTRACE_SCENARIOS_DIR)
        .filter((f) => f.endsWith('.ts') || f.endsWith('.js'))
        .sort();
    } catch {
      return [];
    }
  }

  prPanelProvider.setSynthtraceScenarios(loadSynthtraceScenarios());

  prPanelProvider.onRefreshScenarios = () => {
    prPanelProvider.setSynthtraceScenarios(loadSynthtraceScenarios());
  };

  prPanelProvider.onRunSynthtrace = (scenario: string, live: boolean) => {
    const cmd = `node scripts/synthtrace.js ${scenario}${live ? ' --live' : ''}`;
    log(`[Synthtrace] Running: ${cmd}`);
    const terminal = vscode.window.createTerminal({
      name: 'Synthtrace',
      cwd: workspaceRoot,
    });
    terminal.show(true);
    terminal.sendText(cmd);
  };

  // ─── Team filter persistence ───────────────────────────────────────────────
  const TEAM_FILTER_KEY = 'elastic-pr-reviewer.teamFilter';
  const savedTeamFilter = context.globalState.get<string>(TEAM_FILTER_KEY, '');
  if (savedTeamFilter) {
    prPanelProvider.setTeamFilter(savedTeamFilter);
  }
  prPanelProvider.onSetTeamFilter = (team) => {
    void context.globalState.update(TEAM_FILTER_KEY, team);
  };

  // Wire up checkout button in panel → checkout command
  prPanelProvider.onCheckout = (pr) => {
    void vscode.commands.executeCommand('elastic-pr-reviewer.checkoutPR', pr);
  };

  // Wire up file clicks in the Changed Files webview → open diff command
  changedFilesProvider.onOpenFile = (file, prNumber, baseCommit) => {
    void vscode.commands.executeCommand('elastic-pr-reviewer.openDiff', file, prNumber, baseCommit);
  };

  // Wire up owned-by-me toggle from the webview toolbar
  changedFilesProvider.onToggleOwnedByMe = () => {
    if (changedFilesProvider.isOwnedByMeFilterActive) {
      void vscode.commands.executeCommand('elastic-pr-reviewer.disableOwnedByMeFilter');
    } else {
      void vscode.commands.executeCommand('elastic-pr-reviewer.enableOwnedByMeFilter');
    }
  };

  // When the user selects a PR from the queue, refresh its state.
  // If it matches the checked-out branch: reload changed files and inline comments.
  // If it differs: clear both so stale data from a previous checkout is not shown.
  prPanelProvider.onSelectPR = (pr) => {
    // Use the stable checkedOutPrNumber (set on checkout completion), NOT cfPrNumber
    // which is reset to null whenever clear() is called for a different PR.
    const checkedOutPrNumber = prPanelProvider.checkedOutPrNumber;
    if (pr.number === checkedOutPrNumber) {
      void refreshFilesAndComments(pr.number);
    } else {
      changedFilesProvider.clear();
      clearCommentThreads();
    }
  };

  // Refresh button: re-fetch description, files and comments for the current PR.
  prPanelProvider.onRefreshPR = (pr) => {
    prPanelProvider.refreshDetail();
    if (pr.number === prPanelProvider.checkedOutPrNumber) {
      void refreshFilesAndComments(pr.number);
    }
  };

  prPanelProvider.onOpenCommit = (sha) => {
    void openCommitInIde(sha);
  };

  prPanelProvider.onOpenCommitFile = (sha, path, beforePath) => {
    void openCommitFileDiff(sha, path, beforePath ?? path);
  };

  // ─── Git base content provider ─────────────────────────────────────────────
  const gitContentProvider = new GitBaseContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('pr-base', gitContentProvider)
  );

  // ─── Inline PR comment threads ─────────────────────────────────────────────
  const commentController = vscode.comments.createCommentController(
    'elastic-pr-reviewer',
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
      logError(
        `[refreshFilesAndComments] Failed: ${err instanceof Error ? err.message : String(err)}`
      );
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
      logError(
        `Failed to load inline comments: ${err instanceof Error ? err.message : String(err)}`
      );
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
    vscode.commands.registerCommand('elastic-pr-reviewer.refresh', async () => {
      await prPanelProvider.refresh();
    })
  );

  // Checkout a PR (triggered from tree item click or command palette)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'elastic-pr-reviewer.checkoutPR',
      async (
        prOrNumber: import('./services/github_service').GhPullRequest | number | undefined
      ) => {
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
            validateInput: (v) => (/^\d+$/.test(v.trim()) ? null : 'Enter a valid PR number'),
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
      'elastic-pr-reviewer.openDiff',
      async (fileOrItem: OrderedFile | undefined, prNumber?: number, baseCommit?: string) => {
        let file: OrderedFile;
        let pr: number;
        let base: string;

        if (fileOrItem && prNumber !== undefined && baseCommit !== undefined) {
          file = fileOrItem;
          pr = prNumber;
          base = baseCommit;
        } else {
          void vscode.window.showWarningMessage('Elastic PR Reviewer: No file selected to diff.');
          return;
        }

        await openDiff(file, pr, base);
        changedFilesProvider.setActiveFile(file.path);
      }
    )
  );

  // Add inline diff comment
  context.subscriptions.push(
    vscode.commands.registerCommand('elastic-pr-reviewer.addLineComment', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('Elastic PR Reviewer: No active editor.');
        return;
      }

      const prNumber = changedFilesProvider.getCurrentPrNumber();
      if (prNumber === null) {
        void vscode.window.showWarningMessage(
          'Elastic PR Reviewer: No PR checked out. Check out a PR first.'
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
          'Elastic PR Reviewer: Could not resolve HEAD commit — are you in the Kibana repo?'
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
          `Elastic PR Reviewer: Failed to post comment — ${
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
      void vscode.window.showWarningMessage('Elastic PR Reviewer: No PR checked out.');
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
      void vscode.window.showErrorMessage('Elastic PR Reviewer: Could not resolve HEAD commit.');
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
        `Elastic PR Reviewer: Failed to post comment — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Submit button for new (empty) threads created via gutter click
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'elastic-pr-reviewer.createNote',
      (reply: vscode.CommentReply) => {
        void submitCommentReply(reply);
      }
    )
  );

  // Reply button for existing threads that already have comments
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'elastic-pr-reviewer.replyNote',
      (reply: vscode.CommentReply) => {
        void submitCommentReply(reply);
      }
    )
  );

  // Delete/cancel a pending thread
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'elastic-pr-reviewer.deleteThread',
      (thread: vscode.CommentThread) => {
        thread.dispose();
      }
    )
  );

  // Set LLM API key (stored in SecretStorage)
  context.subscriptions.push(
    vscode.commands.registerCommand('elastic-pr-reviewer.setApiKey', async () => {
      const cfg = vscode.workspace.getConfiguration('elastic-pr-reviewer');
      const provider = cfg.get<string>('llmProvider', 'none');

      if (provider === 'none') {
        void vscode.window.showInformationMessage(
          'Set elastic-pr-reviewer.llmProvider to "openai" or "anthropic" first.'
        );
        return;
      }

      const key = await vscode.window.showInputBox({
        prompt: `Enter your ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key`,
        password: true,
        ignoreFocusOut: true,
      });

      if (key) {
        await context.secrets.store('elastic-pr-reviewer.llmApiKey', key);
        void vscode.window.showInformationMessage(
          `Elastic PR Reviewer: ${provider} API key saved.`
        );
      }
    })
  );

  // Refresh inline PR comments manually (e.g. after someone else posts a review)
  context.subscriptions.push(
    vscode.commands.registerCommand('elastic-pr-reviewer.refreshComments', async () => {
      const prNumber = changedFilesProvider.getCurrentPrNumber();
      const baseCommit = changedFilesProvider.getCurrentBaseCommit();
      if (prNumber === null) {
        void vscode.window.showInformationMessage('Elastic PR Reviewer: No PR checked out.');
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
    vscode.commands.executeCommand(
      'setContext',
      'elastic-pr-reviewer.ownedByMeFilterActive',
      active
    );

  context.subscriptions.push(
    vscode.commands.registerCommand('elastic-pr-reviewer.enableOwnedByMeFilter', async () => {
      const allPaths = changedFilesProvider.getCurrentFiles().map((f) => f.path);

      if (allPaths.length === 0) {
        void vscode.window.showInformationMessage(
          'Elastic PR Reviewer: No changed files to filter. Check out a PR first.'
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
    vscode.commands.registerCommand('elastic-pr-reviewer.disableOwnedByMeFilter', () => {
      changedFilesProvider.setOwnedByMeFilter(null);
      void setOwnedByMeContext(false);
    })
  );

  // Diagnostics — show detected teams and a sample of PR reviewRequests
  context.subscriptions.push(
    vscode.commands.registerCommand('elastic-pr-reviewer.showDiagnostics', async () => {
      const teams = await codeOwnersService.refreshTeams();

      let prSample = '';
      try {
        const prs = await githubService.listOpenPRsForTeams(teams);
        if (prs.length > 0) {
          const sample = prs
            .slice(0, 3)
            .map(
              (pr) =>
                `  #${pr.number} reviewRequests: ${JSON.stringify(pr.reviewRequests)} | reviewDecision: ${pr.reviewDecision}`
            )
            .join('\n');
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
    vscode.commands.registerCommand('elastic-pr-reviewer.clearCheckedOutPR', () => {
      prPanelProvider.checkedOutPrNumber = null;
      prPanelProvider.clear(true); // clears files + PR description
      clearCommentThreads();
      void setOwnedByMeContext(false);
      statusBarItem.text = '$(git-pull-request) PR Reviewer';
      statusBarItem.tooltip = 'Elastic PR Reviewer';
    })
  );

  // ─── Configuration change handler ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('elastic-pr-reviewer.repo')) {
        const newRepo = vscode.workspace
          .getConfiguration('elastic-pr-reviewer')
          .get<string>('repo', 'elastic/kibana');
        Object.assign(githubService, new GitHubService(newRepo));
        void prPanelProvider.refresh();
      }
      if (e.affectsConfiguration('elastic-pr-reviewer.userTeams')) {
        void prPanelProvider.refresh();
      }
    })
  );

  // ─── Terminal cleanup ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => {
      if (t.name === 'Elastic PR Reviewer') {
        // Terminal closed externally; nothing to do — we'll create a new one next time
      }
    })
  );

  // ─── Initial load ──────────────────────────────────────────────────────────
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

      // Read the current branch first so we can always populate currentBranch in state.
      let currentBranchName: string | null = null;
      try {
        const { execFile: ef } = await import('child_process');
        const { promisify: pf } = await import('util');
        const { stdout } = await pf(ef)('git', ['branch', '--show-current'], {
          cwd: workspaceCwd,
        });
        currentBranchName = stdout.trim() || null;
      } catch {
        // git unavailable — leave as null
      }
      prPanelProvider.setCurrentBranch(currentBranchName);

      log('[restore] Calling gh pr view…');
      const pr = await githubService.getPRForCurrentBranch(workspaceCwd);
      log(
        `[restore] getPRForCurrentBranch returned: ${pr ? `PR #${pr.number} "${pr.title}"` : 'null'}`
      );

      if (!pr) {
        log('[restore] No PR for current branch — nothing to restore.');
        // Explicitly reset to guard against VS Code restoring stale webview state
        // (e.g. window reload, retainContextWhenHidden, or workspace-state revival).
        prPanelProvider.resetToQueue();
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
          title: `Elastic PR Reviewer: Resuming PR #${pr.number}`,
          cancellable: false,
        },
        async (progress) => {
          log('[restore] Opening sidebar…');
          await vscode.commands.executeCommand('workbench.view.extension.elastic-pr-reviewer');
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
      logError(`[restore] FAILED: ${msg}`);
      void vscode.window.showWarningMessage(
        `Elastic PR Reviewer: Could not restore PR state — ${msg}`
      );
    } finally {
      // Always mark restore as complete so the UI can reveal the correct tab label.
      prPanelProvider.setRestoreComplete();
    }
  })();

  // ─── Branch-change detection on window focus ───────────────────────────────
  // When the user switches back to VS Code after manually changing branches in
  // a terminal, detect the mismatch and reset the panel to the queue tab.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(async (windowState) => {
      if (!windowState.focused) return;

      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!cwd || prPanelProvider.checkedOutPrNumber === null) return;

      const expectedBranch = prPanelProvider.currentPr?.headRefName;
      if (!expectedBranch) return;

      try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const { stdout } = await promisify(execFile)('git', ['branch', '--show-current'], { cwd });
        const currentBranch = stdout.trim();

        prPanelProvider.setCurrentBranch(currentBranch || null);

        if (currentBranch && currentBranch !== expectedBranch) {
          log(
            `[branch-watch] Branch changed from "${expectedBranch}" to "${currentBranch}" — clearing checkout state`
          );
          prPanelProvider.resetToQueue();
          clearCommentThreads();
        }
      } catch {
        // git unavailable or not in a git repo — ignore silently
      }
    })
  );

  // Cleanup on deactivate
  context.subscriptions.push({ dispose: disposeTerminal });
}

export function deactivate(): void {
  disposeTerminal();
}
