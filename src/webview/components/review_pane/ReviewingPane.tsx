import { useState, useEffect, useRef } from 'react';
import { postMessage } from '../../vscode';
import { extractBuildkiteSummary } from '../../utils';
import { MarkdownBody } from '../MarkdownBody';
import { FilesSection } from './FilesSection';
import { DiscussionSection } from './DiscussionSection';
import { CodeRabbitSection } from '../CodeRabbitSection';
import type { AppState } from '../../types';
import { DevEnvPanel } from './DevEnvPanel';
import { SectionNavBar } from './SectionNavBar';
import { PrHeader } from './PRHeader';

export type ReviewingPaneProps = Pick<
  AppState,
  | 'currentPr'
  | 'discussionComments'
  | 'codeRabbitIssues'
  | 'checkoutBusy'
  | 'checkoutStage'
  | 'cfFiles'
  | 'cfActiveFile'
  | 'cfReviewedPaths'
  | 'cfOwnedByMePaths'
  | 'cfIsLoading'
  | 'cfErrorMessage'
  | 'cfSuggestedOrder'
  | 'cfOrderMode'
  | 'cfIsOrderLoading'
  | 'cfCommitFilter'
  | 'cfCommitFilterFiles'
  | 'cfCommitFilterLoading'
  | 'myBranchBaseRef'
  | 'myBranchCommits'
  | 'esStatus'
  | 'kibanaStatus'
  | 'checkedOutPrNumber'
  | 'repo'
  | 'synthtraceScenarios'
> & {
  commentPosted: boolean;
  currentBranch: string | null;
  isKibanaRepo: boolean;
  reviewSubmitted: { event: 'APPROVE' | 'REQUEST_CHANGES' } | null;
  onClearFeedback: () => void;
};

export function ReviewingPane({
  cfFiles,
  checkoutBusy,
  checkoutStage,
  esStatus,
  kibanaStatus,
  checkedOutPrNumber,
  currentBranch,
  isKibanaRepo,
  commentPosted,
  reviewSubmitted,
  onClearFeedback,
  currentPr,
  cfActiveFile,
  cfReviewedPaths,
  cfOwnedByMePaths,
  cfIsLoading,
  cfErrorMessage,
  cfSuggestedOrder,
  cfOrderMode,
  cfIsOrderLoading,
  cfCommitFilter,
  cfCommitFilterFiles,
  cfCommitFilterLoading,
  myBranchBaseRef: _myBranchBaseRef,
  myBranchCommits,
  discussionComments,
  codeRabbitIssues,
  repo,
  synthtraceScenarios,
}: ReviewingPaneProps) {
  const repoUrl = `https://github.com/${repo}`;

  // ── Dev environment panel ────────────────────────────────────────────────
  const [devEnvOpen, setDevEnvOpen] = useState(false);

  // ── My Branch: commit file selection ──────────────────────────────────────
  const [selectedForCommit, setSelectedForCommit] = useState<Set<string>>(new Set());
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const commitMsgRef = useRef<HTMLTextAreaElement>(null);

  // Reset selection when the file list changes (e.g. after a commit refreshes data)
  useEffect(() => {
    setSelectedForCommit(new Set());
    setCommitDialogOpen(false);
    setCommitMsg('');
  }, [cfFiles]);

  const toggleFileForCommit = (path: string) => {
    setSelectedForCommit((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const openCommitDialog = () => {
    setCommitDialogOpen(true);
    // Focus the textarea on next tick
    setTimeout(() => commitMsgRef.current?.focus(), 0);
  };

  const submitCommit = () => {
    const msg = commitMsg.trim();
    if (!msg || selectedForCommit.size === 0) return;
    postMessage({ type: 'commitFiles', files: [...selectedForCommit], message: msg });
    setCommitDialogOpen(false);
    setCommitMsg('');
  };

  // Buildkite data lives in discussion comments posted by elasticmachine, not the PR body.
  // Scan all comment bodies (the bot edits its comment in-place, so the last one wins).
  const ciBuilds = extractBuildkiteSummary(discussionComments.map((c) => c.body).join('\n'));

  if (!currentPr) {
    return (
      <div className="reviewing-content">
        <div className="reviewing-empty">
          <p>
            You&apos;re on <code>{currentBranch ?? 'unknown'}</code>. Compared to upstream main,
            these are your committed changed files:
          </p>
        </div>
        <div id="files-section" className="section last own-branch">
          <FilesSection
            files={cfFiles}
            activeFile={cfActiveFile}
            reviewedPaths={cfReviewedPaths}
            ownedByMePaths={null}
            isLoading={cfIsLoading}
            errorMessage={cfErrorMessage}
            suggestedOrder={cfSuggestedOrder}
            orderMode={cfOrderMode}
            isOrderLoading={cfIsOrderLoading}
            isCheckedOut={true}
            commits={myBranchCommits}
            commitFilter={cfCommitFilter}
            commitFilterFiles={cfCommitFilterFiles}
            commitFilterLoading={cfCommitFilterLoading}
            selectedForCommit={selectedForCommit}
            onToggleFileForCommit={toggleFileForCommit}
            onSelectAllFilesForCommit={(paths, select) => {
              setSelectedForCommit(select ? new Set(paths) : new Set());
            }}
          />
        </div>
        {cfIsLoading ? null : (
          <div id="action-section" className="section">
            {commitDialogOpen ? (
              <div className="commit-dialog">
                <textarea
                  ref={commitMsgRef}
                  className="commit-msg-input"
                  placeholder="Commit message…"
                  value={commitMsg}
                  rows={3}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitCommit();
                    if (e.key === 'Escape') setCommitDialogOpen(false);
                  }}
                />
                <div className="commit-dialog-actions">
                  <button
                    className="commit-dialog-submit"
                    disabled={!commitMsg.trim() || selectedForCommit.size === 0}
                    onClick={submitCommit}
                    title="Commit selected files (⌘↵)"
                  >
                    Commit {selectedForCommit.size} file{selectedForCommit.size !== 1 ? 's' : ''}
                  </button>
                  <button
                    className="commit-dialog-cancel"
                    onClick={() => setCommitDialogOpen(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="my-branch-actions">
                <button
                  className="my-branch-commit-btn"
                  disabled={selectedForCommit.size === 0}
                  title={
                    selectedForCommit.size === 0
                      ? 'Select files to commit'
                      : `Commit ${selectedForCommit.size} selected file${selectedForCommit.size !== 1 ? 's' : ''}`
                  }
                  onClick={openCommitDialog}
                >
                  📝 Commit {selectedForCommit.size > 0 ? `${selectedForCommit.size} ` : ''}files
                </button>
                <button
                  className="my-branch-create-pr-btn"
                  onClick={() => postMessage({ type: 'createPr' })}
                >
                  ⭐️ Push and create PR
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="reviewing-content">
      <div id="pr-header" className="section">
        <PrHeader
          pr={currentPr}
          ciBuilds={ciBuilds}
          ciBuildsLoading={discussionComments.length === 0}
          checkoutBusy={checkoutBusy}
          checkoutStage={checkoutStage}
          esStatus={esStatus}
          kibanaStatus={kibanaStatus}
          checkedOutPrNumber={checkedOutPrNumber}
          cfFiles={cfFiles}
          cfOwnedByMePaths={cfOwnedByMePaths}
        />
      </div>
      <div className="section-nav-container">
        <SectionNavBar
          pr={currentPr}
          checkoutBusy={checkoutBusy}
          checkoutStage={checkoutStage}
          checkedOutPrNumber={checkedOutPrNumber}
          isKibanaRepo={isKibanaRepo}
          devEnvOpen={devEnvOpen}
          onToggleDevEnv={() => setDevEnvOpen((v) => !v)}
        />
        {devEnvOpen && (
          <DevEnvPanel
            esStatus={esStatus}
            kibanaStatus={kibanaStatus}
            synthtraceScenarios={synthtraceScenarios}
            postMessage={postMessage}
          />
        )}
      </div>
      <div id="description-section" className="section">
        <div className="pr-body">
          <MarkdownBody content={currentPr.body ?? ''} repoUrl={repoUrl} />
        </div>
      </div>
      <div id="files-section" className="section">
        <FilesSection
          files={cfFiles}
          activeFile={cfActiveFile}
          reviewedPaths={cfReviewedPaths}
          ownedByMePaths={cfOwnedByMePaths}
          isLoading={cfIsLoading}
          errorMessage={cfErrorMessage}
          suggestedOrder={cfSuggestedOrder}
          orderMode={cfOrderMode}
          isOrderLoading={cfIsOrderLoading}
          previewFiles={currentPr.files}
          isCheckedOut={currentPr.number === checkedOutPrNumber}
          commits={discussionComments.filter((c) => c.kind === 'commit')}
          commitFilter={cfCommitFilter}
          commitFilterFiles={cfCommitFilterFiles}
          commitFilterLoading={cfCommitFilterLoading}
        />
      </div>
      {codeRabbitIssues.length > 0 && (
        <div className="section">
          <CodeRabbitSection issues={codeRabbitIssues} />
        </div>
      )}
      <div id="discussion-section" className="section">
        <DiscussionSection
          comments={discussionComments}
          repoUrl={repoUrl}
          onCommentPosted={commentPosted}
          onReviewSubmitted={reviewSubmitted}
          onClearFeedback={onClearFeedback}
        />
      </div>
    </div>
  );
}
