import type { ReactNode } from 'react';
import type { GhPullRequest, TeamReviewInfo } from '../../types';
import { ageLabel, isBot } from '../../utils';

export function TeamsTable({ pr }: { pr: GhPullRequest }) {
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
