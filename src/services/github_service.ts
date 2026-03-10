import { execFile } from 'child_process';
import { promisify } from 'util';
import { log, logJson } from '../logger';

const execFileAsync = promisify(execFile);

/** Runs an array of async task factories with at most `limit` running at once. */
async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = [];
  let i = 0;
  const run = async (): Promise<void> => {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, run));
  return results;
}

export interface GhReviewRequest {
  login?: string; // present for user reviewers
  name?: string; // present for team reviewers
  slug?: string; // present for team reviewers
}

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | '';

export type TeamReviewStatus = 'APPROVED' | 'CHANGES_REQUESTED' | 'IN_PROGRESS' | 'PENDING';

export interface GhReview {
  author: { login: string };
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submittedAt: string;
}

export interface TeamReviewInfo {
  status: TeamReviewStatus;
  /** Present when status is APPROVED or CHANGES_REQUESTED */
  reviewer?: { login: string; submittedAt: string };
  /** All team members who have reviewed (IN_PROGRESS state); supersedes the single reviewer field. */
  reviewers?: Array<{ login: string; submittedAt: string }>;
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
  /** The head branch tip commit SHA — included on list fetches so the webview can detect new commits. */
  headRefOid?: string;
  baseRefName: string;
  /** The base branch tip commit SHA — present on detail fetches, absent on list items. */
  baseRefOid?: string;
  /** Combined list of requested user and team reviewers */
  reviewRequests: GhReviewRequest[];
  /** Overall review decision. Empty string means no review has been submitted yet. */
  reviewDecision: ReviewDecision;
  author: { login: string };
  url: string;
  latestReviews: GhReview[];
  /** Users assigned to the PR */
  assignees?: Array<{ login: string; name?: string }>;
  /** Number of issue-level comments on the PR */
  comments?: number;
  /** Per-team review info; populated by getPullRequestDetail, absent on list items. */
  teamReviewStatuses?: Record<string, TeamReviewInfo>;
}

/**
 * Returns true if there is evidence that someone *other than the PR author*
 * has already started reviewing this PR — assigned, or submitted any review activity.
 */
const BOT_LOGINS = new Set(['coderabbitai', 'coderabbitai[bot]', 'elasticmachine']);

export function isReviewInProgress(pr: GhPullRequest): boolean {
  const authorLogin = pr.author.login;
  const isHuman = (login: string) => login !== authorLogin && !BOT_LOGINS.has(login);
  // Only count assignees who are not the PR author (authors often self-assign)
  if (pr.assignees?.some((a) => isHuman(a.login))) return true;
  if (pr.latestReviews.some((r) => r.state !== 'PENDING' && isHuman(r.author.login))) return true;
  return false;
}

export interface GhPRLineComment {
  id: number;
  /** Set when this comment is a reply; refers to the root comment's id */
  in_reply_to_id?: number;
  body: string;
  path: string;
  /** Line number in the head (RIGHT) version of the file */
  line?: number;
  /** Line number in the base (LEFT) version of the file */
  original_line?: number;
  side?: 'LEFT' | 'RIGHT';
  original_side?: 'LEFT' | 'RIGHT';
  user: { login: string };
  created_at: string;
}

/** A general PR comment, review, or commit push event merged into a single timeline type. */
export interface GhDiscussionComment {
  id: string | number;
  author: string;
  avatarUrl?: string;
  body: string;
  createdAt: string;
  /** 'comment' = issue comment; 'review' = approve/request-changes/comment review; 'commit' = pushed commit */
  kind: 'comment' | 'review' | 'commit';
  reviewState?: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
  /** Short (7-char) commit SHA — only set when kind === 'commit'. */
  commitSha?: string;
}

export interface GhPullRequestFile {
  path: string;
  additions: number;
  deletions: number;
  /** REST API field (lowercase). May be absent when data comes from GraphQL. */
  status?: 'added' | 'modified' | 'deleted' | 'renamed' | string;
  /** GraphQL API field (uppercase: ADDED, MODIFIED, DELETED, RENAMED, COPIED). */
  changeType?: string;
}

export interface GhPullRequestDetail extends GhPullRequest {
  files: GhPullRequestFile[];
}

async function runGh(args: readonly string[], cwd?: string): Promise<string> {
  log(`gh ${args.join(' ')}`);
  try {
    const { stdout } = await execFileAsync('gh', args, {
      env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' },
      maxBuffer: 20 * 1024 * 1024,
      ...(cwd ? { cwd } : {}),
    });
    const result = stdout.trim();
    log(`  → ${result.length} chars returned`);
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`  ✗ ERROR: ${message}`);
    throw new Error(`gh ${args[0]} failed: ${message}`);
  }
}

export class GitHubService {
  constructor(private readonly repo: string) {}

  /** Cached team member logins — keyed by "org/slug". */
  private readonly teamMemberCache = new Map<string, string[]>();

  /** Short-lived cache for PR detail to avoid redundant back-to-back fetches. */
  private readonly detailCache = new Map<number, { detail: GhPullRequestDetail; ts: number }>();
  private readonly DETAIL_CACHE_TTL_MS = 60_000;

  /**
   * Returns the GitHub logins of all members of a team.
   * Accepts both "org/slug" and bare "slug" formats.
   * Results are cached for the lifetime of this service instance.
   */
  async getTeamMemberLogins(org: string, teamSlug: string): Promise<string[]> {
    // Strip leading org prefix if present (e.g. "elastic/obs-team" → "obs-team")
    const bareSlug = teamSlug.includes('/') ? teamSlug.split('/').pop()! : teamSlug;
    const key = `${org}/${bareSlug}`;
    const cached = this.teamMemberCache.get(key);
    if (cached) return cached;

    try {
      const raw = await runGh([
        'api',
        `/orgs/${org}/teams/${bareSlug}/members`,
        '--jq',
        '[.[].login]',
      ]);
      const members = JSON.parse(raw) as string[];
      this.teamMemberCache.set(key, members);
      log(`Team ${key}: ${members.length} member(s) cached`);
      return members;
    } catch (err) {
      log(
        `Could not fetch members for ${key}: ${err instanceof Error ? err.message : String(err)}`
      );
      this.teamMemberCache.set(key, []); // cache empty so we don't retry every call
      return [];
    }
  }

  /**
   * Fetches open PRs where any of the given teams is (or was) a requested reviewer.
   *
   * Uses two complementary query strategies to ensure full coverage:
   * - `team-review-requested:org/team` — catches PRs where the team review is still pending.
   *   GitHub removes a team from this qualifier once any member submits a review, so
   *   PRs that have been partially or fully reviewed would otherwise disappear.
   * - `reviewed-by:<member_login>` — catches PRs that fell off the primary query because
   *   a team member already reviewed them. One query per member is run in parallel.
   *
   * Runs queries per team so that a single unresolvable team (e.g. a huge
   * org-wide team like "employees") cannot poison the results for all others.
   *
   * Team slugs must be in "@org/team-name" format, e.g. "@elastic/obs-onboarding-team".
   */
  async listOpenPRsForTeams(teamSlugs: string[]): Promise<GhPullRequest[]> {
    if (teamSlugs.length === 0) {
      log('No teams provided — cannot fetch team PRs');
      return [];
    }

    // Filter to teams that look like functional code-owner teams.
    // Org-wide teams (employees, engineering, etc.) match no code in CODEOWNERS
    // and cause GitHub search to return empty results when included.
    const SKIP_TEAMS = new Set(['employees', 'engineering', 'staff', 'all-elastic']);
    const codeOwnerTeams = teamSlugs.filter((t) => {
      const slug = t.replace(/^@[^/]+\//, ''); // strip "@org/" → bare slug
      if (SKIP_TEAMS.has(slug)) {
        log(`Skipping generic team: ${t}`);
        return false;
      }
      return true;
    });

    if (codeOwnerTeams.length === 0) {
      log(
        'All detected teams are generic — no code-owner teams to query. Configure elastic-pr-reviewer.userTeams manually.'
      );
      return [];
    }

    const JSON_FIELDS =
      'number,title,body,isDraft,additions,deletions,createdAt,headRefName,headRefOid,baseRefName,reviewRequests,reviewDecision,author,url,latestReviews,assignees,comments';

    const ghSearch = async (searchQuery: string): Promise<GhPullRequest[]> => {
      try {
        const raw = await runGh([
          'pr',
          'list',
          '--repo',
          this.repo,
          '--state',
          'open',
          '--search',
          searchQuery,
          '--json',
          JSON_FIELDS,
          '--limit',
          '200',
        ]);
        const prs = JSON.parse(raw) as GhPullRequest[];
        log(`  → ${prs.length} PRs for "${searchQuery}"`);
        return prs;
      } catch (err) {
        log(`  ✗ Query failed for "${searchQuery}": ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    };

    // PRIMARY: team-review-requested persists while the review request is open,
    // but GitHub removes it once any team member submits a review.
    // SECONDARY: reviewed-by:<member> catches PRs that fell off the primary query
    // because a team member already reviewed them.
    const primaryQueries = codeOwnerTeams.map((teamSlug) => {
      const teamRef = teamSlug.replace(/^@/, '');
      return () => ghSearch(`team-review-requested:${teamRef}`);
    });

    // Fetch members for all teams concurrently, then build per-member queries.
    const teamMemberSets = await Promise.all(
      codeOwnerTeams.map(async (teamSlug) => {
        const [org, ...rest] = teamSlug.replace(/^@/, '').split('/');
        const bareSlug = rest.join('/');
        return this.getTeamMemberLogins(org, bareSlug);
      })
    );
    const allMembers = [...new Set(teamMemberSets.flat())];
    const secondaryQueries = allMembers.map(
      (login) => () => ghSearch(`reviewed-by:${login}`)
    );

    // Run all queries with a concurrency cap to stay within GitHub rate limits.
    const allResults = await runWithConcurrency([...primaryQueries, ...secondaryQueries], 6);
    const perTeamResults = allResults;

    // Merge and deduplicate by PR number (a PR can match multiple teams)
    const seen = new Set<number>();
    const merged: GhPullRequest[] = [];
    for (const prs of perTeamResults) {
      for (const pr of prs) {
        if (!seen.has(pr.number)) {
          seen.add(pr.number);
          merged.push(pr);
        }
      }
    }

    // Newest first
    merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    log(`Total unique PRs across all teams: ${merged.length}`);
    if (merged.length > 0) {
      logJson('First PR sample', {
        number: merged[0].number,
        title: merged[0].title,
        reviewRequests: merged[0].reviewRequests,
        reviewDecision: merged[0].reviewDecision,
      });
    }
    return merged;
  }

  async getPullRequestFiles(prNumber: number): Promise<GhPullRequestFile[]> {
    const [owner, repoName] = this.repo.split('/');
    return this.fetchPrFiles(owner, repoName, prNumber);
  }

  /**
   * Fetches all pages of a GitHub REST API endpoint that returns a JSON array.
   *
   * `gh api --paginate` concatenates raw JSON arrays as `[...][...]` which is
   * invalid JSON. Using `--jq '.[]'` instead outputs each item on its own line
   * (NDJSON), which we then parse line-by-line and collect into a single array.
   */
  private async fetchAllPages<T>(apiPath: string, perPage = 100): Promise<T[]> {
    const raw = await runGh(['api', '--paginate', '--jq', '.[]', `${apiPath}?per_page=${perPage}`]);
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  }

  /**
   * Fetches all pages of PR files from the REST API and normalises the shape.
   *
   * The REST API returns `filename` instead of `path` (the GraphQL field name).
   * We remap it here so the rest of the codebase can use `path` consistently.
   */
  private async fetchPrFiles(
    owner: string,
    repoName: string,
    prNumber: number
  ): Promise<GhPullRequestFile[]> {
    interface RestFile {
      filename: string;
      additions: number;
      deletions: number;
      status?: string;
    }
    const items = await this.fetchAllPages<RestFile>(
      `repos/${owner}/${repoName}/pulls/${prNumber}/files`
    );
    return items.map((f) => ({
      path: f.filename,
      additions: f.additions,
      deletions: f.deletions,
      status: f.status,
    }));
  }

  /** Invalidates the cached detail for a PR (e.g. after posting a comment or review). */
  invalidateDetailCache(prNumber: number): void {
    this.detailCache.delete(prNumber);
  }

  async getPullRequestDetail(prNumber: number): Promise<GhPullRequestDetail> {
    // Return cached result if still fresh — avoids redundant back-to-back fetches
    // (e.g. fetchAndUpdateDetail + refreshFilesAndComments running concurrently).
    const cached = this.detailCache.get(prNumber);
    if (cached && Date.now() - cached.ts < this.DETAIL_CACHE_TTL_MS) {
      log(`getPullRequestDetail #${prNumber}: returning cached result (age ${Date.now() - cached.ts}ms)`);
      return cached.detail;
    }

    const org = this.repo.split('/')[0];
    const [owner, repoName] = this.repo.split('/');

    // Fetch PR data and issue events in parallel.
    // Issue events give us the FULL history of review_requested events — teams
    // that have already reviewed are removed from `reviewRequests` by GitHub,
    // but their review_requested event is permanent.
    const [prRaw, eventsRaw, filesRaw] = await Promise.all([
      runGh([
        'pr',
        'view',
        String(prNumber),
        '--repo',
        this.repo,
        '--json',
        // `files` intentionally omitted — fetched separately via paginated REST API below
        'number,title,body,isDraft,additions,deletions,createdAt,headRefName,baseRefName,reviewRequests,reviewDecision,author,url,latestReviews',
      ]),
      // Fetch without --jq / --paginate so there are no format or version surprises;
      // parse team slugs from the raw JSON in TypeScript instead.
      runGh(['api', `repos/${owner}/${repoName}/issues/${prNumber}/events?per_page=100`]).catch(
        (err) => {
          log(
            `Could not fetch issue events for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`
          );
          return '[]';
        }
      ),
      // Fetch all changed files via the paginated REST API.
      // `gh pr view --json files` silently caps at 100 files; this supports up to 3000.
      this.fetchPrFiles(owner, repoName, prNumber).catch((err) => {
        log(
          `Could not fetch files for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`
        );
        return [] as GhPullRequestFile[];
      }),
    ]);

    const pr = JSON.parse(prRaw) as GhPullRequestDetail;
    pr.files = filesRaw;

    // Extract bare team slugs from review_requested events.
    interface IssueEvent {
      event: string;
      requested_team?: { slug?: string } | null;
    }
    const events = JSON.parse(eventsRaw) as IssueEvent[];
    const eventTeamSlugs = events
      .filter((e) => e.event === 'review_requested' && e.requested_team?.slug)
      .map((e) => e.requested_team!.slug!);
    log(
      `PR #${prNumber}: ${eventTeamSlugs.length} team review_requested event(s): ${eventTeamSlugs.join(', ') || '(none)'}`
    );

    // Normalise everything to "org/bareSlug" so keys are stable and display-ready.
    const normalise = (slug: string) => (slug.includes('/') ? slug : `${org}/${slug}`);

    const allTeamSlugs = new Set<string>([
      ...eventTeamSlugs.map(normalise),
      ...pr.reviewRequests.filter((r) => r.slug).map((r) => normalise(r.slug!)),
    ]);

    if (allTeamSlugs.size > 0) {
      // Build login → review maps for each decision type
      const reviews = pr.latestReviews ?? [];
      const reviewByLogin = new Map(
        reviews
          .filter((r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')
          .map((r) => [r.author.login, r])
      );
      const commentedByLogin = new Map(
        reviews
          .filter((r) => r.state === 'COMMENTED' && r.author.login !== pr.author.login)
          .map((r) => [r.author.login, r])
      );

      const statuses: Record<string, TeamReviewInfo> = {};
      await Promise.all(
        [...allTeamSlugs].map(async (fullSlug) => {
          const members = await this.getTeamMemberLogins(org, fullSlug);
          const approver = members
            .map((m) => reviewByLogin.get(m))
            .find((r) => r?.state === 'APPROVED');
          const blocker = members
            .map((m) => reviewByLogin.get(m))
            .find((r) => r?.state === 'CHANGES_REQUESTED');
          // Collect ALL commenters from this team, not just the first one.
          const commenters = members
            .map((m) => commentedByLogin.get(m))
            .filter((r): r is NonNullable<typeof r> => r !== undefined);

          if (approver) {
            statuses[fullSlug] = {
              status: 'APPROVED',
              reviewer: { login: approver.author.login, submittedAt: approver.submittedAt },
            };
          } else if (blocker) {
            statuses[fullSlug] = {
              status: 'CHANGES_REQUESTED',
              reviewer: { login: blocker.author.login, submittedAt: blocker.submittedAt },
            };
          } else if (commenters.length > 0) {
            statuses[fullSlug] = {
              status: 'IN_PROGRESS',
              // Keep legacy single-reviewer field pointing at the first commenter.
              reviewer: {
                login: commenters[0].author.login,
                submittedAt: commenters[0].submittedAt,
              },
              reviewers: commenters.map((r) => ({
                login: r.author.login,
                submittedAt: r.submittedAt,
              })),
            };
          } else {
            statuses[fullSlug] = { status: 'PENDING' };
          }
        })
      );

      pr.teamReviewStatuses = statuses;
    }

    this.detailCache.set(prNumber, { detail: pr, ts: Date.now() });
    return pr;
  }

  async checkoutPullRequest(prNumber: number): Promise<void> {
    await runGh(['pr', 'checkout', String(prNumber), '--repo', this.repo]);
  }

  async getCurrentUser(): Promise<string> {
    const raw = await runGh(['api', 'user', '--jq', '.login']);
    return raw.trim();
  }

  async getUserTeams(orgName: string): Promise<string[]> {
    // /user/teams returns only the teams the authenticated user belongs to,
    // filtered to the given org. orgs/{org}/teams requires admin access.
    log(`Fetching user teams for org "${orgName}" via /user/teams`);
    const raw = await runGh([
      'api',
      '/user/teams',
      '--paginate',
      '--jq',
      `.[] | select(.organization.login == "${orgName}") | .slug`,
    ]);
    const teams = raw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((slug) => `@${orgName}/${slug}`);
    log(`Detected teams: ${teams.length > 0 ? teams.join(', ') : '(none)'}`);
    return teams;
  }

  async isGhAuthenticated(): Promise<boolean> {
    try {
      await runGh(['auth', 'status']);
      return true;
    } catch {
      return false;
    }
  }

  async getPRBaseCommit(prNumber: number): Promise<string> {
    const raw = await runGh([
      'pr',
      'view',
      String(prNumber),
      '--repo',
      this.repo,
      '--json',
      'baseRefOid',
      '--jq',
      '.baseRefOid',
    ]);
    return raw.trim();
  }

  async submitReview(
    prNumber: number,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
    body?: string
  ): Promise<void> {
    const [owner, repo] = this.repo.split('/');
    const args = [
      'api',
      `repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      '--method',
      'POST',
      '-f',
      `event=${event}`,
    ];
    if (body?.trim()) {
      args.push('-f', `body=${body.trim()}`);
    }
    await runGh(args);
  }

  async postComment(prNumber: number, body: string): Promise<void> {
    await runGh(['pr', 'comment', String(prNumber), '--repo', this.repo, '--body', body]);
  }

  /**
   * Posts an inline review comment on a specific line of a PR diff.
   *
   * @param headSha  - The PR's head commit SHA (use `git rev-parse HEAD` after checkout)
   * @param filePath - Repo-relative file path (e.g. `src/plugins/foo/index.ts`)
   * @param line     - 1-indexed line number in the file
   * @param side     - `RIGHT` for the new/head version, `LEFT` for the base version
   * @param body     - Comment markdown text
   */
  /**
   * Returns the open PR associated with the current git branch, or null if
   * the branch has no associated PR in the configured repo.
   *
   * `cwd` must be the workspace root so that `gh` can read the current branch
   * from the local git repo. Without it, `gh pr view` runs in the wrong
   * directory and cannot detect which branch is checked out.
   */
  async getPRForCurrentBranch(cwd: string): Promise<GhPullRequest | null> {
    const JSON_FIELDS =
      'number,title,body,isDraft,additions,deletions,createdAt,headRefName,headRefOid,baseRefName,reviewRequests,reviewDecision,author,url,latestReviews,assignees,comments';
    log(`[getPRForCurrentBranch] cwd=${cwd}`);

    // gh pr view requires an explicit argument when --repo is set.
    // Resolve the current branch name from git first.
    let branch: string;
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd });
      branch = stdout.trim();
      log(`[getPRForCurrentBranch] current branch = "${branch}"`);
      if (!branch) {
        log('[getPRForCurrentBranch] Detached HEAD — no branch to look up');
        return null;
      }
    } catch (err) {
      log(
        `[getPRForCurrentBranch] git branch failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }

    // Use `gh pr list --head <branch>` rather than `gh pr view <branch>`.
    // `gh pr view` only matches branches on the base repo; fork PRs
    // (head = "user:branch") are invisible to it. `gh pr list --head`
    // matches by head branch name regardless of which fork it comes from.
    try {
      const raw = await runGh(
        [
          'pr',
          'list',
          '--head',
          branch,
          '--repo',
          this.repo,
          '--state',
          'open',
          '--json',
          JSON_FIELDS,
          '--limit',
          '1',
        ],
        cwd
      );
      const results = JSON.parse(raw) as GhPullRequest[];
      if (results.length === 0) {
        log(`[getPRForCurrentBranch] No open PR for branch "${branch}"`);
        return null;
      }
      const pr = results[0];
      // Ignore fork PRs where the head branch name matches the base branch name
      // (e.g. alvintuo:main → elastic:main). These would never be the result of
      // `gh pr checkout` because checking out such a PR would conflict with the
      // user's own local base branch.
      if (pr.headRefName === pr.baseRefName) {
        log(
          `[getPRForCurrentBranch] Skipping PR #${pr.number} — headRefName "${pr.headRefName}" equals baseRefName (fork-on-base-branch false positive)`
        );
        return null;
      }
      log(`[getPRForCurrentBranch] Found PR #${pr.number} "${pr.title}"`);
      return pr;
    } catch (err) {
      log(
        `[getPRForCurrentBranch] gh pr list failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  /**
   * Fetches all inline review comments for a PR.
   * Returns up to 100 comments (sufficient for nearly all PRs).
   */
  async getLineComments(prNumber: number): Promise<GhPRLineComment[]> {
    const [owner, repo] = this.repo.split('/');
    const raw = await runGh([
      'api',
      `repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`,
    ]);
    return JSON.parse(raw) as GhPRLineComment[];
  }

  async postLineComment(
    prNumber: number,
    headSha: string,
    filePath: string,
    line: number,
    side: 'LEFT' | 'RIGHT',
    body: string
  ): Promise<void> {
    const [owner, repo] = this.repo.split('/');
    await runGh([
      'api',
      `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      '--method',
      'POST',
      '-f',
      `body=${body}`,
      '-f',
      `commit_id=${headSha}`,
      '-f',
      `path=${filePath}`,
      '-F',
      `line=${line}`,
      '-f',
      `side=${side}`,
    ]);
  }

  /**
   * Fetches the general discussion timeline for a PR: issue-level comments,
   * review summaries with a body, and commit push events. Sorted oldest-first.
   */
  async getDiscussionComments(prNumber: number): Promise<GhDiscussionComment[]> {
    const [owner, repo] = this.repo.split('/');

    const [issueRaw, reviewsRaw, commitsRaw] = await Promise.all([
      runGh(['api', `repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`]),
      runGh(['api', `repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`]),
      runGh(['api', `repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100`]),
    ]);

    type IssueComment = {
      id: number;
      user: { login: string; avatar_url?: string };
      body: string;
      created_at: string;
    };
    type Review = {
      id: number;
      user: { login: string; avatar_url?: string };
      body: string;
      submitted_at: string;
      state: string;
    };
    type Commit = {
      sha: string;
      commit: {
        message: string;
        author: { name: string; date: string };
      };
      /** Top-level author is the GitHub user; may be null for unlinked commits. */
      author: { login: string; avatar_url?: string } | null;
    };

    const issueComments: GhDiscussionComment[] = (JSON.parse(issueRaw) as IssueComment[])
      .filter((c) => c.body?.trim())
      .map((c) => ({
        id: c.id,
        author: c.user.login,
        avatarUrl: c.user.avatar_url,
        body: c.body,
        createdAt: c.created_at,
        kind: 'comment' as const,
      }));

    const reviewComments: GhDiscussionComment[] = (JSON.parse(reviewsRaw) as Review[])
      .filter((r) => r.body?.trim())
      .map((r) => ({
        id: r.id,
        author: r.user.login,
        avatarUrl: r.user.avatar_url,
        body: r.body,
        createdAt: r.submitted_at,
        kind: 'review' as const,
        reviewState: r.state as GhDiscussionComment['reviewState'],
      }));

    const commitItems: GhDiscussionComment[] = (JSON.parse(commitsRaw) as Commit[]).map((c) => {
      const shortSha = c.sha.slice(0, 7);
      return {
        id: `commit-${shortSha}`,
        author: c.author?.login ?? c.commit.author.name,
        avatarUrl: c.author?.avatar_url,
        // Store the full message so the UI can show it on hover.
        body: c.commit.message.trim(),
        createdAt: c.commit.author.date,
        kind: 'commit' as const,
        commitSha: shortSha,
      };
    });

    return [...issueComments, ...reviewComments, ...commitItems].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }
}
