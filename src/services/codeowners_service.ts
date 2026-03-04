import * as vscode from 'vscode';
import type { GitHubService } from './github_service';

const CACHE_KEY_TEAMS = 'kibana-pr-reviewer.cachedUserTeams';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface TeamCache {
  teams: string[];
  fetchedAt: number;
}

// ─── CODEOWNERS parsing ───────────────────────────────────────────────────────

interface CodeOwnerRule {
  pattern: string;
  owners: string[];
}

function parseCodeOwners(content: string): CodeOwnerRule[] {
  const rules: CodeOwnerRule[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    rules.push({ pattern: parts[0], owners: parts.slice(1) });
  }
  return rules;
}

/**
 * Returns true if filePath is matched by a CODEOWNERS-style glob pattern.
 * Rules follow the gitignore spec subset used by GitHub CODEOWNERS:
 *   - Trailing `/` means "directory and all contents"
 *   - Leading `/` anchors to the repo root
 *   - `*` matches anything except `/`
 *   - `**` matches across directory boundaries
 *   - If no `/` in the pattern (besides trailing), it matches in any directory
 *   - A directory path without trailing `/` also matches all files inside it
 *     (per GitHub's CODEOWNERS spec — same as gitignore directory rules)
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  // Normalise: strip leading /
  const p = pattern.startsWith('/') ? pattern.slice(1) : pattern;

  // Trailing / → match any file under that directory
  if (p.endsWith('/')) {
    return filePath.startsWith(p);
  }

  // Convert glob syntax to a regex
  const escaped = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars
    .replace(/\*\*/g, '\x00')              // placeholder for **
    .replace(/\*/g, '[^/]*')              // * → match within a segment
    .replace(/\x00/g, '.*');              // ** → match across segments

  // If the original pattern had no directory component and wasn't anchored,
  // it can match a filename at any depth.
  const anchored = pattern.startsWith('/') || pattern.includes('/');
  const regex = anchored
    ? new RegExp(`^${escaped}(/.*)?$`)    // allow optional sub-path after a directory match
    : new RegExp(`(^|/)${escaped}(/.*)?$`);

  return regex.test(filePath);
}

/**
 * Returns the owners for filePath according to the CODEOWNERS rules.
 * Later rules take precedence (as per the GitHub spec).
 */
function getOwnersForPath(filePath: string, rules: CodeOwnerRule[]): string[] {
  let owners: string[] = [];
  for (const rule of rules) {
    if (matchesPattern(filePath, rule.pattern)) {
      owners = rule.owners;
    }
  }
  return owners;
}

export class CodeOwnersService {
  private cachedRules: CodeOwnerRule[] | null = null;

  constructor(
    private readonly githubService: GitHubService,
    private readonly context: vscode.ExtensionContext
  ) {}

  /**
   * Returns the @elastic/team-name slugs the current GitHub user belongs to.
   * Checks settings override first, then GitHub API (with cache).
   */
  async getUserTeams(): Promise<string[]> {
    const config = vscode.workspace.getConfiguration('kibana-pr-reviewer');
    const override: string[] = config.get('userTeams') ?? [];

    if (override.length > 0) {
      return override;
    }

    return this.fetchAndCacheTeams();
  }

  /**
   * Given a list of PR requested-team slugs from gh CLI output, returns true if
   * any of them matches one of the user's teams.
   */
  async isRequestedFromUserTeam(
    reviewRequests: Array<{ slug?: string }>
  ): Promise<boolean> {
    const userTeams = await this.getUserTeams();
    if (userTeams.length === 0) {
      return false;
    }

    return reviewRequests.some((r) => {
      if (!r.slug) return false;
      const full = `@elastic/${r.slug}`;
      return userTeams.some(
        (ut) => ut.toLowerCase() === full.toLowerCase()
      );
    });
  }

  /**
   * Forces a fresh fetch of team memberships, bypassing cache.
   */
  async refreshTeams(): Promise<string[]> {
    return this.fetchAndCacheTeams(true);
  }

  clearCache(): void {
    void this.context.globalState.update(CACHE_KEY_TEAMS, undefined);
    this.cachedRules = null;
  }

  /**
   * Filters filePaths to only those owned by one of the current user's teams,
   * according to the workspace's .github/CODEOWNERS file.
   * Returns all paths unchanged if CODEOWNERS cannot be read.
   */
  async getOwnedFiles(filePaths: string[]): Promise<string[]> {
    const userTeams = await this.getUserTeams();
    if (userTeams.length === 0) return filePaths;

    const rules = await this.loadCodeOwnerRules();
    if (rules.length === 0) return filePaths;

    // Normalise team slugs for comparison: strip leading @ and lowercase
    const normalise = (t: string) => t.replace(/^@/, '').toLowerCase();
    const myTeams = new Set(userTeams.map(normalise));

    return filePaths.filter((path) => {
      const owners = getOwnersForPath(path, rules);
      return owners.some((owner) => myTeams.has(normalise(owner)));
    });
  }

  private async loadCodeOwnerRules(): Promise<CodeOwnerRule[]> {
    if (this.cachedRules) return this.cachedRules;

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return [];

    const uri = vscode.Uri.joinPath(folders[0].uri, '.github', 'CODEOWNERS');
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.cachedRules = parseCodeOwners(Buffer.from(bytes).toString('utf8'));
      return this.cachedRules;
    } catch {
      return [];
    }
  }

  private async fetchAndCacheTeams(forceRefresh = false): Promise<string[]> {
    if (!forceRefresh) {
      const cached = this.getFromCache();
      if (cached) {
        return cached;
      }
    }

    try {
      const repo = vscode.workspace
        .getConfiguration('kibana-pr-reviewer')
        .get<string>('repo', 'elastic/kibana');
      const orgName = repo.split('/')[0];

      const teams = await this.githubService.getUserTeams(orgName);

      if (teams.length === 0) {
        void vscode.window.showWarningMessage(
          `Kibana PR Reviewer: No teams found for your GitHub account in the "${orgName}" org. ` +
            `Set kibana-pr-reviewer.userTeams in settings to override (e.g. ["@elastic/obs-onboarding-team"]).`
        );
      }

      this.saveToCache(teams);
      return teams;
    } catch (err) {
      void vscode.window.showWarningMessage(
        `Kibana PR Reviewer: Could not fetch team memberships — ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Set kibana-pr-reviewer.userTeams in settings to override.`
      );
      return [];
    }
  }

  private getFromCache(): string[] | null {
    const raw = this.context.globalState.get<TeamCache>(CACHE_KEY_TEAMS);
    if (!raw) {
      return null;
    }
    if (Date.now() - raw.fetchedAt > CACHE_TTL_MS) {
      return null;
    }
    return raw.teams;
  }

  private saveToCache(teams: string[]): void {
    void this.context.globalState.update(CACHE_KEY_TEAMS, {
      teams,
      fetchedAt: Date.now(),
    } satisfies TeamCache);
  }
}
