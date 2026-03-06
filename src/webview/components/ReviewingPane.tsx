import type { ReactNode } from 'react';
import { postMessage } from '../vscode';
import { ageLabel, renderMarkdown, extractBuildkiteSummary, type BuildkiteSummaryItem } from '../utils';
import { FilesSection } from './FilesSection';
import { DiscussionSection } from './DiscussionSection';
import type { AppState, GhPullRequest, TeamReviewInfo } from '../types';
import { ActionSection } from './ActionSection';

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
  | 'esStatus'
  | 'kibanaStatus'
  | 'checkedOutPrNumber'
  | 'repo'
  | 'synthtraceScenarios'
> & {
  commentPosted: boolean;
  reviewSubmitted: { event: 'APPROVE' | 'REQUEST_CHANGES' } | null;
  onClearFeedback: () => void;
};

export function ReviewingPane({ cfFiles, checkoutBusy, checkoutStage, esStatus, kibanaStatus, checkedOutPrNumber, commentPosted, reviewSubmitted, onClearFeedback, currentPr, cfActiveFile, cfReviewedPaths, cfOwnedByMePaths, cfIsLoading, cfErrorMessage, cfSuggestedOrder, cfOrderMode, cfIsOrderLoading, discussionComments, repo, synthtraceScenarios }: ReviewingPaneProps) {
  const repoUrl = `https://github.com/${repo}`;

  // Buildkite data lives in discussion comments posted by elasticmachine, not the PR body.
  // Scan all comment bodies (the bot edits its comment in-place, so the last one wins).
  const ciBuilds = extractBuildkiteSummary(
    discussionComments.map((c) => c.body).join('\n')
  );

  if (!currentPr) {
    return (
      <div className="reviewing-empty">
        <p>Click a PR in the Review Queue to see its description here.</p>
      </div>
    );
  }

  return (
    <div className="reviewing-content">
      <div id="pr-header" className="section">
        <PrHeader pr={currentPr} ciBuilds={ciBuilds} checkoutBusy={checkoutBusy} checkoutStage={checkoutStage} esStatus={esStatus} kibanaStatus={kibanaStatus} checkedOutPrNumber={checkedOutPrNumber} />
      </div>
      <div className="section">
        <div
          className="pr-body"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(currentPr.body ?? '', repoUrl) }}
        />
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
        <ActionSection pr={currentPr} checkoutBusy={checkoutBusy} checkedOutPrNumber={checkedOutPrNumber} checkoutStage={checkoutStage} esStatus={esStatus} kibanaStatus={kibanaStatus} synthtraceScenarios={synthtraceScenarios} postMessage={postMessage} />
      </div>
    </div>
  );
}

function PrHeader({
  pr,
  ciBuilds,
}: { pr: GhPullRequest; ciBuilds: BuildkiteSummaryItem[] } & Pick<ReviewingPaneProps, 'checkoutBusy' | 'checkoutStage' | 'esStatus' | 'kibanaStatus' | 'checkedOutPrNumber'>) {
  return (
    <>
      <h2 className="pr-desc-title">
        <a href={pr.url} target="_blank" rel="noreferrer" className="pr-num">#{pr.number}</a>{' '}
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
            {ciBuilds.map((b) => (
            <span className="ci-status" key={b.pipelineName}>
              <span className={`bk-icon ${b.cls}`}>{b.icon}</span>{' '}
              <a href={b.url} className="bk-link">#{b.buildNumber}</a>{' '}
            </span>
            ))}
          </div>

        <TeamsTable pr={pr} />
      </div>
    </>
  );
}

function TeamsTable({ pr }: { pr: GhPullRequest }) {
  const pendingTags: ReactNode[] = [];
  const inProgressTags: ReactNode[] = [];
  const reviewedTags: ReactNode[] = [];

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
        {indicator}{label}
      </span>
    );
  };

  if (pr.teamReviewStatuses && Object.keys(pr.teamReviewStatuses).length > 0) {
    for (const [slug, info] of Object.entries(pr.teamReviewStatuses)) {
      const s = info as TeamReviewInfo;
      if (s.status === 'APPROVED') {
        const tip = s.reviewer ? `Approved by ${s.reviewer.login} ${ageLabel(s.reviewer.submittedAt)}` : '';
        reviewedTags.push(buildTag(slug, <span className="tag-status approved">✓</span>, tip, s.reviewer?.login));
      } else if (s.status === 'CHANGES_REQUESTED') {
        const tip = s.reviewer ? `Changes requested by ${s.reviewer.login} ${ageLabel(s.reviewer.submittedAt)}` : '';
        reviewedTags.push(buildTag(slug, <span className="tag-status changes_requested">✗</span>, tip, s.reviewer?.login));
      } else if (s.status === 'IN_PROGRESS') {
        const tip = s.reviewer ? `Reviewing since ${ageLabel(s.reviewer.submittedAt)}` : '';
        inProgressTags.push(buildTag(slug, <span className="tag-status in-progress">⚡</span>, tip, s.reviewer?.login));
      } else {
        pendingTags.push(buildTag(slug, <span className="tag-status pending">●</span>, ''));
      }
    }
  } else {
    pr.reviewRequests.filter((r) => r.slug).forEach((r) => {
      pendingTags.push(buildTag(r.slug!, <span className="tag-status pending">●</span>, ''));
    });
  }

  // Surface individual COMMENTED reviewers not already in inProgressTags
  const teamInProgressLogins = new Set(
    Object.values(pr.teamReviewStatuses ?? {})
      .filter((s) => s.status === 'IN_PROGRESS')
      .map((s) => s.reviewer?.login)
      .filter(Boolean)
  );
  (pr.latestReviews ?? [])
    .filter((r) => r.state === 'COMMENTED' && r.author.login !== pr.author.login && !teamInProgressLogins.has(r.author.login))
    .forEach((r) => {
      const tip = `Reviewing since ${ageLabel(r.submittedAt)}`;
      inProgressTags.push(
        <span key={r.author.login} className="tag" data-tip={tip}>
          <span className="tag-status in-progress">⚡</span>{r.author.login}
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
