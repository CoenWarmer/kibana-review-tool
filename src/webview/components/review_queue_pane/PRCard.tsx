import type { GhPullRequest } from '../../types';
import { ageLabel } from '../../utils';
import { postMessage } from '../../vscode';

const STATE_ICON: Record<string, string> = {
  APPROVED: '✅',
  CHANGES_REQUESTED: '❌',
  COMMENTED: '👀',
  DISMISSED: '🚮',
};

export function PrCard({
  pr,
  selected,
  isSeen,
  onSeen,
  teamFilterMembers,
}: {
  pr: GhPullRequest;
  selected: boolean;
  isSeen: boolean;
  teamFilterMembers: string[];
  onSeen: (n: number) => void;
}) {
  const memberSet = new Set(teamFilterMembers);
  const isTeamAuthor = teamFilterMembers.length > 0 && memberSet.has(pr.author.login);

  // Reviews submitted by team members (excluding PENDING)
  const teamReviews =
    teamFilterMembers.length > 0
      ? (pr.latestReviews ?? []).filter(
          (r) => r.state !== 'PENDING' && memberSet.has(r.author.login)
        )
      : [];

  // Team members assigned but not yet in latestReviews
  const reviewerLogins = new Set(teamReviews.map((r) => r.author.login));
  const teamAssignees =
    teamFilterMembers.length > 0
      ? (pr.assignees ?? []).filter((a) => memberSet.has(a.login) && !reviewerLogins.has(a.login))
      : [];

  return (
    <div
      className={`pr-card${selected ? ' selected' : ''}${isSeen ? ' seen' : ''}`}
      onClick={() => {
        onSeen(pr.number);
        postMessage({ type: 'selectPR', prNumber: pr.number });
      }}
    >
      <div className="pr-card-content">
        <div className="pr-title">
          <span className="pr-num">#{pr.number}</span> {pr.title}
        </div>
        <div className="pr-bottom-row">
          <span className="age">
            {ageLabel(pr.createdAt)} - @{pr.author.login}
            {teamFilterMembers.length > 0 && (
              <span
                className={`pr-author-badge${isTeamAuthor ? ' pr-author-badge--team' : ' pr-author-badge--external'}`}
                title={isTeamAuthor ? 'Author is a team member' : 'Author is not a team member'}
              >
                {isTeamAuthor ? 'team' : 'external'}
              </span>
            )}
          </span>
          {(teamReviews.length > 0 || teamAssignees.length > 0) && (
            <span className="pr-team-reviewers">
              {teamReviews.map((r) => (
                <span
                  key={r.author.login}
                  className={`pr-team-reviewer state-${r.state.toLowerCase()}`}
                >
                  <span className="pr-reviewer-icon">{STATE_ICON[r.state] ?? '·'}</span>
                  {r.author.login}
                </span>
              ))}
              {teamAssignees.map((a) => (
                <span key={a.login} className="pr-team-reviewer state-assigned">
                  <span className="pr-reviewer-icon">→</span>
                  {a.login}
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
