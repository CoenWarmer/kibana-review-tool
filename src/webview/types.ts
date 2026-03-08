// ─── GitHub data types ────────────────────────────────────────────────────────

export interface GhReviewRequest {
  login?: string;
  name?: string;
  slug?: string;
}

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | '';

export interface GhReview {
  author: { login: string };
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submittedAt: string;
}

export interface TeamReviewInfo {
  status: 'APPROVED' | 'CHANGES_REQUESTED' | 'PENDING' | 'IN_PROGRESS';
  reviewer?: { login: string; submittedAt: string };
  /** All team members who have reviewed (IN_PROGRESS state); supersedes the single reviewer field. */
  reviewers?: Array<{ login: string; submittedAt: string }>;
}

export interface GhPrFile {
  path: string;
  additions: number;
  deletions: number;
  status?: string;
  changeType?: string;
}

export interface GhPullRequest {
  number: number;
  title: string;
  body: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  createdAt: string;
  headRefName: string;
  baseRefName: string;
  reviewRequests: GhReviewRequest[];
  reviewDecision: ReviewDecision;
  author: { login: string };
  url: string;
  latestReviews: GhReview[];
  assignees?: Array<{ login: string }>;
  teamReviewStatuses?: Record<string, TeamReviewInfo>;
  /** Populated after PR detail is fetched; absent on queue list items. */
  files?: GhPrFile[];
}

export interface GhDiscussionComment {
  id: number;
  author: string;
  avatarUrl?: string;
  body: string;
  createdAt: string;
  kind: 'comment' | 'review';
  reviewState?: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
}

export interface GhCommit {
  sha: string;
  message: string;
  author: string;
  avatarUrl?: string;
  committedAt: string;
}

export interface OrderedFile {
  path: string;
  additions: number;
  deletions: number;
  status?: string;
  changeType?: string;
}

export interface SuggestedFile {
  path: string;
  reason: string;
}

export interface ReviewOrderSuggestion {
  topDown: SuggestedFile[];
  bottomUp: SuggestedFile[];
}

export type OrderMode = 'default' | 'top-down' | 'bottom-up';

// ─── App state ────────────────────────────────────────────────────────────────

export interface AppState {
  // Queue
  allPrs: GhPullRequest[];
  isLoading: boolean;
  errorMessage: string;
  needsReviewFilterActive: boolean;
  userTeams: string[];
  teamFilter: string;
  /** Member logins for the currently selected team filter; empty when no team is selected. */
  teamFilterMembers: string[];

  // Tab
  activeTab: 'queue' | 'reviewing';

  // Reviewing pane
  currentPr: GhPullRequest | null;
  discussionComments: GhDiscussionComment[];
  prCommits: GhCommit[];
  checkoutBusy: boolean;
  checkoutStage: string;

  // Changed files
  cfFiles: OrderedFile[];
  cfActiveFile: string | null;
  cfReviewedPaths: string[];
  cfOwnedByMePaths: string[] | null;
  cfIsLoading: boolean;
  cfErrorMessage: string;
  cfSuggestedOrder: ReviewOrderSuggestion | null;
  cfOrderMode: OrderMode;
  cfIsOrderLoading: boolean;

  // Server status
  esStatus: 'running' | 'starting' | 'stopped';
  kibanaStatus: 'running' | 'starting' | 'stopped';

  // Misc
  checkedOutPrNumber: number | null;
  currentUserLogin: string;
  currentBranch: string | null;
  repo: string;
  /** True when the open workspace is not the Kibana repository. Shows a placeholder instead of the normal UI. */
  wrongRepo: boolean;

  // Synthtrace
  synthtraceScenarios: string[];
}

// ─── Message protocol ─────────────────────────────────────────────────────────

export type OutboundMessage =
  | { type: 'setState'; state: Partial<AppState> }
  | { type: 'commentPosted' }
  | { type: 'reviewSubmitted'; event: 'APPROVE' | 'REQUEST_CHANGES' };

export type InboundMessage =
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
  | { type: 'setOrderMode'; mode: OrderMode }
  | { type: 'startEs' }
  | { type: 'startKibana' }
  | { type: 'openKibana' }
  | { type: 'runSynthtrace'; scenario: string; live: boolean }
  | { type: 'refreshScenarios' }
  | { type: 'setTeamFilter'; team: string };
