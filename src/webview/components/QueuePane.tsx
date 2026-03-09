import { useState, useCallback, useRef } from 'react';
import { postMessage } from '../vscode';
import { ageLabel, isReviewInProgress } from '../utils';
import type { GhPullRequest } from '../types';
import { Spinner } from './Spinner';

interface Props {
  allPrs: GhPullRequest[];
  isLoading: boolean;
  errorMessage: string;
  needsReviewFilterActive: boolean;
  selectedPrNumber: number | null;
  currentUserLogin: string;
  userTeams: string[];
  teamFilter: string;
  /** Member logins for the selected team; empty array when no team selected. */
  teamFilterMembers: string[];
}

type Bucket = 'unreviewed' | 'in-review' | 'approved';

/**
 * Classify a PR into a bucket.
 *
 * When a team is selected and its member logins are known, the classification
 * is scoped to that team:
 *  - "In review"  — at least one team member has a non-pending review, OR the PR
 *                   is assigned to a team member.
 *  - "Unreviewed" — no team member has reviewed or is assigned yet.
 *
 * Without a team filter (or before members are fetched) the generic
 * isReviewInProgress heuristic is used as a fallback.
 */
function classifyPr(pr: GhPullRequest, teamMembers: string[]): Bucket {
  if (teamMembers.length > 0) {
    // Team-scoped classification: bucket is determined solely by what members of
    // the selected team have done — the aggregate reviewDecision is irrelevant
    // because other teams may have approved while this team hasn't reviewed yet.
    const memberSet = new Set(teamMembers);
    const teamReviews = (pr.latestReviews ?? []).filter(
      (r) => r.state !== 'PENDING' && memberSet.has(r.author.login)
    );
    if (teamReviews.some((r) => r.state === 'APPROVED')) return 'approved';
    const hasTeamAssignee = (pr.assignees ?? []).some((a) => memberSet.has(a.login));
    if (teamReviews.length > 0 || hasTeamAssignee) return 'in-review';
    return 'unreviewed';
  }

  // Fallback: generic heuristic (no team selected, or members not yet fetched)
  if (pr.reviewDecision === 'APPROVED') return 'approved';
  if (isReviewInProgress(pr) || pr.reviewDecision === 'CHANGES_REQUESTED') return 'in-review';
  return 'unreviewed';
}

const byNewest = (a: GhPullRequest, b: GhPullRequest) =>
  new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

const BUCKETS: { key: Bucket; label: string }[] = [
  { key: 'unreviewed', label: 'Unreviewed' },
  { key: 'in-review', label: 'In review' },
  { key: 'approved', label: 'Approved' },
];

const SEEN_KEY = 'elastic-pr-reviewer.seenPrs';
const SHOW_OWN_KEY = 'elastic-pr-reviewer.showOwnPrs';

function loadSeen(): Set<number> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw ? new Set(JSON.parse(raw) as number[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<number>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // storage quota or unavailable — ignore
  }
}

export function QueuePane({
  allPrs,
  isLoading,
  errorMessage,
  needsReviewFilterActive: _needsReviewFilterActive,
  selectedPrNumber,
  currentUserLogin,
  userTeams,
  teamFilter,
  teamFilterMembers,
}: Props) {
  const [search, setSearch] = useState('');
  const [showOwnPrs, setShowOwnPrs] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SHOW_OWN_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [seen, setSeen] = useState<Set<number>>(() => loadSeen());
  // Use a ref so the mark-seen callback always has the latest set without a stale closure.
  const seenRef = useRef(seen);
  seenRef.current = seen;

  const markSeen = useCallback((prNumber: number) => {
    const next = new Set(seenRef.current).add(prNumber);
    saveSeen(next);
    setSeen(next);
  }, []);

  const [collapsed, setCollapsed] = useState<Record<Bucket, boolean>>({
    unreviewed: false,
    'in-review': false,
    approved: false,
  });
  const toggleBucket = useCallback((key: Bucket) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const searchLower = search.toLowerCase();
  const matchesSearch = (pr: GhPullRequest) =>
    !search || `#${pr.number} ${pr.title} ${pr.author.login}`.toLowerCase().includes(searchLower);

  const matchesTeam = (pr: GhPullRequest) => {
    if (!teamFilter) return true;
    // teamFilter is "@org/slug"; reviewRequests carry the bare slug
    const bareSlug = teamFilter.replace(/^@[^/]+\//, '');
    // Check current pending review requests (team hasn't reviewed yet)
    if (pr.reviewRequests.some((r) => r.slug === bareSlug || r.name === bareSlug)) return true;
    // Also include PRs where a team member has already reviewed or is assigned —
    // GitHub removes the team from reviewRequests once a member submits a review,
    // but the PR was still fetched via team-review-requested: which persists.
    if (teamFilterMembers.length > 0) {
      const memberSet = new Set(teamFilterMembers);
      if ((pr.latestReviews ?? []).some((r) => memberSet.has(r.author.login))) return true;
      if ((pr.assignees ?? []).some((a) => memberSet.has(a.login))) return true;
    }
    return false;
  };

  const visible = allPrs
    .filter((pr) => !pr.isDraft)
    .filter(matchesTeam)
    .filter((pr) => showOwnPrs || !currentUserLogin || pr.author.login !== currentUserLogin);

  // Strip the "@org/" prefix for a compact label, e.g. "@elastic/obs-onboarding-team" → "obs-onboarding-team"
  const teamLabel = teamFilter ? teamFilter.replace(/^@[^/]+\//, '') : null;

  const total = visible.length;
  const buckets = BUCKETS.map(({ key, label }) => ({
    key,
    label: teamLabel ? `${label} by ${teamLabel}` : label,
    prs: visible
      .filter((pr) => classifyPr(pr, teamFilterMembers) === key && matchesSearch(pr))
      .sort(byNewest),
  }));
  const totalFiltered = buckets.reduce((n, b) => n + b.prs.length, 0);

  if (errorMessage && allPrs.length === 0) {
    return (
      <div className="status error">
        <div>✕</div>
        <div>{errorMessage}</div>
      </div>
    );
  }

  return (
    <>
      <div className="toolbar">
        <span className="count">
          {search || teamFilter ? `${totalFiltered} / ${total}` : `${total}`} PR
          {total === 1 ? '' : 's'}
        </span>
        <input
          className="search-input"
          type="text"
          placeholder="Filter…"
          autoComplete="off"
          spellCheck={false}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="team-filter-select"
          value={teamFilter}
          onChange={(e) => postMessage({ type: 'setTeamFilter', team: e.target.value })}
        >
          <option value="">All teams</option>
          {userTeams.map((t) => (
            <option key={t} value={t}>
              {t.replace(/^@[^/]+\//, '')}
            </option>
          ))}
        </select>

        <button
          className={`icon-btn${showOwnPrs ? ' active' : ''}`}
          title={showOwnPrs ? 'Including your own PRs' : 'Excluding your own PRs'}
          disabled={!currentUserLogin}
          onClick={() => {
            const next = !showOwnPrs;
            setShowOwnPrs(next);
            try {
              localStorage.setItem(SHOW_OWN_KEY, String(next));
            } catch {
              /* ignore */
            }
          }}
        >
          👤
        </button>
      </div>

      {isLoading && allPrs.length === 0 ? (
        <div className="status loading">
          <Spinner className="spinner-mr" /> Loading PRs…
        </div>
      ) : totalFiltered === 0 ? (
        <div className="status empty">No open PRs for your teams</div>
      ) : (
        <div className="pr-list">
          {buckets.map(({ key, label, prs }) =>
            prs.length === 0 ? null : (
              <div key={key} className="pr-bucket">
                <div
                  className="pr-bucket-header"
                  onClick={() => toggleBucket(key)}
                  role="button"
                  aria-expanded={!collapsed[key]}
                >
                  <span className="pr-bucket-chevron">{collapsed[key] ? '▶' : '▼'}</span>
                  <span className="pr-bucket-count">{prs.length}</span>
                  {label}
                </div>
                {!collapsed[key] &&
                  prs.map((pr) => (
                    <PrCard
                      key={pr.number}
                      pr={pr}
                      selected={pr.number === selectedPrNumber}
                      isSeen={seen.has(pr.number)}
                      onSeen={markSeen}
                      teamFilterMembers={teamFilterMembers}
                    />
                  ))}
              </div>
            )
          )}
        </div>
      )}
    </>
  );
}

const STATE_ICON: Record<string, string> = {
  APPROVED: '✅',
  CHANGES_REQUESTED: '❌',
  COMMENTED: '👀',
  DISMISSED: '🚮',
};

function PrCard({
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
      <div className="pr-title">
        <span className="pr-num">#{pr.number}</span> {pr.title}
      </div>
      <div className="pr-bottom-row">
        <span className="age">
          {ageLabel(pr.createdAt)} - @{pr.author.login}
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
  );
}
