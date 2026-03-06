import * as vscode from 'vscode';
import type { GitHubService, GhPullRequest, GhDiscussionComment } from '../services/github_service';
import type { CodeOwnersService } from '../services/codeowners_service';
import type { OrderedFile } from '../services/file_ordering_service';
import type { ReviewOrderSuggestion } from '../services/review_order_service';
import { log } from '../logger';

// ─── Message types ────────────────────────────────────────────────────────────

type InboundMessage =
  | { type: 'ready' }
  | { type: 'selectPR'; prNumber: number }
  | { type: 'switchTab'; tab: 'queue' | 'reviewing' | 'files' }
  | { type: 'toggleFilter' }
  | { type: 'checkout' }
  | { type: 'refreshPR' }
  | { type: 'postComment'; body: string }
  | { type: 'approveReview'; body: string }
  | { type: 'requestChanges'; body: string }
  | { type: 'openFile'; path: string }
  | { type: 'toggleReviewed'; path: string }
  | { type: 'toggleOwnedByMe' }
  | { type: 'suggestOrder' }
  | { type: 'setOrderMode'; mode: 'default' | 'top-down' | 'bottom-up' }
  | { type: 'startEs' }
  | { type: 'startKibana' }
  | { type: 'openKibana' }
  | { type: 'runSynthtrace'; scenario: string; live: boolean }
  | { type: 'refreshScenarios' }
  | { type: 'setTeamFilter'; team: string };

// ─── Provider ─────────────────────────────────────────────────────────────────

export class PrPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'kibana-pr-reviewer.prPanel';

  private view?: vscode.WebviewView;

  // Queue state
  private allPrs: GhPullRequest[] = [];
  private isLoading = false;
  private errorMessage = '';
  private needsReviewFilterActive = false;
  private userTeams: string[] = [];
  private teamFilter = '';

  // Description state
  currentPr?: GhPullRequest;
  private discussionComments: GhDiscussionComment[] = [];

  // Tab state — tracked server-side so re-renders don't reset the tab
  private activeTab: 'queue' | 'reviewing' = 'queue';

  // ─── Changed Files state ────────────────────────────────────────────────────
  private cfPrNumber: number | null = null;
  private cfBaseCommit = '';
  private cfFiles: OrderedFile[] = [];
  private cfActiveFile: string | null = null;
  private cfReviewedPaths = new Set<string>();
  private cfOwnedByMeFilter: Set<string> | null = null;
  private cfIsLoading = false;
  private cfErrorMessage = '';

  // ─── Review order state ──────────────────────────────────────────────────────
  private cfSuggestedOrder: ReviewOrderSuggestion | null = null;
  private cfOrderMode: 'default' | 'top-down' | 'bottom-up' = 'default';
  private cfIsOrderLoading = false;

  /** PR number currently checked out on the local git branch, or null if none. */
  private _checkedOutPrNumber: number | null = null;
  get checkedOutPrNumber(): number | null { return this._checkedOutPrNumber; }
  set checkedOutPrNumber(value: number | null) {
    this._checkedOutPrNumber = value;
    this.sendState({ checkedOutPrNumber: value });
  }

  // ─── Dev server status ──────────────────────────────────────────────────────
  private esStatus: 'running' | 'starting' | 'stopped' = 'stopped';
  private kibanaStatus: 'running' | 'starting' | 'stopped' = 'stopped';

  // ─── Synthtrace ──────────────────────────────────────────────────────────────
  private synthtraceScenarios: string[] = [];

  // ─── Checkout button state ──────────────────────────────────────────────────
  private checkoutBusy = false;
  private checkoutStage = '';

  /** Fired when the user clicks Start/Restart Elasticsearch. */
  onStartEs?: () => void;

  /** Fired when the user clicks Start/Restart Kibana. */
  onStartKibana?: () => void;

  /** Fired when the user clicks "Open Kibana". */
  onOpenKibana?: () => void;

  /** Fired when the user clicks "Run synthtrace". */
  onRunSynthtrace?: (scenario: string, live: boolean) => void;

  /** Fired when the user clicks the scenarios settings/refresh button. */
  onRefreshScenarios?: () => void;

  /** Fired when the user selects a team filter. */
  onSetTeamFilter?: (team: string) => void;

  /** Fired when the user clicks "✦ Suggest order". */
  onSuggestOrder?: () => void;

  /** Resolves once the webview is first initialised. */
  private viewReadyResolve?: () => void;
  readonly viewReady: Promise<void> = new Promise<void>((resolve) => {
    this.viewReadyResolve = resolve;
  });

  /** Fires whenever a new set of files is loaded (after a PR checkout). */
  private readonly _onDidSetFiles = new vscode.EventEmitter<{
    prNumber: number;
    baseCommit: string;
  }>();
  readonly onDidSetFiles = this._onDidSetFiles.event;

  /** Fired when the user clicks a file row in the Changed Files tab. */
  onOpenFile?: (file: OrderedFile, prNumber: number, baseCommit: string) => void;

  /** Fired when the user clicks the "Owned by me" toggle. */
  onToggleOwnedByMe?: () => void;

  /** Fired when the user clicks the Checkout button. */
  onCheckout?: (pr: GhPullRequest) => void;

  /** Fired when the user selects a PR card from the queue. */
  onSelectPR?: (pr: GhPullRequest) => void;

  /** Fired when the user clicks the Refresh button in the description pane. */
  onRefreshPR?: (pr: GhPullRequest) => void;

  constructor(
    private readonly githubService: GitHubService,
    private readonly codeOwnersService: CodeOwnersService,
    private readonly extensionUri: vscode.Uri
  ) {}

  // ─── VS Code lifecycle ───────────────────────────────────────────────────────

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    log('[PrPanelProvider] resolveWebviewView called');
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.buildShellHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg: InboundMessage) => {
      switch (msg.type) {
        case 'ready':
          this.sendState();
          break;
        case 'selectPR': {
          const pr = this.allPrs.find((p) => p.number === msg.prNumber);
          if (pr) {
            this.currentPr = pr;
            this.activeTab = 'reviewing';
            this.sendState({ currentPr: pr, activeTab: 'reviewing', discussionComments: [] });
            this.onSelectPR?.(pr);
            void this.fetchAndUpdateDetail(pr.number);
          }
          break;
        }
        case 'switchTab':
          if (msg.tab === 'queue' || msg.tab === 'reviewing') {
            this.activeTab = msg.tab;
            this.sendState({ activeTab: this.activeTab });
          }
          break;
        case 'toggleFilter':
          this.needsReviewFilterActive = !this.needsReviewFilterActive;
          this.sendState({ needsReviewFilterActive: this.needsReviewFilterActive });
          break;
        case 'checkout':
          if (this.currentPr) this.onCheckout?.(this.currentPr);
          break;
        case 'refreshPR':
          if (this.currentPr) this.onRefreshPR?.(this.currentPr);
          break;
        case 'postComment':
          if (this.currentPr && msg.body?.trim()) {
            await this.handlePostComment(this.currentPr.number, msg.body.trim());
          }
          break;
        case 'approveReview':
          if (this.currentPr) {
            await this.handleSubmitReview(this.currentPr.number, 'APPROVE', msg.body);
          }
          break;
        case 'requestChanges':
          if (this.currentPr) {
            await this.handleSubmitReview(this.currentPr.number, 'REQUEST_CHANGES', msg.body);
          }
          break;
        case 'openFile': {
          const file = this.cfFiles.find((f) => f.path === msg.path);
          if (file && this.cfPrNumber !== null) {
            this.cfActiveFile = msg.path;
            this.onOpenFile?.(file, this.cfPrNumber, this.cfBaseCommit);
          }
          break;
        }
        case 'toggleReviewed':
          if (this.cfReviewedPaths.has(msg.path)) {
            this.cfReviewedPaths.delete(msg.path);
          } else {
            this.cfReviewedPaths.add(msg.path);
          }
          this.sendState({ cfReviewedPaths: [...this.cfReviewedPaths] });
          break;
        case 'toggleOwnedByMe':
          this.onToggleOwnedByMe?.();
          break;
        case 'suggestOrder':
          this.onSuggestOrder?.();
          break;
        case 'setOrderMode':
          this.cfOrderMode = msg.mode;
          this.sendState({ cfOrderMode: this.cfOrderMode });
          break;
        case 'startEs':
          this.onStartEs?.();
          break;
        case 'startKibana':
          this.onStartKibana?.();
          break;
        case 'openKibana':
          this.onOpenKibana?.();
          break;
        case 'runSynthtrace':
          this.onRunSynthtrace?.(msg.scenario, msg.live);
          break;
        case 'refreshScenarios':
          this.onRefreshScenarios?.();
          break;
        case 'setTeamFilter':
          this.teamFilter = msg.team;
          this.sendState({ teamFilter: this.teamFilter });
          this.onSetTeamFilter?.(msg.team);
          break;
      }
    });

    // Re-sync state whenever the view becomes visible again.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendState();
      }
    });

    log('[PrPanelProvider] resolveWebviewView done');
    this.viewReadyResolve?.();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  setSynthtraceScenarios(scenarios: string[]): void {
    this.synthtraceScenarios = scenarios;
    this.sendState({ synthtraceScenarios: scenarios });
  }

  setTeamFilter(team: string): void {
    this.teamFilter = team;
    this.sendState({ teamFilter: team });
  }

  setPR(pr: GhPullRequest): void {
    this.currentPr = pr;
    this.activeTab = 'reviewing';
    if (this.view) {
      this.sendState();
      this.view.show(true);
    } else {
      void vscode.commands.executeCommand(`${PrPanelProvider.viewId}.focus`);
    }
  }

  /**
   * Clears changed-files state.
   * Pass `includeDescription: true` to also clear the current PR description.
   */
  clear(includeDescription = false): void {
    if (includeDescription) {
      this.currentPr = undefined;
    }
    this.cfPrNumber = null;
    this.cfBaseCommit = '';
    this.cfFiles = [];
    this.cfActiveFile = null;
    this.cfReviewedPaths.clear();
    this.cfOwnedByMeFilter = null;
    this.cfIsLoading = false;
    this.cfErrorMessage = '';
    this.cfSuggestedOrder = null;
    this.cfOrderMode = 'default';
    this.cfIsOrderLoading = false;
    this.discussionComments = [];
    this.sendState();
  }

  async refresh(): Promise<void> {
    if (this.isLoading) return;

    log('--- PR list refresh started ---');
    this.isLoading = true;
    this.errorMessage = '';
    this.sendState({ isLoading: true, errorMessage: '' });

    try {
      const config = vscode.workspace.getConfiguration('kibana-pr-reviewer');
      log(`Config: repo=${config.get('repo')}`);

      const userTeams = await this.codeOwnersService.getUserTeams();
      log(`User teams: ${userTeams.length > 0 ? userTeams.join(', ') : '(none)'}`);
      this.userTeams = userTeams;

      if (userTeams.length === 0) {
        this.allPrs = [];
        this.errorMessage =
          'No teams detected. Set kibana-pr-reviewer.userTeams in Settings ' +
          '(e.g. ["@elastic/obs-onboarding-team"]).';
        this.isLoading = false;
        this.sendState({ allPrs: [], userTeams: [], errorMessage: this.errorMessage, isLoading: false });
        return;
      }

      this.allPrs = await this.githubService.listOpenPRsForTeams(userTeams);
      log(`PRs returned for teams: ${this.allPrs.length}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`ERROR during refresh: ${msg}`);
      this.errorMessage = `Failed to load PRs: ${msg}`;
    }

    this.isLoading = false;
    this.sendState({ allPrs: this.allPrs, userTeams: this.userTeams, isLoading: false, errorMessage: this.errorMessage });
  }

  /** Public entry point to re-fetch and re-render the currently displayed PR detail. */
  refreshDetail(): void {
    if (this.currentPr) void this.fetchAndUpdateDetail(this.currentPr.number);
  }

  // ─── Changed Files public API ─────────────────────────────────────────────

  setFiles(prNumber: number, baseCommit: string, files: OrderedFile[]): void {
    this.cfPrNumber = prNumber;
    this.cfBaseCommit = baseCommit;
    this.cfFiles = files;
    this.cfReviewedPaths.clear();
    this.cfActiveFile = null;
    this.cfIsLoading = false;
    this.cfErrorMessage = '';
    this.cfOwnedByMeFilter = null; // reset on new file set
    this.activeTab = 'reviewing';
    this.sendState({
      cfFiles: files,
      cfReviewedPaths: [],
      cfActiveFile: null,
      cfIsLoading: false,
      cfErrorMessage: '',
      cfOwnedByMePaths: null,
      activeTab: 'reviewing',
    });
    this._onDidSetFiles.fire({ prNumber, baseCommit });

    // Precompute owned paths in the background so the filter toggle is instant.
    void this.precomputeOwnedPaths(files.map((f) => f.path));
  }

  private async precomputeOwnedPaths(paths: string[]): Promise<void> {
    try {
      const ownedPaths = await this.codeOwnersService.getOwnedFiles(paths);
      // Guard: only update if the file list hasn't been replaced by another checkout.
      if (this.cfFiles.length > 0 && this.cfFiles[0].path === paths[0]) {
        this.cfOwnedByMeFilter = new Set(ownedPaths);
        this.sendState({ cfOwnedByMePaths: ownedPaths });
      }
    } catch {
      // ignore — filter button will simply remain disabled
    }
  }

  setLoading(_prNumber: number): void {
    this.cfIsLoading = true;
    this.cfErrorMessage = '';
    this.sendState({ cfIsLoading: true, cfErrorMessage: '' });
  }

  setError(message: string): void {
    this.cfIsLoading = false;
    this.cfErrorMessage = message;
    this.sendState({ cfIsLoading: false, cfErrorMessage: message });
  }

  setOwnedByMeFilter(ownedPaths: Set<string> | null): void {
    this.cfOwnedByMeFilter = ownedPaths;
    this.sendState({ cfOwnedByMePaths: ownedPaths ? [...ownedPaths] : null });
  }

  get isOwnedByMeFilterActive(): boolean {
    return this.cfOwnedByMeFilter !== null;
  }

  /** Called by extension when the ES/Kibana port status changes. */
  updateServerStatus(es: 'running' | 'starting' | 'stopped', kibana: 'running' | 'starting' | 'stopped'): void {
    this.esStatus = es;
    this.kibanaStatus = kibana;
    this.sendState({ esStatus: es, kibanaStatus: kibana });
  }

  /**
   * Updates the Checkout button label during a checkout operation.
   * Pass a stage label while work is in progress, or null to restore.
   */
  setCheckoutButtonStatus(stage: string | null): void {
    this.checkoutBusy = stage !== null;
    this.checkoutStage = stage ?? '';
    this.sendState({ checkoutBusy: this.checkoutBusy, checkoutStage: this.checkoutStage });
  }

  /** Called when the LLM suggestion is ready. */
  setOrderSuggestion(suggestion: ReviewOrderSuggestion): void {
    this.cfSuggestedOrder = suggestion;
    this.cfOrderMode = 'top-down';
    this.cfIsOrderLoading = false;
    this.sendState({
      cfSuggestedOrder: suggestion,
      cfOrderMode: 'top-down',
      cfIsOrderLoading: false,
    });
  }

  /** Shows/hides the loading spinner on the Suggest order button. */
  setOrderLoading(loading: boolean): void {
    this.cfIsOrderLoading = loading;
    this.sendState({ cfIsOrderLoading: loading });
  }

  setActiveFile(filePath: string): void {
    this.cfActiveFile = filePath;
    this.sendState({ cfActiveFile: filePath });
  }

  getCurrentPrNumber(): number | null { return this.cfPrNumber; }
  getCurrentFiles(): OrderedFile[] { return this.cfFiles; }
  getCurrentBaseCommit(): string { return this.cfBaseCommit; }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /** Fetches full PR detail + discussion comments, then sends updated state. */
  private async fetchAndUpdateDetail(prNumber: number): Promise<void> {
    try {
      const [detail, comments] = await Promise.all([
        this.githubService.getPullRequestDetail(prNumber),
        this.githubService.getDiscussionComments(prNumber).catch(() => [] as GhDiscussionComment[]),
      ]);
      if (this.currentPr?.number === prNumber) {
        this.currentPr = detail;
        this.discussionComments = comments;
        this.sendState({ currentPr: detail, discussionComments: comments });
      }
    } catch (err) {
      log(`fetchAndUpdateDetail #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handlePostComment(prNumber: number, body: string): Promise<void> {
    try {
      await this.githubService.postComment(prNumber, body);
      void this.view?.webview.postMessage({ type: 'commentPosted' });
      void vscode.window.showInformationMessage(`Comment posted on PR #${prNumber}.`);
      void this.fetchAndUpdateDetail(prNumber);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Failed to post comment: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async handleSubmitReview(
    prNumber: number,
    event: 'APPROVE' | 'REQUEST_CHANGES',
    body?: string
  ): Promise<void> {
    const label = event === 'APPROVE' ? 'Approval' : 'Changes requested';
    try {
      await this.githubService.submitReview(prNumber, event, body);
      void this.view?.webview.postMessage({ type: 'reviewSubmitted', event });
      void vscode.window.showInformationMessage(`${label} submitted on PR #${prNumber}.`);
      void this.fetchAndUpdateDetail(prNumber);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Failed to submit review: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Builds the complete app state to send to the webview. */
  private getFullState(): Record<string, unknown> {
    return {
      allPrs: this.allPrs,
      isLoading: this.isLoading,
      errorMessage: this.errorMessage,
      needsReviewFilterActive: this.needsReviewFilterActive,
      userTeams: this.userTeams,
      teamFilter: this.teamFilter,
      activeTab: this.activeTab,
      currentPr: this.currentPr ?? null,
      discussionComments: this.discussionComments,
      checkoutBusy: this.checkoutBusy,
      checkoutStage: this.checkoutStage,
      cfFiles: this.cfFiles,
      cfActiveFile: this.cfActiveFile,
      cfReviewedPaths: [...this.cfReviewedPaths],
      cfOwnedByMePaths: this.cfOwnedByMeFilter ? [...this.cfOwnedByMeFilter] : null,
      cfIsLoading: this.cfIsLoading,
      cfErrorMessage: this.cfErrorMessage,
      cfSuggestedOrder: this.cfSuggestedOrder,
      cfOrderMode: this.cfOrderMode,
      cfIsOrderLoading: this.cfIsOrderLoading,
      esStatus: this.esStatus,
      kibanaStatus: this.kibanaStatus,
      checkedOutPrNumber: this._checkedOutPrNumber,
      repo: vscode.workspace.getConfiguration('kibana-pr-reviewer').get<string>('repo', 'elastic/kibana'),
      synthtraceScenarios: this.synthtraceScenarios,
    };
  }

  /** Sends a partial (or full) state update to the webview. */
  private sendState(partial?: Record<string, unknown>): void {
    if (!this.view) return;
    void this.view.webview.postMessage({
      type: 'setState',
      state: partial ?? this.getFullState(),
    });
  }

  // ─── HTML shell ──────────────────────────────────────────────────────────────

  private buildShellHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css')
    );
    const csp = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src ${csp}; style-src ${csp} 'unsafe-inline'; img-src https: data:; media-src https:;">
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Suppress unused warning — getNonce kept for potential future use.
void getNonce;
