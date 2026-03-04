import * as vscode from 'vscode';
import type { GitHubService, GhPullRequest, GhDiscussionComment } from '../services/github_service';
import { isReviewInProgress } from '../services/github_service';
import type { CodeOwnersService } from '../services/codeowners_service';
import type { OrderedFile } from '../services/file_ordering_service';
import type { SuggestedFile, ReviewOrderSuggestion } from '../services/review_order_service';
import { log } from '../logger';

// ─── Message types ────────────────────────────────────────────────────────────

type InboundMessage =
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
  | { type: 'cfSearch'; query: string }
  | { type: 'toggleOwnedByMe' }
  | { type: 'suggestOrder' }
  | { type: 'setOrderMode'; mode: 'default' | 'top-down' | 'bottom-up' }
  | { type: 'startEs' }
  | { type: 'startKibana' }
  | { type: 'openKibana' };

// ─── Provider ─────────────────────────────────────────────────────────────────

export class PrPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'kibana-pr-reviewer.prPanel';

  private view?: vscode.WebviewView;

  // Queue state
  private allPrs: GhPullRequest[] = [];
  private isLoading = false;
  private errorMessage = '';
  private needsReviewFilterActive = false;

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
  private cfSearchQuery = '';
  private cfIsLoading = false;
  private cfErrorMessage = '';

  // ─── Review order state ──────────────────────────────────────────────────────
  private cfSuggestedOrder: ReviewOrderSuggestion | null = null;
  private cfOrderMode: 'default' | 'top-down' | 'bottom-up' = 'default';
  private cfIsOrderLoading = false;

  /** PR number currently checked out on the local git branch, or null if none. */
  checkedOutPrNumber: number | null = null;

  // ─── Dev server status ──────────────────────────────────────────────────────
  private esStatus: 'running' | 'stopped' = 'stopped';
  private kibanaStatus: 'running' | 'stopped' = 'stopped';

  /** Fired when the user clicks Start/Restart Elasticsearch. */
  onStartEs?: () => void;

  /** Fired when the user clicks Start/Restart Kibana. */
  onStartKibana?: () => void;

  /** Fired when the user clicks "Open Kibana". */
  onOpenKibana?: () => void;

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
    private readonly codeOwnersService: CodeOwnersService
  ) {}

  // ─── VS Code lifecycle ───────────────────────────────────────────────────────

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    log('[PrPanelProvider] resolveWebviewView called');
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage(async (msg: InboundMessage) => {
      switch (msg.type) {
        case 'selectPR': {
          const pr = this.allPrs.find((p) => p.number === msg.prNumber);
          if (pr) {
            // Show basic data immediately for instant feedback…
            this.currentPr = pr;
            this.activeTab = 'reviewing';
            this.patchReviewingPane(true);  // patch pane + switch tab client-side (no full re-render)
            this.onSelectPR?.(pr);
            // …then fetch the full detail (team review statuses, etc.) in the
            // background and patch the pane once it arrives.
            void this.fetchAndUpdateDetail(pr.number);
          }
          break;
        }
        case 'switchTab':
          // Only sync state — the client already toggled the tab visually.
          if (msg.tab === 'queue' || msg.tab === 'reviewing') {
            this.activeTab = msg.tab;
          }
          break;
        case 'toggleFilter':
          this.needsReviewFilterActive = !this.needsReviewFilterActive;
          this.render();
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
            // No full re-render — active highlight is toggled client-side.
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
          // No re-render — the client already toggled the class via DOM manipulation.
          break;
        case 'cfSearch':
          this.cfSearchQuery = msg.query;
          // No re-render — filtering is handled client-side to preserve scroll position.
          break;
        case 'toggleOwnedByMe':
          this.onToggleOwnedByMe?.();
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
        case 'suggestOrder':
          this.onSuggestOrder?.();
          break;
        case 'setOrderMode':
          this.cfOrderMode = msg.mode;
          this.patchFilesSection();
          break;
      }
    });

    // Re-sync server status whenever the view becomes visible again.
    // This covers both the "retained-but-hidden" case (retainContextWhenHidden)
    // and any edge case where a status message was dropped while hidden.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.view?.webview.postMessage({
          type: 'serverStatus',
          es: this.esStatus,
          kibana: this.kibanaStatus,
        });
      }
    });

    this.render();
    log('[PrPanelProvider] resolveWebviewView done');
    this.viewReadyResolve?.();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  setPR(pr: GhPullRequest): void {
    this.currentPr = pr;
    this.activeTab = 'reviewing';
    if (this.view) {
      this.render();
      this.view.show(true);
    } else {
      void vscode.commands.executeCommand(`${PrPanelProvider.viewId}.focus`);
    }
  }

  /**
   * Clears changed-files state.
   * Pass `includeDescription: true` to also clear the current PR description and
   * patch the reviewing pane back to the empty placeholder.
   */
  clear(includeDescription = false): void {
    if (includeDescription) {
      this.currentPr = undefined;
    }
    // Do NOT reset activeTab — the user stays on whatever tab they were on.
    this.cfPrNumber = null;
    this.cfBaseCommit = '';
    this.cfFiles = [];
    this.cfActiveFile = null;
    this.cfReviewedPaths.clear();
    this.cfOwnedByMeFilter = null;
    this.cfSearchQuery = '';
    this.cfIsLoading = false;
    this.cfErrorMessage = '';
    this.cfSuggestedOrder = null;
    this.cfOrderMode = 'default';
    this.cfIsOrderLoading = false;
    this.discussionComments = [];
    // Only patch the reviewing pane when the description is also being cleared;
    // otherwise the pane was just updated by selectPR and we'd overwrite it.
    if (includeDescription) {
      this.patchReviewingPane();
    }
  }

  async refresh(): Promise<void> {
    if (this.isLoading) return;

    log('--- PR list refresh started ---');
    this.isLoading = true;
    this.errorMessage = '';
    this.render();

    try {
      const config = vscode.workspace.getConfiguration('kibana-pr-reviewer');
      log(`Config: repo=${config.get('repo')}`);

      const userTeams = await this.codeOwnersService.getUserTeams();
      log(`User teams: ${userTeams.length > 0 ? userTeams.join(', ') : '(none)'}`);

      if (userTeams.length === 0) {
        this.allPrs = [];
        this.errorMessage =
          'No teams detected. Set kibana-pr-reviewer.userTeams in Settings ' +
          '(e.g. ["@elastic/obs-onboarding-team"]).';
        this.isLoading = false;
        this.render();
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
    this.render();
  }

  /** Public entry point to re-fetch and re-render the currently displayed PR detail. */
  refreshDetail(): void {
    if (this.currentPr) void this.fetchAndUpdateDetail(this.currentPr.number);
  }

  // ─── Changed Files public API (mirrors ChangedFilesWebviewProvider) ──────────

  setFiles(prNumber: number, baseCommit: string, files: OrderedFile[]): void {
    this.cfPrNumber = prNumber;
    this.cfBaseCommit = baseCommit;
    this.cfFiles = files;
    this.cfReviewedPaths.clear();
    this.cfActiveFile = null;
    this.cfSearchQuery = '';
    this.cfIsLoading = false;
    this.cfErrorMessage = '';
    this.activeTab = 'reviewing';
    this.render();
    this._onDidSetFiles.fire({ prNumber, baseCommit });
  }

  setLoading(_prNumber: number): void {
    this.cfIsLoading = true;
    this.cfErrorMessage = '';
    this.render();
  }

  setError(message: string): void {
    this.cfIsLoading = false;
    this.cfErrorMessage = message;
    this.render();
  }

  setOwnedByMeFilter(ownedPaths: Set<string> | null): void {
    this.cfOwnedByMeFilter = ownedPaths;
    this.patchFilesSection();
  }

  get isOwnedByMeFilterActive(): boolean {
    return this.cfOwnedByMeFilter !== null;
  }

  /** Called by extension when the ES/Kibana port status changes. Updates the UI without a full re-render. */
  updateServerStatus(es: 'running' | 'stopped', kibana: 'running' | 'stopped'): void {
    this.esStatus = es;
    this.kibanaStatus = kibana;
    this.view?.webview.postMessage({ type: 'serverStatus', es, kibana });
  }

  /**
   * Updates the Checkout button label during a checkout operation.
   * Pass a stage label (e.g. "Fetching branch…") while work is in progress,
   * or null to restore the button to its normal state.
   */
  setCheckoutButtonStatus(stage: string | null): void {
    this.view?.webview.postMessage({ type: 'checkoutStatus', stage });
  }

  /** Called when the LLM suggestion is ready. Patches only the file list section. */
  setOrderSuggestion(suggestion: ReviewOrderSuggestion): void {
    this.cfSuggestedOrder = suggestion;
    this.cfOrderMode = 'top-down'; // auto-switch to first ordering
    this.cfIsOrderLoading = false;
    this.patchFilesSection();
  }

  /** Shows/hides the loading spinner on the Suggest order button. */
  setOrderLoading(loading: boolean): void {
    this.cfIsOrderLoading = loading;
    if (!loading && this.cfSuggestedOrder === null) {
      // Loading cancelled without a result — reset button
      this.cfIsOrderLoading = false;
    }
    this.patchFilesSection();
  }

  /** Replaces only the file-list wrapper innerHTML — scroll position is preserved. */
  private patchFilesSection(): void {
    this.view?.webview.postMessage({
      type: 'patchFilesSection',
      html: this.buildFilesListContent(),
    });
  }

  setActiveFile(filePath: string): void {
    this.cfActiveFile = filePath;
    this.view?.webview.postMessage({ type: 'setActiveFile', path: filePath });
  }

  getCurrentPrNumber(): number | null { return this.cfPrNumber; }
  getCurrentFiles(): OrderedFile[] { return this.cfFiles; }
  getCurrentBaseCommit(): string { return this.cfBaseCommit; }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /** Fetches full PR detail + discussion comments and patches the reviewing pane. */
  private async fetchAndUpdateDetail(prNumber: number): Promise<void> {
    try {
      const [detail, comments] = await Promise.all([
        this.githubService.getPullRequestDetail(prNumber),
        this.githubService.getDiscussionComments(prNumber).catch(() => [] as GhDiscussionComment[]),
      ]);
      // Only update if the user is still looking at this PR
      if (this.currentPr?.number === prNumber) {
        this.currentPr = detail;
        this.discussionComments = comments;
        this.patchReviewingPane();
      }
    } catch (err) {
      log(`fetchAndUpdateDetail #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Posts the current reviewing pane HTML to the webview so it can update
   * just that pane in-place — no full re-render, scroll position preserved.
   * Pass `switchTab: true` to also switch the active tab to "reviewing".
   */
  private patchReviewingPane(switchTab = false): void {
    const nonce = getNonce();
    const html = this.buildReviewingPane(nonce);
    const tabLabel = this.currentPr ? `Reviewing #${this.currentPr.number}` : 'Reviewing';
    this.view?.webview.postMessage({ type: 'patchReviewing', html, switchTab, tabLabel });
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

  private render(): void {
    if (!this.view) return;
    this.view.webview.html = this.buildHtml();
  }

  // ─── HTML ────────────────────────────────────────────────────────────────────

  private buildHtml(): string {
    const nonce = getNonce();
    const visible = this.needsReviewFilterActive
      ? this.allPrs.filter(
          (pr) => pr.reviewDecision === 'REVIEW_REQUIRED' || pr.reviewDecision === ''
        )
      : this.allPrs;

    const sorted = [...visible].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const queueLabel = this.isLoading
      ? 'Review Queue'
      : `Review Queue (${this.allPrs.length})`;
    const reviewingLabel = this.currentPr
      ? `Reviewing #${this.currentPr.number}`
      : 'Reviewing';

    const tabBar = `
      <div class="tab-bar">
        <button class="tab${this.activeTab === 'queue' ? ' active' : ''}"
                data-tab="queue">${escHtml(queueLabel)}</button>
        <button class="tab${this.activeTab === 'reviewing' ? ' active' : ''}"
                data-tab="reviewing">${escHtml(reviewingLabel)}</button>
      </div>`;

    const queuePane = this.buildQueuePane(sorted, nonce);
    const reviewingPane = this.buildReviewingPane(nonce);

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src https: data:; media-src https:;">
<style>
  *, *::before, *::after { box-sizing: border-box; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-editor-foreground);
    background: transparent;
    margin: 0; padding: 0;
    line-height: 1.4;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Tab bar ── */
  .tab-bar {
    display: flex;
    border-bottom: 1px solid var(--vscode-widget-border, #333);
    background: var(--vscode-sideBar-background);
    flex-shrink: 0;
  }
  .tab {
    flex: 1;
    padding: 7px 10px;
    font-size: 11px;
    font-weight: 500;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tab:hover { color: var(--vscode-foreground); }
  .tab.active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder, #007acc);
  }

  /* ── Panes ── */
  .pane { display: none; flex: 1; overflow-y: auto; }
  .pane.active { display: flex; flex-direction: column; }

  /* ── Queue pane ── */
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 10px 4px;
    border-bottom: 1px solid var(--vscode-widget-border, #333);
    position: sticky; top: 0;
    background: var(--vscode-sideBar-background);
    z-index: 1; flex-shrink: 0;
  }
  .count { min-width: 75px; font-size: 11px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .search-input {
    flex: 1; min-width: 0;
    font-size: 11px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px;
    padding: 2px 6px;
    outline: none;
  }
  .search-input:focus {
    border-color: var(--vscode-focusBorder);
  }
  .filter-btn {
    font-size: 11px; cursor: pointer;
    background: none;
    border: 1px solid var(--vscode-widget-border, #555);
    border-radius: 3px; padding: 2px 7px;
    color: var(--vscode-foreground); line-height: 1.6;
    margin-left: 45px;
  }
  .filter-btn:hover { background: var(--vscode-list-hoverBackground); }
  .filter-btn.active {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-color: transparent;
  }

  .status {
    padding: 20px 12px; font-size: 12px;
    color: var(--vscode-descriptionForeground); text-align: center;
  }
  .status.error { color: var(--vscode-errorForeground, #f48771); }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { display: inline-block; animation: spin 1s linear infinite; }

  .pr-list { padding: 4px 0; }

  .pr-card {
    padding: 16px 10px;
    border-bottom: 1px solid var(--vscode-actionBar-toggledBackground, #2a2a2a);
    cursor: pointer;
  }
  .pr-card:hover { background: var(--vscode-list-hoverBackground); }
  .pr-card.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .pr-card.selected .pr-num,
  .pr-card.selected .author,
  .pr-card.selected .age,
  .pr-card.selected .rd { color: inherit; opacity: 0.85; }

  .pr-top-row {
    display: flex; align-items: center;
    justify-content: space-between; margin-bottom: 4px;
  }
  .meta-badges {
    display: flex; align-items: center; gap: 4px;
    font-size: 11px; flex-shrink: 0; margin-left: 8px;
  }
  .badge {
    font-size: 10px; font-weight: 700; padding: 1px 4px;
    border-radius: 3px; text-transform: uppercase; letter-spacing: 0.03em;
  }
  .size-xs, .size-s { background: #1a3a1a; color: #3fb950; }
  .size-m           { background: #3a2e00; color: #d29922; }
  .size-l, .size-xl { background: #3a1010; color: #f85149; }
  .plus  { color: #3fb950; font-size: 11px; }
  .minus { color: #f85149; font-size: 11px; }
  .age   { color: var(--vscode-descriptionForeground); font-size: 11px; }

  .pr-title {
    font-size: 15px; font-weight: 600;
    line-height: 1.45; word-break: break-word; margin-bottom: 8px;
  }
  .pr-num { text-decoration: none; font-weight: 600; color: var(--vscode-textLink-foreground); }

  .pr-bottom-row {
    display: flex; flex-wrap: wrap; gap: 6px;
    font-size: 11px; color: var(--vscode-descriptionForeground); align-items: center;
  }
  .author { font-style: italic; }
  .teams  { color: var(--vscode-textLink-foreground); font-size: 10px; }
  .rd { font-weight: 500; }
  .rd-approved          { color: #3fb950; }
  .rd-changes_requested { color: #f85149; }
  .rd-review_required   { color: #d29922; }
  .rd-none              { color: var(--vscode-descriptionForeground); }
  .in-progress-badge {
    font-size: 10px; font-weight: 600;
    color: #d29922; white-space: nowrap;
  }

  /* ── Reviewing pane ── */
  .section {
    padding: 0 14px;
    margin-bottom: 18px;
    border-bottom: 1px solid var(--vscode-actionBar-toggledBackground, #2a2a2a);
  }

  .reviewing-empty {
    padding: 32px 16px; text-align: center;
    color: var(--vscode-descriptionForeground); font-size: 12px;
  }
  .reviewing-content { padding: 12px 0; }

  .pr-header {
    display: flex; align-items: flex-start;
    justify-content: space-between; gap: 8px;
    margin-bottom: 8px; flex-wrap: wrap;
  }
  .pr-meta {
    display: flex; align-items: center;
    gap: 6px; flex-wrap: wrap; flex: 1;
  }
  .pr-number { font-weight: 600; color: var(--vscode-textLink-foreground); }
  .meta-item { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .action-rows {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin: 10px 0 0 0;
    padding: 0 0 10px 0;
  }
  .checkout-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 6px 0 0 0;
  }
  .checkout-btn {
    font-size: 14px;
    flex-shrink: 0;
    flex-grow: 1;
    cursor: pointer;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 3px;
    padding: 4px 12px;
    white-space: nowrap;
    font-weight: 400;
    height: 26px;
  }
  .checkout-btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .checkout-btn:active:not(:disabled) { opacity: 0.8; }
  .checkout-btn:disabled {
    opacity: 0.5; cursor: default;
    background: var(--vscode-button-background);
  }
  .checkout-btn.busy {
    opacity: 0.85; cursor: wait;
    background: var(--vscode-button-background);
  }
  .checkout-btn.busy .checkout-spin {
    display: inline-block;
    animation: spin 1s linear infinite;
    margin-right: 4px;
  }
  .refresh-btn {
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-button-border);
    border-radius: 3px;
    padding: 0px 7px;
    opacity: 1;
    height: 26px;
  }
  .refresh-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .start-reviewing-btn {
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 3px;
    padding: 0 10px;
    height: 26px;
    font-size: 12px;
    white-space: nowrap;
  }
  .start-reviewing-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .open-kibana-btn {
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none; border-radius: 3px;
    padding: 0 10px; height: 26px; font-size: 12px;
    white-space: nowrap;
  }
  .open-kibana-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .open-kibana-btn:disabled { opacity: 0.35; cursor: default; }
  .dev-env-row {
    display: flex; gap: 12px;
  }
  .server-btn {
    display: flex; align-items: center; gap: 5px;
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none; border-radius: 3px;
    padding: 0 10px; height: 26px; font-size: 12px;
    flex: 1;
  }
  .server-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .server-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    display: inline-block;
  }
  .server-dot.running { background: #4caf50; box-shadow: 0 0 4px #4caf5088; }
  .server-dot.stopped { background: #666; }
  .server-label { font-weight: 500; }
  .server-action {
    margin-left: auto;
    font-size: 11px;
    opacity: 0.7;
    padding: 1px 5px;
    background: var(--vscode-badge-background);
    border-radius: 3px;
  }

  .pr-desc-title {
    font-size: 20px;
    font-weight: 600;
    margin: 0 0 10px;
    line-height: 1.4;
  }

  .pr-info {
    display: flex;
    flex-direction: column; 
    gap: 3px;
    font-size: 11px;
  }
  .info-row { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .label { 
  text-transform: uppercase;
  font-size: 10px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  min-width: 46px;
  flex-shrink: 0;
  }

  code {
    font-family: var(--vscode-editor-font-family); font-size: 11px;
    background: var(--vscode-textBlockQuote-background);
    border-radius: 3px; padding: 0 3px;
  }
  .tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .tag {
    font-size: 10px; padding: 1px 5px; border-radius: 3px;
    background: var(--cursor-shadow-primary);
    color: var(--vscode-foreground);
    display: inline-flex; align-items: center; gap: 3px;
    position: relative;
  }
  .tag-status { font-size: 10px; flex-shrink: 0; }
  .tag-status.approved          { color: #3fb950; }
  .tag-status.changes_requested { color: #f85149; }
  .tag-status.in-progress       { color: #d29922; }
  .tag-status.pending           { color: var(--vscode-descriptionForeground); }

  /* Hover tooltip */
  .tag[data-tip]:hover::after {
    content: attr(data-tip);
    position: absolute;
    bottom: calc(100% + 5px);
    left: 50%; transform: translateX(-50%);
    background: var(--vscode-editorHoverWidget-background, #252526);
    border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
    color: var(--vscode-editorHoverWidget-foreground, #cccccc);
    padding: 5px 8px; border-radius: 4px;
    font-size: 11px; white-space: nowrap;
    z-index: 100; pointer-events: none;
    box-shadow: 0 2px 8px rgba(0,0,0,0.5);
  }
  /* Teams two-column table */
  .teams-table {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 6px 12px;
    margin: 4px 0;
  }
  .teams-col-header {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 4px;
  }
  .teams-none {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .review-decision { font-weight: 500; }
  .review-approved          { color: #3fb950; }
  .review-changes_requested { color: #f85149; }
  .review-review_required   { color: #d29922; }
  .review-none { color: var(--vscode-descriptionForeground); }

  hr { border: none; border-top: 1px solid var(--vscode-widget-border, #444); margin: 10px 0; }

  /* ── PR body markdown ── */
  .pr-body {
    font-size: 13px;
    line-height: 1.6;
    padding-bottom: 18px;
  }
  .pr-body h1 { font-size: 22px; margin: 18px 0 8px; }
  .pr-body h2 { font-size: 20px; margin: 16px 0 8px; }
  .pr-body h3 { font-size: 18px; margin: 14px 0 8px; }
  .pr-body h4 { font-size: 16px; margin: 12px 0 8px; }
  .pr-body h5 { font-size: 14px; margin: 10px 0 8px; }
  .pr-body p  { margin: 4px 0 8px; }
  .pr-body ul, .pr-body ol { margin: 4px 0 16px; padding-left: 20px; }
  .pr-body li { margin: 2px 0; }
  .pr-body pre {
    background: var(--vscode-textBlockQuote-background);
    border-radius: 4px; padding: 8px 10px;
    overflow-x: auto; font-size: 11px; margin: 6px 0;
  }
  .pr-body blockquote {
    border-left: 3px solid var(--vscode-textBlockQuote-border, #555);
    margin: 4px 0; padding: 2px 10px;
    color: var(--vscode-descriptionForeground);
  }
  .pr-body a { color: var(--vscode-textLink-foreground); }
  .pr-body video, .pr-body img {
    max-width: 100%; height: auto;
    border-radius: 4px; display: block; margin: 16px 0;
  }
  .pr-body .media-wrap { margin: 8px 0; }

  /* ── Comment box ── */
  .comment-box {
    padding: 0 0 14px;
  }
  .comment-textarea {
    width: 100%;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 3px; padding: 6px 8px;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    line-height: 1.4; resize: vertical; outline: none;
  }
  .comment-textarea:focus { border-color: var(--vscode-focusBorder); }
  .comment-actions {
    display: flex; align-items: center; justify-content: flex-end;
    gap: 8px; margin-top: 6px;
  }
  .comment-status { font-size: 11px; color: #3fb950; flex: 1; }
  .comment-submit-btn {
    font-size: 11px; cursor: pointer;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 3px; padding: 4px 14px;
  }
  .comment-submit-btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .comment-submit-btn:disabled { opacity: 0.45; cursor: default; }
  /* ── Discussion thread ── */
  .discussion-thread { display: flex; flex-direction: column; gap: 1px; margin-bottom: 8px; }
  .disc-comment {
    padding: 8px 10px;
    border-left: 2px solid var(--vscode-widget-border, #333);
    margin: 0 0 6px 0;
  }
  .disc-header {
    display: flex; align-items: center; gap: 6px;
    margin-bottom: 5px; flex-wrap: wrap;
  }
  .disc-avatar {
    width: 20px; height: 20px; border-radius: 50%;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    font-size: 9px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; overflow: hidden;
  }
  .disc-avatar img {
    width: 20px; height: 20px; border-radius: 50%; display: block;
  }
  .disc-author { font-weight: 600; font-size: 12px; }
  .disc-age { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .disc-review-badge {
    font-size: 10px; font-weight: 600; padding: 1px 6px;
    border-radius: 10px; margin-left: auto;
  }
  .disc-approved          { background: #1a3a1a; color: #3fb950; }
  .disc-changes_requested { background: #3a1010; color: #f85149; }
  .disc-body {
    font-size: 12px; line-height: 1.5;
    color: var(--vscode-editor-foreground);
  }
  .disc-body p { margin: 0 0 4px 0; }
  .disc-body ul, .disc-body ol { margin: 2px 0 4px 16px; padding: 0; }
  .disc-body code {
    font-family: var(--vscode-editor-font-family); font-size: 11px;
    background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px;
  }
  .comment-approve-btn {
    font-size: 11px; cursor: pointer;
    background: #238636; color: #fff;
    border: none; border-radius: 3px; padding: 4px 14px;
  }
  .comment-approve-btn:hover:not(:disabled) { background: #2ea043; }
  .comment-approve-btn:disabled { opacity: 0.45; cursor: default; }
  .comment-request-changes-btn {
    font-size: 11px; cursor: pointer;
    background: #6e1c1c; color: #fff;
    border: none; border-radius: 3px; padding: 4px 14px;
  }
  .comment-request-changes-btn:hover:not(:disabled) { background: #a12727; }
  .comment-request-changes-btn:disabled { opacity: 0.45; cursor: default; }

  /* ── Changed Files section (inside Reviewing pane) ─────────────────────── */
  .section-header {
    display: flex; align-items: center;
    padding: 0 0 6px;
    flex-shrink: 0;
  }
  .section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .cf-toolbar {
    margin-bottom: 8px;
  }
  .cf-toolbar-row {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px 0 4px;
  }
  .cf-search {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px; padding: 2px 6px;
    outline: none;
    height: 24px;
  }
  .cf-search:focus { border-color: var(--vscode-focusBorder); }
  .cf-filter-btn {
    font-size: 11px; cursor: pointer; flex-shrink: 0;
    background: none;
    border: 1px solid var(--vscode-widget-border, #555);
    border-radius: 3px; padding: 2px 6px;
    color: var(--vscode-foreground); line-height: 1.6;
    height: 24px;
  }
  .cf-filter-btn.active {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-color: transparent;
  }
  /* ── Review order controls ── */
  .suggest-order-btn {
    font-size: 11px;
    cursor: pointer;
    flex-shrink: 0;
    background: none;
    border: 1px solid var(--vscode-widget-border, #555);
    border-radius: 3px; padding: 2px 7px;
    color: var(--vscode-foreground); line-height: 1.6;
    white-space: nowrap;
    height: 24px;
  }
  .suggest-order-btn:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
  .suggest-order-btn:disabled { opacity: 0.55; cursor: default; }
  .order-mode-toggle { 
    display:flex;
    border: solid 1px var(--vscode-widget-border, #555);
    border-radius: 3px;
    padding: 2px;
    height: 24px;
  }
  .order-mode-btn {
    font-size: 11px;
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none; border-radius: 3px; padding: 2px 6px;
    white-space: nowrap;
  }
  .order-mode-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .order-mode-btn.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .order-mode-btn:disabled { opacity: 0.55; cursor: default; }
  .ordered-num {
    font-size: 10px; font-weight: 600; min-width: 16px; text-align: right;
    color: var(--vscode-descriptionForeground); flex-shrink: 0;
  }
  .order-reason {
    font-size: 10px; font-style: italic;
    color: var(--vscode-descriptionForeground);
    padding: 1px 8px 4px 38px;
    line-height: 1.3;
  }

  .cf-file-list { overflow-y: visible; background: var(--vscode-textCodeBlock-background); padding: 8px 4px; }
  #cf-file-list-wrapper { padding-bottom: 18px; }

  /* Folder tree */
  .folder > summary { list-style: none; }
  .folder > summary::-webkit-details-marker { display: none; }
  .folder-row {
    display: flex; align-items: center; gap: 5px;
    padding: 2px 8px;
    cursor: pointer; user-select: none;
    color: var(--vscode-foreground);
  }
  .folder-row:hover { background: var(--vscode-list-hoverBackground); }
  .folder-contents { padding-left: 16px; }
  .fold-arrow {
    font-size: 13px; flex-shrink: 0; display: inline-block; line-height: 1;
    color: var(--vscode-descriptionForeground);
    transition: transform 0.12s; transform: rotate(0deg);
  }
  details[open] > summary .fold-arrow { transform: rotate(90deg); }
  .fold-name {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
  }

  .file-row {
    display: flex; align-items: center; gap: 6px;
    padding: 2px 8px 2px 4px; cursor: pointer;
    border-left: 2px solid transparent;
  }
  .file-row:hover { background: var(--vscode-list-hoverBackground); }
  .file-row.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
    border-left-color: var(--vscode-focusBorder, #007fd4);
  }
  .file-row.reviewed .file-name { opacity: 0.45; text-decoration: line-through; }
  .review-check { flex-shrink: 0; cursor: pointer; accent-color: #3fb950; }
  .status-icon { font-size: 11px; flex-shrink: 0; font-weight: 600; }
  .status-added    { color: #3fb950; }
  .status-deleted  { color: #f85149; }
  .status-modified { color: #d29922; }
  .status-renamed  { color: #79c0ff; }
  .cf-file-name {
    flex: 1; min-width: 0; font-size: 11px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .cf-stats { font-size: 10px; flex-shrink: 0; display: flex; gap: 3px; }
  .cf-adds { color: #3fb950; }
  .cf-dels { color: #f85149; }

  .cf-status {
    padding: 20px 12px; font-size: 12px; text-align: center;
    color: var(--vscode-descriptionForeground);
  }
  .cf-status.error { color: var(--vscode-errorForeground, #f48771); }
  .cf-spin { display: inline-block; animation: spin 1s linear infinite; }
</style>
</head>
<body>
${tabBar}
<div class="pane${this.activeTab === 'queue' ? ' active' : ''}" id="pane-queue">
${queuePane}
</div>
<div class="pane${this.activeTab === 'reviewing' ? ' active' : ''}" id="pane-reviewing">
${reviewingPane}
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  // Tab switching — immediate client-side, then sync state to extension.
  function activateTab(tabName) {
    document.querySelectorAll('.tab[data-tab]').forEach(function (t) {
      t.classList.toggle('active', t.dataset.tab === tabName);
    });
    document.querySelectorAll('.pane[id]').forEach(function (p) {
      p.classList.toggle('active', p.id === 'pane-' + tabName);
    });
  }

  document.addEventListener('click', function (e) {
    // Tab switching
    const tab = e.target.closest('.tab[data-tab]');
    if (tab) {
      activateTab(tab.dataset.tab);
      vscode.postMessage({ type: 'switchTab', tab: tab.dataset.tab });
      return;
    }

    // Filter toggle
    if (e.target.closest('[data-action="toggleFilter"]')) {
      vscode.postMessage({ type: 'toggleFilter' });
      return;
    }

    // Checkout button
    if (e.target.closest('[data-action="checkout"]')) {
      vscode.postMessage({ type: 'checkout' });
      return;
    }

    // Refresh PR button
    if (e.target.closest('[data-action="refreshPR"]')) {
      vscode.postMessage({ type: 'refreshPR' });
      return;
    }

    // Start reviewing — scroll to changed files section
    if (e.target.closest('[data-action="startReviewing"]')) {
      var target = document.getElementById('files-section');
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      return;
    }

    // Dev server buttons
    if (e.target.closest('[data-action="startEs"]')) {
      vscode.postMessage({ type: 'startEs' });
      return;
    }
    if (e.target.closest('[data-action="startKibana"]')) {
      vscode.postMessage({ type: 'startKibana' });
      return;
    }
    if (e.target.closest('[data-action="openKibana"]')) {
      vscode.postMessage({ type: 'openKibana' });
      return;
    }

    if (e.target.closest('[data-action="suggestOrder"]')) {
      vscode.postMessage({ type: 'suggestOrder' });
      return;
    }
    var orderModeBtn = e.target.closest('[data-action="setOrderMode"]');
    if (orderModeBtn) {
      vscode.postMessage({ type: 'setOrderMode', mode: orderModeBtn.dataset.mode });
      return;
    }

    // PR card click — select & switch to reviewing tab
    const card = e.target.closest('.pr-card');
    if (card) {
      document.querySelectorAll('.pr-card').forEach(function (el) {
        el.classList.remove('selected');
      });
      card.classList.add('selected');
      vscode.postMessage({ type: 'selectPR', prNumber: parseInt(card.dataset.number, 10) });
      return;
    }

    // Post comment submit
    const submitBtn = document.getElementById('comment-submit');
    if (e.target === submitBtn && !submitBtn.disabled) {
      const textarea = document.getElementById('comment-input');
      const body = textarea.value.trim();
      submitBtn.disabled = true;
      submitBtn.textContent = 'Posting…';
      document.getElementById('comment-status').textContent = '';
      vscode.postMessage({ type: 'postComment', body });
      return;
    }

    // Approve review
    const approveBtn = document.getElementById('comment-approve');
    if (e.target === approveBtn && !approveBtn.disabled) {
      const textarea = document.getElementById('comment-input');
      const body = textarea ? textarea.value.trim() : '';
      approveBtn.disabled = true;
      approveBtn.textContent = 'Approving…';
      document.getElementById('comment-status').textContent = '';
      vscode.postMessage({ type: 'approveReview', body });
      return;
    }

    // Request changes review
    const requestChangesBtn = document.getElementById('comment-request-changes');
    if (e.target === requestChangesBtn && !requestChangesBtn.disabled) {
      const textarea = document.getElementById('comment-input');
      const body = textarea ? textarea.value.trim() : '';
      requestChangesBtn.disabled = true;
      requestChangesBtn.textContent = 'Requesting…';
      document.getElementById('comment-status').textContent = '';
      vscode.postMessage({ type: 'requestChanges', body });
      return;
    }
  });

  // Live search filter
  const searchInput = document.getElementById('pr-search');
  if (searchInput) {
    searchInput.addEventListener('input', function () {
      const query = searchInput.value.trim().toLowerCase();
      const cards = document.querySelectorAll('.pr-card');
      let visible = 0;
      cards.forEach(function (card) {
        const match = !query || (card.dataset.search || '').includes(query);
        card.style.display = match ? '' : 'none';
        if (match) visible++;
      });
      const countEl = document.getElementById('pr-count');
      if (countEl) {
        const total = cards.length;
        countEl.textContent = query
          ? visible + ' / ' + total + ' PR' + (total === 1 ? '' : 's')
          : total + ' PR' + (total === 1 ? '' : 's');
      }
    });
  }

  // Enable/disable submit button as the user types (delegated — survives patchReviewing).
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'comment-input') {
      const btn = document.getElementById('comment-submit');
      if (btn) btn.disabled = e.target.value.trim().length === 0;
    }
  });

  // ── Changed Files tab ───────────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    // Checkbox: toggle reviewed — update DOM immediately, sync state to extension.
    const cb = e.target.closest('.review-check');
    if (cb) {
      e.stopPropagation();
      var row = cb.closest('.file-row');
      if (row) {
        var nowReviewed = cb.checked; // checkbox state already toggled by the browser
        row.classList.toggle('reviewed', nowReviewed);
      }
      vscode.postMessage({ type: 'toggleReviewed', path: cb.dataset.path });
      return;
    }
    // Owned-by-me toggle
    if (e.target.closest('[data-action="toggleOwnedByMe"]')) {
      vscode.postMessage({ type: 'toggleOwnedByMe' });
      return;
    }
    // File row click → open diff
    var fileRow = e.target.closest('.file-row');
    if (fileRow) {
      setActiveCfRow(fileRow.dataset.path);
      vscode.postMessage({ type: 'openFile', path: fileRow.dataset.path });
      return;
    }
  });

  // Messages from extension.
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg) { return; }
    if (msg.type === 'setActiveFile') {
      setActiveCfRow(msg.path);
    } else if (msg.type === 'serverStatus') {
      updateServerBtn('es-btn', msg.es);
      updateServerBtn('kibana-btn', msg.kibana);
    } else if (msg.type === 'checkoutStatus') {
      var checkoutBtn = document.querySelector('.checkout-btn');
      if (checkoutBtn) {
        if (msg.stage) {
          checkoutBtn.classList.add('busy');
          checkoutBtn.disabled = true;
          checkoutBtn.innerHTML = '<span class="checkout-spin">⟳</span>' + msg.stage;
        } else {
          // Restore: the next patchReviewing will set the final state,
          // but update immediately so there is no flash of stale label.
          checkoutBtn.classList.remove('busy');
          checkoutBtn.disabled = false;
          checkoutBtn.textContent = '↓ Checkout';
        }
      }
    } else if (msg.type === 'commentPosted') {
      var ta = document.getElementById('comment-input');
      var submitBtn = document.getElementById('comment-submit');
      var statusEl = document.getElementById('comment-status');
      if (ta) ta.value = '';
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Post Comment'; }
      if (statusEl) {
        statusEl.textContent = '✓ Posted';
        setTimeout(function () { statusEl.textContent = ''; }, 3000);
      }
    } else if (msg.type === 'reviewSubmitted') {
      var ta2 = document.getElementById('comment-input');
      var approveBtn = document.getElementById('comment-approve');
      var reqChangesBtn = document.getElementById('comment-request-changes');
      var statusEl2 = document.getElementById('comment-status');
      if (ta2) ta2.value = '';
      if (approveBtn) { approveBtn.disabled = false; approveBtn.textContent = 'Approve'; }
      if (reqChangesBtn) { reqChangesBtn.disabled = false; reqChangesBtn.textContent = 'Request Changes'; }
      if (statusEl2) {
        statusEl2.textContent = msg.event === 'APPROVE' ? '✓ Approved' : '✓ Changes requested';
        setTimeout(function () { statusEl2.textContent = ''; }, 3000);
      }
    } else if (msg.type === 'patchFilesSection') {
      var wrapper = document.getElementById('cf-file-list-wrapper');
      if (wrapper) { wrapper.innerHTML = msg.html; }
      // Re-apply any active search filter to the freshly rendered file rows.
      var cfSearchEl = document.getElementById('cf-search');
      if (cfSearchEl && cfSearchEl.value) { applyCfFilter(cfSearchEl.value); }
    } else if (msg.type === 'patchReviewing') {
      // Replace reviewing pane content without a full re-render (preserves scroll).
      var pane = document.getElementById('pane-reviewing');
      if (pane) { pane.innerHTML = msg.html; }
      // Update the reviewing tab label.
      if (msg.tabLabel) {
        var reviewTab = document.querySelector('.tab[data-tab="reviewing"]');
        if (reviewTab) { reviewTab.textContent = msg.tabLabel; }
      }
      // Optionally switch to the reviewing tab.
      if (msg.switchTab) { activateTab('reviewing'); }
      // Re-apply any active search filter to the freshly rendered file list.
      var cfSearch = document.getElementById('cf-search');
      if (cfSearch && cfSearch.value) { applyCfFilter(cfSearch.value); }
    }
  });

  function updateServerBtn(id, status) {
    var btn = document.getElementById(id);
    if (!btn) { return; }
    var dot = btn.querySelector('.server-dot');
    var action = btn.querySelector('.server-action');
    if (dot) {
      dot.className = 'server-dot ' + (status === 'running' ? 'running' : 'stopped');
    }
    if (action) {
      action.textContent = status === 'running' ? 'Restart' : 'Start';
    }
  }

  function setActiveCfRow(path) {
    document.querySelectorAll('.file-row').forEach(function (r) {
      r.classList.toggle('active', r.dataset.path === path);
    });
  }

  // cf-search: use event delegation so it works after patchReviewing replaces innerHTML.
  var cfSearchDebounce;
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'cf-search') {
      applyCfFilter(e.target.value);
      clearTimeout(cfSearchDebounce);
      cfSearchDebounce = setTimeout(function () {
        vscode.postMessage({ type: 'cfSearch', query: e.target.value });
      }, 300);
    }
  });

  function applyCfFilter(query) {
    var q = query.trim().toLowerCase();
    // Show/hide individual file rows.
    document.querySelectorAll('.file-row').forEach(function (row) {
      var path = (row.dataset.path || '').toLowerCase();
      row.style.display = (!q || path.includes(q)) ? '' : 'none';
    });
    // Show/hide folders based on whether they contain any visible file rows.
    document.querySelectorAll('.folder').forEach(function (folder) {
      var hasVisible = Array.from(folder.querySelectorAll('.file-row')).some(function (r) {
        return r.style.display !== 'none';
      });
      folder.style.display = hasVisible ? '' : 'none';
    });
  }
</script>
</body>
</html>`;
  }

  private buildQueuePane(sorted: GhPullRequest[], _nonce: string): string {
    if (this.isLoading) {
      return `<div class="status loading"><span class="spin">⟳</span> Loading PRs…</div>`;
    }
    if (this.errorMessage) {
      return `<div class="status error"><div>✕</div><div>${escHtml(this.errorMessage)}</div></div>`;
    }

    const filterLabel = this.needsReviewFilterActive ? 'Showing: unreviewed only' : 'Showing: all PRs';
    const filterTitle = this.needsReviewFilterActive
      ? 'Click to show all PRs'
      : 'Click to show only PRs that need a review';

    const toolbar = `
      <div class="toolbar">
        <span class="count" id="pr-count">${sorted.length} PR${sorted.length === 1 ? '' : 's'}</span>
        <input id="pr-search" class="search-input" type="text" placeholder="Filter…" autocomplete="off" spellcheck="false" />
        <button class="filter-btn${this.needsReviewFilterActive ? ' active' : ''}"
                title="${filterTitle}"
                data-action="toggleFilter">
          ${this.needsReviewFilterActive ? '⊘ ' : '⊙ '}${filterLabel}
        </button>
      </div>`;

    if (sorted.length === 0) {
      const emptyMsg = this.needsReviewFilterActive
        ? 'No PRs without a review yet'
        : 'No open PRs for your teams';
      return `${toolbar}<div class="status empty">${emptyMsg}</div>`;
    }

    const cards = sorted.map((pr) => prCard(pr, pr.number === this.currentPr?.number)).join('\n');
    return `${toolbar}<div class="pr-list">${cards}</div>`;
  }

  private buildFilesSection(): string {
    const filesTotal = this.cfFiles.length;
    const sectionHeader = `
      <div id="files-section" class="section-header">
        <span class="section-title">Changed Files${filesTotal > 0 ? ` (${filesTotal})` : ''}</span>
      </div>`;

    return `${sectionHeader}<div id="cf-file-list-wrapper">${this.buildFilesListContent()}</div>`;
  }

  /** Builds the variable inner content of the file list (toolbar + list). Patched in-place by patchFilesSection(). */
  private buildFilesListContent(): string {
    if (this.cfIsLoading) {
      return `<div class="cf-status"><span class="cf-spin">⟳</span> Loading…</div>`;
    }
    if (this.cfErrorMessage) {
      return `<div class="cf-status error">✕ ${escHtml(this.cfErrorMessage)}</div>`;
    }
    if (this.cfFiles.length === 0) {
      return `<div class="cf-status">Checkout this PR to see changed files.</div>`;
    }

    const visible = this.cfOwnedByMeFilter
      ? this.cfFiles.filter((f) => this.cfOwnedByMeFilter!.has(f.path))
      : this.cfFiles;

    const hasSuggestion = this.cfSuggestedOrder !== null;
    const isOrderLoading = this.cfIsOrderLoading;

    const modeToggle = `
      <div class="order-mode-toggle">
        <button class="order-mode-btn${this.cfOrderMode === 'default' ? ' active' : ''}" data-action="setOrderMode" data-mode="default">Default</button>
        <button class="order-mode-btn${this.cfOrderMode === 'top-down' ? ' active' : ''}" data-action="setOrderMode" disabled=${hasSuggestion ? 'disabled' : ''} data-mode="top-down">↓ Top-down</button>
        <button class="order-mode-btn${this.cfOrderMode === 'bottom-up' ? ' active' : ''}" data-action="setOrderMode" disabled=${hasSuggestion ? 'disabled' : ''} data-mode="bottom-up">↑ Bottom-up</button>
      </div>`;

    const suggestBtn = `<button class="suggest-order-btn${isOrderLoading ? ' loading' : ''}"
        data-action="suggestOrder" ${isOrderLoading ? 'disabled' : ''}
        title="Ask an LLM to suggest the best review order for these files">
      ${isOrderLoading ? '<span class="cf-spin">⟳</span> Analyzing…' : '✦ Suggest review order'}
    </button>`;

    const toolbar = `
    <div class="cf-toolbar">
      <div class="cf-toolbar-row">
        <input id="cf-search" class="cf-search" type="text" placeholder="Filter files…"
               value="${escHtml(this.cfSearchQuery)}" autocomplete="off" spellcheck="false" />
        <button class="cf-filter-btn${this.cfOwnedByMeFilter ? ' active' : ''}"
                data-action="toggleOwnedByMe"
                title="${this.cfOwnedByMeFilter ? 'Show all files' : 'Show only files I own'}">
          👤 Owned by me
        </button>
      </div>
      <div class="cf-toolbar-row">
        ${suggestBtn}
        ${modeToggle}
      </div>
    </div>`;

    let fileListHtml: string;
    if (this.cfOrderMode !== 'default' && this.cfSuggestedOrder) {
      const ordered = this.cfOrderMode === 'top-down'
        ? this.cfSuggestedOrder.topDown
        : this.cfSuggestedOrder.bottomUp;
      fileListHtml = this.buildOrderedFileList(ordered, visible);
    } else {
      const tree = cfCompactFolders(cfBuildTree(visible));
      fileListHtml = cfRenderTree(tree.children, this);
    }

    return `${toolbar}<div class="cf-file-list">${fileListHtml}</div>`;
  }

  private buildOrderedFileList(ordered: SuggestedFile[], visible: OrderedFile[]): string {
    const visibleMap = new Map(visible.map((f) => [f.path, f]));
    const query = this.cfSearchQuery.toLowerCase();
    return ordered
      .filter((sf) => visibleMap.has(sf.path))
      .filter((sf) => !query || sf.path.toLowerCase().includes(query))
      .map((sf, i) => {
        const file = visibleMap.get(sf.path)!;
        return this.cfOrderedFileRow(file, sf.reason, i + 1);
      })
      .join('');
  }

  private cfOrderedFileRow(file: OrderedFile, reason: string, num: number): string {
    const isActive = file.path === this.cfActiveFile;
    const isReviewed = this.cfReviewedPaths.has(file.path);
    const normalizedStatus = (
      (file as { changeType?: string }).changeType?.toLowerCase() ?? file.status ?? 'modified'
    ) as string;
    const { icon, colorClass } = cfStatusIcon(normalizedStatus);
    const plus = file.additions > 0 ? `<span class="cf-adds">+${file.additions}</span>` : '';
    const minus = file.deletions > 0 ? `<span class="cf-dels">-${file.deletions}</span>` : '';
    return `
      <div class="file-row${isActive ? ' active' : ''}${isReviewed ? ' reviewed' : ''}" data-path="${escHtml(file.path)}">
        <input type="checkbox" class="review-check" title="Mark as reviewed"
               data-path="${escHtml(file.path)}" ${isReviewed ? 'checked' : ''} />
        <span class="ordered-num">${num}</span>
        <span class="status-icon ${colorClass}" title="${escHtml(normalizedStatus)}">${icon}</span>
        <span class="cf-file-name" data-path="${escHtml(file.path)}">${escHtml(file.path)}</span>
        <span class="cf-stats">${plus}${minus}</span>
      </div>
      ${reason ? `<div class="order-reason">${escHtml(reason)}</div>` : ''}`;
  }

  private buildCommentSection(): string {
    const commentThread = this.discussionComments.length > 0
      ? `<div class="discussion-thread">${this.discussionComments.map((c) => this.buildDiscussionComment(c)).join('')}</div>`
      : '';

    return `
      <div class="section-header">
        <span class="section-title">Discussion${this.discussionComments.length > 0 ? ` (${this.discussionComments.length})` : ''}</span>
      </div>
      ${commentThread}
      <div class="comment-box">
        <textarea id="comment-input" class="comment-textarea" placeholder="Write a comment on this PR… (optional for Approve / Request Changes)" rows="4"></textarea>
        <div class="comment-actions">
          <span id="comment-status" class="comment-status"></span>
          <button id="comment-request-changes" class="comment-request-changes-btn">Request Changes</button>
          <button id="comment-approve" class="comment-approve-btn">Approve</button>
          <button id="comment-submit" class="comment-submit-btn" disabled>Post Comment</button>
        </div>
      </div>`;
  }

  private buildDiscussionComment(c: GhDiscussionComment): string {
    const reviewBadge = c.kind === 'review' && c.reviewState && c.reviewState !== 'COMMENTED'
      ? `<span class="disc-review-badge disc-${c.reviewState.toLowerCase()}">${
          c.reviewState === 'APPROVED' ? '✓ Approved' : '✗ Changes requested'
        }</span>`
      : '';
    const avatarContent = c.avatarUrl
      ? `<img src="${escHtml(c.avatarUrl)}" alt="${escHtml(c.author)}" />`
      : escHtml(c.author.slice(0, 2).toUpperCase());
    return `
      <div class="disc-comment">
        <div class="disc-header">
          <span class="disc-avatar">${avatarContent}</span>
          <span class="disc-author">${escHtml(c.author)}</span>
          <span class="disc-age">${ageLabel(c.createdAt)}</span>
          ${reviewBadge}
        </div>
        <div class="disc-body">${renderMarkdown(c.body)}</div>
      </div>`;
  }

  cfFileRow(file: OrderedFile): string {
    const isActive = file.path === this.cfActiveFile;
    const isReviewed = this.cfReviewedPaths.has(file.path);
    const normalizedStatus = ((file as { changeType?: string }).changeType?.toLowerCase() ?? file.status ?? 'modified') as string;
    const { icon, colorClass } = cfStatusIcon(normalizedStatus);
    const plus = file.additions > 0 ? `<span class="cf-adds">+${file.additions}</span>` : '';
    const minus = file.deletions > 0 ? `<span class="cf-dels">-${file.deletions}</span>` : '';
    const fileName = file.path.split('/').pop() ?? file.path;
    return `
      <div class="file-row${isActive ? ' active' : ''}${isReviewed ? ' reviewed' : ''}"
           data-path="${escHtml(file.path)}">
        <input type="checkbox" class="review-check" title="Mark as reviewed"
               data-path="${escHtml(file.path)}" ${isReviewed ? 'checked' : ''} />
        <span class="status-icon ${colorClass}" title="${escHtml(normalizedStatus)}">${icon}</span>
        <span class="cf-file-name" data-path="${escHtml(file.path)}">${escHtml(fileName)}</span>
        <span class="cf-stats">${plus}${minus}</span>
      </div>`;
  }

  private buildReviewingPane(_nonce: string): string {
    if (!this.currentPr) {
      return `<div class="reviewing-empty">
        <p>Click a PR in the Review Queue to see its description here.</p>
      </div>`;
    }

    const pr = this.currentPr;
    // teamReviewStatuses keys contain ALL teams ever requested (including those
    // that have already reviewed and were removed from reviewRequests).
    // Fall back to reviewRequests when statuses aren't available.
    const buildTag = (fullSlug: string, indicator: string, tip: string, reviewer?: string): string => {
      const bareSlug = fullSlug.includes('/') ? fullSlug.split('/').pop()! : fullSlug;
      const tipAttr = tip ? ` data-tip="${escHtml(tip)}"` : '';
      const label = reviewer
        ? `${escHtml(reviewer)} for ${escHtml(bareSlug)}`
        : `@${escHtml(bareSlug)}`;
      return `<span class="tag"${tipAttr}>${indicator}${label}</span>`;
    };

    let pendingTags: string[] = [];
    let inProgressTags: string[] = [];
    let reviewedTags: string[] = [];

    if (pr.teamReviewStatuses) {
      const sorted = Object.entries(pr.teamReviewStatuses).sort(([a], [b]) => a.localeCompare(b));
      for (const [slug, info] of sorted) {
        if (info.status === 'APPROVED') {
          const tip = info.reviewer
            ? `Approved · ${ageLabel(info.reviewer.submittedAt)}`
            : '';
          reviewedTags.push(buildTag(slug, '<span class="tag-status approved">✓</span>', tip, info.reviewer?.login));
        } else if (info.status === 'CHANGES_REQUESTED') {
          const tip = info.reviewer
            ? `Changes requested · ${ageLabel(info.reviewer.submittedAt)}`
            : '';
          reviewedTags.push(buildTag(slug, '<span class="tag-status changes_requested">✗</span>', tip, info.reviewer?.login));
        } else if (info.status === 'IN_PROGRESS') {
          const tip = info.reviewer
            ? `Reviewing since ${ageLabel(info.reviewer.submittedAt)}`
            : '';
          inProgressTags.push(buildTag(slug, '<span class="tag-status in-progress">⚡</span>', tip, info.reviewer?.login));
        } else {
          pendingTags.push(buildTag(slug, '<span class="tag-status pending">●</span>', ''));
        }
      }
    } else {
      pendingTags = pr.reviewRequests
        .filter((r) => r.slug)
        .map((r) => buildTag(r.slug!, '<span class="tag-status pending">●</span>', ''));
    }

    // Surface individual (non-team) reviewers with COMMENTED state who aren't already
    // shown via a team IN_PROGRESS entry. This covers reviewers requested directly
    // rather than through a team.
    const teamInProgressLogins = new Set(
      Object.values(pr.teamReviewStatuses ?? {})
        .filter((s) => s.status === 'IN_PROGRESS')
        .map((s) => s.reviewer?.login)
        .filter(Boolean)
    );
    const authorLogin = pr.author.login;
    const directReviewers = (pr.latestReviews ?? []).filter(
      (r) => r.state === 'COMMENTED' && r.author.login !== authorLogin && !teamInProgressLogins.has(r.author.login)
    );
    for (const r of directReviewers) {
      const tip = `Reviewing since ${ageLabel(r.submittedAt)}`;
      inProgressTags.push(
        `<span class="tag" data-tip="${escHtml(tip)}"><span class="tag-status in-progress">⚡</span>${escHtml(r.author.login)}</span>`
      );
    }

    const anyTags = pendingTags.length > 0 || inProgressTags.length > 0 || reviewedTags.length > 0;
    const teamsTable = anyTags
      ? `<div class="teams-table">
          <div class="teams-col">
            <div class="teams-col-header">Awaiting review</div>
            <div class="tags">${pendingTags.length > 0 ? pendingTags.join(' ') : '<span class="teams-none">—</span>'}</div>
          </div>
          <div class="teams-col">
            <div class="teams-col-header">Reviewing</div>
            <div class="tags">${inProgressTags.length > 0 ? inProgressTags.join(' ') : '<span class="teams-none">—</span>'}</div>
          </div>
          <div class="teams-col">
            <div class="teams-col-header">Approved</div>
            <div class="tags">${reviewedTags.length > 0 ? reviewedTags.join(' ') : '<span class="teams-none">—</span>'}</div>
          </div>
        </div>`
      : '';
    const body = renderMarkdown(pr.body ?? '');

    return `<div class="reviewing-content">
      <div class="section">
        <h2 class="pr-desc-title">
          <a href="${pr.url}" target="_blank" class="pr-num">#${pr.number}</a> ${escHtml(pr.title)}
        </h2>

        <div class="pr-info">
          <div class="info-row">
            <span class="teams-col-header">Author</span>
            <span>${escHtml(pr.author.login)}</span>
          </div>
          <div class="info-row">
            <span class="teams-col-header">Branch</span>
            <code>${escHtml(pr.headRefName)}</code> 
            <!-- → <code>${escHtml(pr.baseRefName)}</code> -->
          </div>
          ${teamsTable}
          <div class="action-rows">
            <div class="checkout-row">
              <button class="checkout-btn" data-action="checkout"${pr.number === this.checkedOutPrNumber ? ' disabled' : ''}>
                ${pr.number === this.checkedOutPrNumber ? '✓ Checked out' : '↓ Checkout'}
              </button>
              <button class="refresh-btn" data-action="refreshPR" title="Refresh PR data">&#8635;</button>
            </div>
            <div class="dev-env-row">
              <button id="es-btn" class="server-btn" data-action="startEs">
                <span class="server-dot ${this.esStatus === 'running' ? 'running' : 'stopped'}"></span>
                <span class="server-label">Elasticsearch</span>
                <span class="server-action">${this.esStatus === 'running' ? 'Restart' : 'Start'}</span>
              </button>
              <button id="kibana-btn" class="server-btn" data-action="startKibana">
                <span class="server-dot ${this.kibanaStatus === 'running' ? 'running' : 'stopped'}"></span>
                <span class="server-label">Kibana</span>
                <span class="server-action">${this.kibanaStatus === 'running' ? 'Restart' : 'Start'}</span>
              </button>
              <button class="open-kibana-btn" data-action="openKibana" title="Open Kibana in the IDE" disabled=${this.kibanaStatus !== 'running'}>⎋ Open Kibana</button>
            </div>
          </div>
        </div>
      </div>
      <div class="section">
        <div class="pr-body">${body}</div>
      </div>
      <div class="section">
        ${this.buildFilesSection()}
      </div>
      <div class="section">
        ${this.buildCommentSection()}
      </div>
    </div>`;
  }
}

// ─── Changed Files: tree helpers ─────────────────────────────────────────────

interface CfFolderNode { type: 'folder'; name: string; children: CfTreeChild[]; }
interface CfFileLeaf   { type: 'file';   file: OrderedFile; }
type CfTreeChild = CfFolderNode | CfFileLeaf;

function cfBuildTree(files: OrderedFile[]): CfFolderNode {
  const root: CfFolderNode = { type: 'folder', name: '', children: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let folder = cur.children.find(
        (c): c is CfFolderNode => c.type === 'folder' && c.name === parts[i]
      );
      if (!folder) {
        folder = { type: 'folder', name: parts[i], children: [] };
        cur.children.push(folder);
      }
      cur = folder;
    }
    cur.children.push({ type: 'file', file });
  }
  return root;
}

function cfCompactFolders(node: CfFolderNode): CfFolderNode {
  const compacted: CfTreeChild[] = node.children.map((child) => {
    if (child.type !== 'folder') return child;
    let current = cfCompactFolders(child);
    while (current.children.length === 1 && current.children[0].type === 'folder') {
      const only = current.children[0] as CfFolderNode;
      current = cfCompactFolders({ type: 'folder', name: current.name + '/' + only.name, children: only.children });
    }
    return current;
  });
  return { ...node, children: compacted };
}

function cfRenderTree(children: CfTreeChild[], provider: PrPanelProvider): string {
  return children.map((child) => {
    if (child.type === 'file') return provider.cfFileRow(child.file);
    const inner = cfRenderTree(child.children, provider);
    return `
      <details class="folder" open>
        <summary class="folder-row">
          <span class="fold-arrow">▶</span>
          <span class="fold-name">${escHtml(child.name)}</span>
        </summary>
        <div class="folder-contents">${inner}</div>
      </details>`;
  }).join('\n');
}

function cfStatusIcon(status: string): { icon: string; colorClass: string } {
  switch (status) {
    case 'added':   return { icon: '+', colorClass: 'status-added' };
    case 'deleted': return { icon: '−', colorClass: 'status-deleted' };
    case 'renamed': return { icon: '→', colorClass: 'status-renamed' };
    default:        return { icon: '●', colorClass: 'status-modified' };
  }
}

// ─── Card builder ─────────────────────────────────────────────────────────────

function prCard(pr: GhPullRequest, selected: boolean): string {
  const age = ageLabel(pr.createdAt);
  const rdClass = `rd-${(pr.reviewDecision || 'none').toLowerCase()}`;
  const rdLabel = reviewDecisionLabel(pr.reviewDecision);
  const inProgress = isReviewInProgress(pr);

  const searchText = `#${pr.number} ${pr.title} ${pr.author.login}`.toLowerCase();
  return `
<div class="pr-card${selected ? ' selected' : ''}" data-number="${pr.number}" data-search="${escHtml(searchText)}">
  <div class="pr-title">
    <span class="pr-num">#${pr.number}</span> ${escHtml(pr.title)}
  </div>
  <div class="pr-bottom-row">
    <span class="age">${age} - @${escHtml(pr.author.login)}</span>
    ${inProgress ? '<span class="in-progress-badge">⚡ In review</span>' : ''}
    ${!inProgress ? `<span class="rd ${rdClass}">${rdLabel}</span>` : ''}
  </div>
</div>`;
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

function renderMarkdown(text: string): string {
  if (!text.trim()) return '<p><em>No description provided.</em></p>';

  let html = escHtml(text);

  // Code blocks (must run before inline-code pass)
  html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code) =>
    `<pre><code>${code.trim()}</code></pre>`
  );

  // Headings, blockquotes
  html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Inline formatting
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');

  // List items
  html = html.replace(/^- \[x\] (.+)$/gm, '<li class="checked">☑ $1</li>');
  html = html.replace(/^- \[ \] (.+)$/gm, '<li class="unchecked">☐ $1</li>');
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Horizontal rules
  html = html.replace(/^(?:---|\*\*\*|___)$/gm, '<hr>');

  // GitHub media — bare attachment URLs → video/image elements
  html = html.replace(
    /^(https:\/\/github\.com\/user-attachments\/assets\/[a-zA-Z0-9_-]+)\s*$/gm,
    (_m, url) =>
      `<div class="media-wrap"><video controls preload="metadata" src="${url}">` +
      `<a href="${url}">View video</a></video></div>`
  );
  html = html.replace(
    /^(https:\/\/(?:user-images|camo)\.githubusercontent\.com\/\S+)\s*$/gm,
    (_m, url) => `<div class="media-wrap"><img src="${url}" alt="attachment"></div>`
  );

  // Final pass: line-by-line.
  // - Runs of <li> lines are wrapped together in a single <ul>.
  // - Other block elements are emitted directly.
  // - Runs of inline content are wrapped in <p> (joined with <br>).
  // - Empty lines flush whatever is currently pending.
  // Trim each line first so trailing \r from CRLF files doesn't break detection.
  const blockRe = /^<(h[1-6]|ol|pre|blockquote|hr|div|p\b)/;
  const out: string[] = [];
  let pending: string[] = [];
  let listItems: string[] = [];

  const flushPending = () => {
    const content = pending.join('<br>').trim();
    if (content) out.push(`<p>${content}</p>`);
    pending = [];
  };

  const flushList = () => {
    if (listItems.length > 0) {
      out.push(`<ul>${listItems.join('')}</ul>`);
      listItems = [];
    }
  };

  for (const line of html.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushPending();
      flushList();
    } else if (trimmed.startsWith('<li')) {
      // Accumulate list items — flush inline paragraph first
      flushPending();
      listItems.push(trimmed);
    } else if (blockRe.test(trimmed)) {
      flushPending();
      flushList();
      out.push(trimmed);
    } else {
      // Inline content — flush any open list first
      flushList();
      pending.push(trimmed);
    }
  }
  flushPending();
  flushList();

  return out.join('\n');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


function ageLabel(createdAt: string): string {
  const diffMs = Date.now() - new Date(createdAt).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  return `${Math.floor(weeks / 4)}mo ago`;
}

function reviewDecisionLabel(decision: GhPullRequest['reviewDecision']): string {
  switch (decision) {
    case 'APPROVED': return '✓ Approved';
    case 'CHANGES_REQUESTED': return '✗ Changes requested';
    case 'REVIEW_REQUIRED': return '⏳ Review required';
    default: return '— No review yet';
  }
}
