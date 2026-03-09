import type { ReactNode } from 'react';
import { useState, useEffect, useRef } from 'react';
import { postMessage } from '../vscode';
import { ageLabel, extractBuildkiteSummary, isBot, type BuildkiteSummaryItem } from '../utils';
import { MarkdownBody } from './MarkdownBody';
import { FilesSection } from './FilesSection';
import { DiscussionSection } from './DiscussionSection';
import type { AppState, GhPullRequest, GhPrFile, TeamReviewInfo } from '../types';
import { ActionSection } from './ActionSection';
import { Spinner } from './Spinner';

type ReviewingPaneProps = Pick<
  AppState,
  | 'currentPr'
  | 'discussionComments'
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
  myBranchBaseRef,
  myBranchCommits,
  discussionComments,
  repo,
  synthtraceScenarios,
}: ReviewingPaneProps) {
  const repoUrl = `https://github.com/${repo}`;

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
            You&apos;re on branch <code>{currentBranch ?? 'unknown'}</code> which doesn&apos;t look
            like it&apos;s part of a PR by another author.
          </p>
        </div>
        <div id="files-section" className="section">
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
          />
        </div>
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
                <button className="commit-dialog-cancel" onClick={() => setCommitDialogOpen(false)}>
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
                Commit {selectedForCommit.size > 0 ? `${selectedForCommit.size} ` : ''}files
              </button>
              <button
                className="my-branch-create-pr-btn"
                onClick={() => postMessage({ type: 'createPr' })}
              >
                Create PR ↗
              </button>
            </div>
          )}
        </div>
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
      <div className="section">
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
      <div className="section">
        <DiscussionSection
          comments={discussionComments}
          repoUrl={repoUrl}
          onCommentPosted={commentPosted}
          onReviewSubmitted={reviewSubmitted}
          onClearFeedback={onClearFeedback}
        />
      </div>
      <div id="action-section" className="section">
        <ActionSection
          pr={currentPr}
          checkoutBusy={checkoutBusy}
          checkedOutPrNumber={checkedOutPrNumber}
          checkoutStage={checkoutStage}
          esStatus={esStatus}
          kibanaStatus={kibanaStatus}
          isKibanaRepo={isKibanaRepo}
          synthtraceScenarios={synthtraceScenarios}
          postMessage={postMessage}
        />
      </div>
    </div>
  );
}

const PR_HEADER_MAX_HEIGHT = 370;

function PrHeader({
  pr,
  ciBuilds,
  ciBuildsLoading,
  cfFiles,
  cfOwnedByMePaths,
}: { pr: GhPullRequest; ciBuilds: BuildkiteSummaryItem[]; ciBuildsLoading: boolean } & Pick<
  ReviewingPaneProps,
  | 'checkoutBusy'
  | 'checkoutStage'
  | 'esStatus'
  | 'kibanaStatus'
  | 'checkedOutPrNumber'
  | 'cfFiles'
  | 'cfOwnedByMePaths'
>) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const innerRef = useRef<HTMLDivElement>(null);

  // Measure after mount and whenever the PR changes.
  useEffect(() => {
    setExpanded(false);
    // Read on next frame so the DOM has been painted.
    const id = requestAnimationFrame(() => {
      if (innerRef.current) {
        setOverflows(innerRef.current.scrollHeight > PR_HEADER_MAX_HEIGHT);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [pr.number]);

  return (
    <>
      <div
        ref={innerRef}
        className={`pr-header-collapsible${overflows && !expanded ? ' pr-header-clipped' : ''}`}
        style={expanded ? undefined : { maxHeight: PR_HEADER_MAX_HEIGHT, overflow: 'hidden' }}
      >
        <h2 className="pr-desc-title">
          <a href={pr.url} target="_blank" rel="noreferrer" className="pr-num">
            #{pr.number}
          </a>{' '}
          {pr.title}
        </h2>

        <div className="pr-info">
          <div className="info-row">
            <span className="label">Author</span>
            <span>{pr.author.login}</span>
          </div>
          <div className="info-row">
            <span className="label">Branch</span>
            <code>{pr.headRefName}</code>
          </div>

          <div className="info-row">
            <span className="label">Build</span>
            {ciBuildsLoading ? (
              <Spinner />
            ) : ciBuilds.length > 0 ? (
              ciBuilds.map((b) => (
                <span className="ci-status" key={b.pipelineName}>
                  <span className={`bk-icon ${b.cls}`}>{b.icon}</span>{' '}
                  <a href={b.url} className="bk-link">
                    #{b.buildNumber}
                  </a>{' '}
                </span>
              ))
            ) : (
              <span className="info-empty">—</span>
            )}
          </div>

          <FileOwnershipRow
            cfFiles={cfFiles}
            cfOwnedByMePaths={cfOwnedByMePaths}
            previewFiles={pr.files}
          />
          <TeamsTable pr={pr} />
        </div>
      </div>

      {overflows && !expanded && (
        <button className="pr-header-see-all" onClick={() => setExpanded(true)}>
          See all
        </button>
      )}
    </>
  );
}

function FileOwnershipRow({
  cfFiles,
  cfOwnedByMePaths,
  previewFiles,
}: Pick<ReviewingPaneProps, 'cfFiles' | 'cfOwnedByMePaths'> & { previewFiles?: GhPrFile[] }) {
  // Prefer the live checkout file list; fall back to the PR detail preview list.
  const files = cfFiles.length > 0 ? cfFiles : (previewFiles ?? []);

  // Ownership (and possibly files) still loading — keep the row visible with a spinner
  // so the label is always present and there is no layout jump when data arrives.
  if (cfOwnedByMePaths === null) {
    return (
      <div className="info-row">
        <span className="label">Files</span>
        <Spinner />
      </div>
    );
  }

  // Everything loaded but this PR genuinely has no files — hide the row.
  if (files.length === 0) return null;

  const ownedSet = new Set(cfOwnedByMePaths);
  const mine = files.filter((f) => ownedSet.has(f.path)).length;
  const other = files.length - mine;
  const total = files.length;
  const minePct = total > 0 ? (mine / total) * 100 : 0;

  return (
    <div className="info-row">
      <span className="label">Files</span>
      <div className="files-ownership">
        <div
          className="files-ownership-bar"
          title={`${mine} owned by my team, ${other} owned by other teams`}
        >
          <div className="files-ownership-mine" style={{ width: `${minePct}%` }} />
          <div className="files-ownership-other" style={{ width: `${100 - minePct}%` }} />
        </div>
        <span className="files-ownership-counts">
          <span className="files-ownership-mine-label">{mine} owned by my team</span>
          {' · '}
          <span className="files-ownership-other-label">{other} owned by others</span>
        </span>
      </div>
    </div>
  );
}

function TeamsTable({ pr }: { pr: GhPullRequest }) {
  const pendingTags: ReactNode[] = [];
  const inProgressTags: ReactNode[] = [];
  const reviewedTags: ReactNode[] = [];

  // Track logins already attributed to a team to avoid duplicates.
  const attributedLogins = new Set<string>();

  const buildTag = (
    fullSlug: string,
    indicator: ReactNode,
    tip: string,
    reviewer?: string
  ): ReactNode => {
    const bareSlug = fullSlug.includes('/') ? fullSlug.split('/').pop()! : fullSlug;
    const label = reviewer ? `${reviewer} for ${bareSlug}` : `@${bareSlug}`;
    return (
      <span key={fullSlug + (reviewer ?? '')} className="tag" data-tip={tip || undefined}>
        {indicator}
        {label}
      </span>
    );
  };

  if (pr.teamReviewStatuses && Object.keys(pr.teamReviewStatuses).length > 0) {
    for (const [slug, info] of Object.entries(pr.teamReviewStatuses)) {
      const s = info as TeamReviewInfo;
      if (s.status === 'APPROVED') {
        const tip = s.reviewer
          ? `Approved by ${s.reviewer.login} ${ageLabel(s.reviewer.submittedAt)}`
          : '';
        if (s.reviewer) attributedLogins.add(s.reviewer.login);
        reviewedTags.push(
          buildTag(slug, <span className="tag-status approved">✅</span>, tip, s.reviewer?.login)
        );
      } else if (s.status === 'CHANGES_REQUESTED') {
        const tip = s.reviewer
          ? `Changes requested by ${s.reviewer.login} ${ageLabel(s.reviewer.submittedAt)}`
          : '';
        if (s.reviewer) attributedLogins.add(s.reviewer.login);
        reviewedTags.push(
          buildTag(
            slug,
            <span className="tag-status changes_requested">❌</span>,
            tip,
            s.reviewer?.login
          )
        );
      } else if (s.status === 'IN_PROGRESS') {
        // Use the full reviewers array when available; fall back to the legacy single reviewer.
        const reviewerList = s.reviewers ?? (s.reviewer ? [s.reviewer] : []);
        const bareSlug = slug.includes('/') ? slug.split('/').pop()! : slug;
        for (const r of reviewerList) {
          // Deduplicate: if this login already appeared for another team, skip.
          if (attributedLogins.has(r.login)) continue;
          attributedLogins.add(r.login);
          const tip = `Reviewing since ${ageLabel(r.submittedAt)}`;
          inProgressTags.push(
            <span key={slug + r.login} className="tag" data-tip={tip}>
              <span className="tag-status in-progress">👀</span>
              {r.login} for {bareSlug}
            </span>
          );
        }
      } else {
        pendingTags.push(buildTag(slug, <span className="tag-status pending">●</span>, ''));
      }
    }
  } else {
    pr.reviewRequests
      .filter((r) => r.slug)
      .forEach((r) => {
        pendingTags.push(buildTag(r.slug!, <span className="tag-status pending">●</span>, ''));
      });
  }

  // Surface individual COMMENTED reviewers not already attributed to a team.
  (pr.latestReviews ?? [])
    .filter(
      (r) =>
        r.state === 'COMMENTED' &&
        r.author.login !== pr.author.login &&
        !attributedLogins.has(r.author.login)
    )
    .forEach((r) => {
      const tip = `Reviewing since ${ageLabel(r.submittedAt)}`;
      inProgressTags.push(
        <span key={r.author.login} className="tag" data-tip={tip}>
          <span className="tag-status in-progress">{isBot(r.author.login) ? '🤖' : '⚡'}</span>
          {r.author.login}
        </span>
      );
    });

  const anyTags = pendingTags.length > 0 || inProgressTags.length > 0 || reviewedTags.length > 0;
  if (!anyTags) return null;

  return (
    <div className="teams-table">
      <div>
        <div className="teams-col-header">Awaiting review</div>
        <div className="tags">
          {pendingTags.length > 0 ? pendingTags : <span className="teams-none">—</span>}
        </div>
      </div>
      <div>
        <div className="teams-col-header">Reviewing</div>
        <div className="tags">
          {inProgressTags.length > 0 ? inProgressTags : <span className="teams-none">—</span>}
        </div>
      </div>
      <div>
        <div className="teams-col-header">Approved</div>
        <div className="tags">
          {reviewedTags.length > 0 ? reviewedTags : <span className="teams-none">—</span>}
        </div>
      </div>
    </div>
  );
}
