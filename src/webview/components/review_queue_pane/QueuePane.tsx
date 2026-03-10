import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { postMessage } from '../../vscode';
import { isReviewInProgress } from '../../utils';
import type { GhPullRequest } from '../../types';
import { Spinner } from '../Spinner';
import { PrCard } from './PRCard';
import { PersonIcon } from '../icons/PersonIcon';

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

type Bucket = 'unreviewed' | 'in-review-by-you' | 'in-review' | 'approved';

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

  // Track head commit SHAs to detect new commits since last visit.
  const [shaMap, setShaMap] = useState<Record<number, string>>(() => loadShaMap());
  const shaMapRef = useRef(shaMap);
  shaMapRef.current = shaMap;

  // Auto-record SHA for PRs we've never seen before (no dot on first visit).
  useEffect(() => {
    const additions: Record<number, string> = {};
    for (const pr of allPrs) {
      if (pr.headRefOid && !(pr.number in shaMapRef.current)) {
        additions[pr.number] = pr.headRefOid;
      }
    }
    if (Object.keys(additions).length === 0) return;
    setShaMap((prev) => {
      const next = { ...prev, ...additions };
      saveShaMap(next);
      return next;
    });
  }, [allPrs]);

  // PRs whose head SHA changed since last user visit.
  const updatedPrs = useMemo(() => {
    const set = new Set<number>();
    for (const pr of allPrs) {
      if (!pr.headRefOid) continue;
      const stored = shaMap[pr.number];
      if (stored !== undefined && stored !== pr.headRefOid) {
        set.add(pr.number);
      }
    }
    return set;
  }, [allPrs, shaMap]);

  // Called by PrCard on click — persists the current SHA so the dot disappears.
  const onShaUpdate = useCallback((prNumber: number, sha: string) => {
    setShaMap((prev) => {
      const next = { ...prev, [prNumber]: sha };
      saveShaMap(next);
      return next;
    });
  }, []);

  const [collapsed, setCollapsed] = useState<Record<Bucket, boolean>>({
    unreviewed: false,
    'in-review-by-you': false,
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
  const buckets = BUCKETS.map(({ key, label, teamSuffix }) => ({
    key,
    label: teamLabel && teamSuffix ? `${label} by ${teamLabel}` : label,
    prs: visible
      .filter(
        (pr) => classifyPr(pr, teamFilterMembers, currentUserLogin) === key && matchesSearch(pr)
      )
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
          <PersonIcon color="#C5C5C5" width={16} height={16} />
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
                      hasNewCommits={updatedPrs.has(pr.number)}
                      onShaUpdate={onShaUpdate}
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

/**
 * Classify a PR into a bucket.
 *
 * Priority (highest wins):
 *  1. "Approved"          — team has approved (or reviewDecision === APPROVED).
 *  2. "In review by you"  — the current user has a COMMENTED or CHANGES_REQUESTED
 *                           review on this PR (they've started, not finished).
 *  3. "In review"         — at least one other team member has a non-pending review,
 *                           OR the PR is assigned to a team member.
 *  4. "Unreviewed"        — no team activity yet.
 *
 * When a team is selected and its member logins are known, "Approved" and
 * "In review" are scoped to that team; "In review by you" always uses the
 * current user regardless of team filter.
 */
function classifyPr(pr: GhPullRequest, teamMembers: string[], currentUserLogin: string): Bucket {
  const allReviews = pr.latestReviews ?? [];

  if (teamMembers.length > 0) {
    const memberSet = new Set(teamMembers);
    const teamReviews = allReviews.filter(
      (r) => r.state !== 'PENDING' && memberSet.has(r.author.login)
    );
    if (teamReviews.some((r) => r.state === 'APPROVED')) return 'approved';

    // "In review by you" — current user has a non-approved, non-pending review.
    if (currentUserLogin) {
      const myReview = allReviews.find(
        (r) =>
          r.author.login === currentUserLogin && r.state !== 'PENDING' && r.state !== 'APPROVED'
      );
      if (myReview) return 'in-review-by-you';
    }

    const hasTeamAssignee = (pr.assignees ?? []).some((a) => memberSet.has(a.login));
    if (teamReviews.length > 0 || hasTeamAssignee) return 'in-review';
    return 'unreviewed';
  }

  // Fallback: generic heuristic (no team selected, or members not yet fetched)
  if (pr.reviewDecision === 'APPROVED') return 'approved';

  if (currentUserLogin) {
    const myReview = allReviews.find(
      (r) => r.author.login === currentUserLogin && r.state !== 'PENDING' && r.state !== 'APPROVED'
    );
    if (myReview) return 'in-review-by-you';
  }

  if (isReviewInProgress(pr) || pr.reviewDecision === 'CHANGES_REQUESTED') return 'in-review';
  return 'unreviewed';
}

const byNewest = (a: GhPullRequest, b: GhPullRequest) =>
  new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

const BUCKETS: { key: Bucket; label: string; teamSuffix: boolean }[] = [
  { key: 'in-review-by-you', label: 'In review by you', teamSuffix: false },
  { key: 'unreviewed', label: 'Unreviewed', teamSuffix: true },
  { key: 'in-review', label: 'In review', teamSuffix: true },
  { key: 'approved', label: 'Approved', teamSuffix: true },
];

const SEEN_KEY = 'elastic-pr-reviewer.seenPrs';
const SHOW_OWN_KEY = 'elastic-pr-reviewer.showOwnPrs';
const SHA_MAP_KEY = 'elastic-pr-reviewer.prHeadShas';

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

function loadShaMap(): Record<number, string> {
  try {
    const raw = localStorage.getItem(SHA_MAP_KEY);
    return raw ? (JSON.parse(raw) as Record<number, string>) : {};
  } catch {
    return {};
  }
}

function saveShaMap(map: Record<number, string>): void {
  try {
    localStorage.setItem(SHA_MAP_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}
