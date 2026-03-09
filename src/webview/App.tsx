import { useEffect, useReducer } from 'react';
import { postMessage } from './vscode';
import { Spinner } from './components/Spinner';
import { TabBar } from './components/TabBar';
import { QueuePane } from './components/QueuePane';
import { ReviewingPane } from './components/ReviewingPane';
import type { AppState, OutboundMessage } from './types';

// ─── Initial state ────────────────────────────────────────────────────────────

const initialState: AppState = {
  allPrs: [],
  isLoading: true,
  errorMessage: '',
  needsReviewFilterActive: false,
  userTeams: [],
  teamFilter: '',
  teamFilterMembers: [],
  activeTab: 'queue',
  currentPr: null,
  discussionComments: [],
  checkoutBusy: false,
  checkoutStage: '',
  cfFiles: [],
  cfActiveFile: null,
  cfReviewedPaths: [],
  cfOwnedByMePaths: null,
  cfIsLoading: false,
  cfErrorMessage: '',
  cfSuggestedOrder: null,
  cfOrderMode: 'default',
  cfIsOrderLoading: false,
  esStatus: 'stopped',
  kibanaStatus: 'stopped',
  checkedOutPrNumber: null,
  currentUserLogin: '',
  currentBranch: null,
  repo: 'elastic/kibana',
  synthtraceScenarios: [],
  wrongRepo: false,
  prRestoreComplete: false,
  cfCommitFilter: null,
  cfCommitFilterFiles: null,
  cfCommitFilterLoading: false,
};

// ─── Reducer ──────────────────────────────────────────────────────────────────

type Action =
  | { type: 'setState'; state: Partial<AppState> }
  | { type: 'commentPosted' }
  | { type: 'reviewSubmitted'; event: 'APPROVE' | 'REQUEST_CHANGES' }
  | { type: 'clearFeedback' };

interface UiState extends AppState {
  _commentPosted: boolean;
  _reviewSubmitted: { event: 'APPROVE' | 'REQUEST_CHANGES' } | null;
}

function reducer(state: UiState, action: Action): UiState {
  switch (action.type) {
    case 'setState':
      return { ...state, ...action.state };
    case 'commentPosted':
      return { ...state, _commentPosted: true };
    case 'reviewSubmitted':
      return { ...state, _reviewSubmitted: { event: action.event } };
    case 'clearFeedback':
      return { ...state, _commentPosted: false, _reviewSubmitted: null };
    default:
      return state;
  }
}

// ─── App ──────────────────────────────────────────────────────────────────────

export function App() {
  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    _commentPosted: false,
    _reviewSubmitted: null,
  });

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as OutboundMessage;
      if (!msg) return;
      switch (msg.type) {
        case 'setState':
          dispatch({ type: 'setState', state: msg.state });
          break;
        case 'commentPosted':
          dispatch({ type: 'commentPosted' });
          break;
        case 'reviewSubmitted':
          dispatch({ type: 'reviewSubmitted', event: msg.event });
          break;
      }
    };
    window.addEventListener('message', handler);
    // Signal to the extension that the webview is ready to receive state.
    postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  // Reset scroll position when switching tabs
  useEffect(() => {
    const paneId = state.activeTab === 'queue' ? 'pane-queue' : 'pane-reviewing';
    document.getElementById(paneId)?.scrollTo({ top: 0 });
  }, [state.activeTab]);

  const isKibanaRepo = !state.wrongRepo;

  const visiblePrCount = state.allPrs.filter((pr) => !pr.isDraft).length;
  const queueLabel = (
    <>
      Review Queue{' '}
      {state.isLoading ? (
        <Spinner className="tab-spinner" />
      ) : (
        <span className="tab-count">({visiblePrCount})</span>
      )}
    </>
  );
  const reviewingLabel = !state.prRestoreComplete
    ? '…'
    : state.currentPr
      ? `Reviewing #${state.currentPr.number}`
      : `My Branch (${state.currentBranch ?? 'unknown'})`;

  return (
    <>
      <TabBar activeTab={state.activeTab} queueLabel={queueLabel} reviewingLabel={reviewingLabel} />

      <div className={`pane${state.activeTab === 'queue' ? ' active' : ''}`} id="pane-queue">
        <QueuePane
          allPrs={state.allPrs}
          isLoading={state.isLoading}
          errorMessage={state.errorMessage}
          needsReviewFilterActive={state.needsReviewFilterActive}
          selectedPrNumber={state.currentPr?.number ?? null}
          userTeams={state.userTeams}
          teamFilter={state.teamFilter}
          teamFilterMembers={state.teamFilterMembers}
          currentUserLogin={state.currentUserLogin}
        />
      </div>

      <div
        className={`pane${state.activeTab === 'reviewing' ? ' active' : ''}`}
        id="pane-reviewing"
      >
        <ReviewingPane
          currentBranch={state.currentBranch}
          isKibanaRepo={isKibanaRepo}
          currentPr={state.currentPr}
          discussionComments={state.discussionComments}
          checkoutBusy={state.checkoutBusy}
          checkoutStage={state.checkoutStage}
          cfFiles={state.cfFiles}
          cfActiveFile={state.cfActiveFile}
          cfReviewedPaths={state.cfReviewedPaths}
          cfOwnedByMePaths={state.cfOwnedByMePaths}
          cfIsLoading={state.cfIsLoading}
          cfErrorMessage={state.cfErrorMessage}
          cfSuggestedOrder={state.cfSuggestedOrder}
          cfOrderMode={state.cfOrderMode}
          cfIsOrderLoading={state.cfIsOrderLoading}
          cfCommitFilter={state.cfCommitFilter}
          cfCommitFilterFiles={state.cfCommitFilterFiles}
          cfCommitFilterLoading={state.cfCommitFilterLoading}
          esStatus={state.esStatus}
          kibanaStatus={state.kibanaStatus}
          checkedOutPrNumber={state.checkedOutPrNumber}
          repo={state.repo}
          synthtraceScenarios={state.synthtraceScenarios}
          commentPosted={state._commentPosted}
          reviewSubmitted={state._reviewSubmitted}
          onClearFeedback={() => dispatch({ type: 'clearFeedback' })}
        />
      </div>
    </>
  );
}
