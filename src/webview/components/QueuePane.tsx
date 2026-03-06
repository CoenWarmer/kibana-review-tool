import { useState, useCallback, useRef } from 'react';
import { postMessage } from '../vscode';
import { ageLabel, reviewDecisionLabel, isReviewInProgress } from '../utils';
import type { GhPullRequest } from '../types';

interface Props {
  allPrs: GhPullRequest[];
  isLoading: boolean;
  errorMessage: string;
  needsReviewFilterActive: boolean;
  selectedPrNumber: number | null;
  userTeams: string[];
  teamFilter: string;
}

type Bucket = 'unreviewed' | 'in-review' | 'approved';

function classifyPr(pr: GhPullRequest): Bucket {
  if (pr.reviewDecision === 'APPROVED') return 'approved';
  if (isReviewInProgress(pr) || pr.reviewDecision === 'CHANGES_REQUESTED') return 'in-review';
  return 'unreviewed';
}

const byNewest = (a: GhPullRequest, b: GhPullRequest) =>
  new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

const BUCKETS: { key: Bucket; label: string }[] = [
  { key: 'unreviewed', label: 'Unreviewed' },
  { key: 'in-review',  label: 'In review' },
  { key: 'approved',   label: 'Approved' },
];

const SEEN_KEY = 'kibana-pr-reviewer.seenPrs';

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

export function QueuePane({ allPrs, isLoading, errorMessage, needsReviewFilterActive, selectedPrNumber, userTeams, teamFilter }: Props) {
  const [search, setSearch] = useState('');
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
    'unreviewed': false,
    'in-review': false,
    'approved': false,
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
    return pr.reviewRequests.some((r) => r.slug === bareSlug || r.name === bareSlug);
  };

  const visible = allPrs
    .filter((pr) => !pr.isDraft)
    .filter((pr) => !needsReviewFilterActive || classifyPr(pr) === 'unreviewed')
    .filter(matchesTeam);

  const total = visible.length;
  const buckets = BUCKETS.map(({ key, label }) => ({
    key,
    label,
    prs: visible.filter((pr) => classifyPr(pr) === key && matchesSearch(pr)).sort(byNewest),
  }));
  const totalFiltered = buckets.reduce((n, b) => n + b.prs.length, 0);

  if (isLoading) {
    return <div className="status loading"><span className="spin">⟳</span> Loading PRs…</div>;
  }
  if (errorMessage) {
    return <div className="status error"><div>✕</div><div>{errorMessage}</div></div>;
  }

  return (
    <>
      <div className="toolbar">
        <span className="count">
          {search || teamFilter ? `${totalFiltered} / ${total}` : `${total}`} PR{total === 1 ? '' : 's'}
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
        <button
          className={`filter-btn${needsReviewFilterActive ? ' active' : ''}`}
          title={needsReviewFilterActive ? 'Click to show all PRs' : 'Click to show only PRs that need a review'}
          onClick={() => postMessage({ type: 'toggleFilter' })}
        >
          {needsReviewFilterActive ? '⊘ Unreviewed only' : '⊙ All PRs'}
        </button>
      </div>
      {userTeams.length > 1 && (
        <div className="team-filter-bar">
          <select
            className="team-filter-select"
            value={teamFilter}
            onChange={(e) => postMessage({ type: 'setTeamFilter', team: e.target.value })}
          >
            <option value="">All teams</option>
            {userTeams.map((t) => (
              <option key={t} value={t}>{t.replace(/^@[^/]+\//, '')}</option>
            ))}
          </select>
        </div>
      )}

      {totalFiltered === 0 ? (
        <div className="status empty">
          {needsReviewFilterActive ? 'No unreviewed PRs' : 'No open PRs for your teams'}
        </div>
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
                  {label}
                  <span className="pr-bucket-count">{prs.length}</span>
                </div>
                {!collapsed[key] && prs.map((pr) => (
                  <PrCard
                    key={pr.number}
                    pr={pr}
                    selected={pr.number === selectedPrNumber}
                    isSeen={seen.has(pr.number)}
                    onSeen={markSeen}
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

function PrCard({ pr, selected, isSeen, onSeen }: {
  pr: GhPullRequest;
  selected: boolean;
  isSeen: boolean;
  onSeen: (n: number) => void;
}) {
  const rdClass = `rd-${(pr.reviewDecision || 'none').toLowerCase()}`;
  const inProgress = isReviewInProgress(pr);

  return (
    <div
      className={`pr-card${selected ? ' selected' : ''}${isSeen ? ' seen' : ''}`}
      onClick={() => { onSeen(pr.number); postMessage({ type: 'selectPR', prNumber: pr.number }); }}
    >
      <div className="pr-title">
        <span className="pr-num">#{pr.number}</span> {pr.title}
      </div>
      <div className="pr-bottom-row">
        <span className="age">{ageLabel(pr.createdAt)} - @{pr.author.login}</span>
        {inProgress && <span className="in-progress-badge">⚡ In review</span>}
        {!inProgress && <span className={`rd ${rdClass}`}>{reviewDecisionLabel(pr.reviewDecision)}</span>}
      </div>
    </div>
  );
}
