import * as https from 'https';
import * as vscode from 'vscode';
import type { GhPullRequestFile } from './github_service';

export interface OrderedFile extends GhPullRequestFile {
  group: string;
  tier: number;
}

/** Pattern tiers — lower tier = shown first in review order */
const HEURISTIC_TIERS: Array<{ tier: number; group: string; test: (path: string) => boolean }> = [
  {
    tier: 1,
    group: 'Core implementation',
    test: (path) => {
      const isSource =
        /\.(ts|tsx|js|jsx|py|go|java|rb|rs|cs)$/.test(path) &&
        !/\.(test|spec|stories|mock)\.(ts|tsx|js|jsx)$/.test(path) &&
        !path.includes('/__fixtures__/') &&
        !path.includes('/fixtures/') &&
        !path.includes('/mocks/');
      const isInSourceDir =
        path.startsWith('src/') ||
        path.startsWith('packages/') ||
        path.startsWith('x-pack/') ||
        path.startsWith('examples/');
      return isSource && isInSourceDir;
    },
  },
  {
    tier: 2,
    group: 'Entry points & APIs',
    test: (path) => {
      const fileName = path.split('/').pop() ?? '';
      return (
        fileName === 'index.ts' ||
        fileName === 'index.tsx' ||
        fileName === 'plugin.ts' ||
        fileName === 'plugin.tsx' ||
        path.includes('/routes/') ||
        path.includes('/api/') ||
        path.includes('/server/') ||
        path.includes('/public/')
      );
    },
  },
  {
    tier: 3,
    group: 'Supporting / utility',
    test: (path) =>
      /\.(ts|tsx|js|jsx)$/.test(path) &&
      !/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(path),
  },
  {
    tier: 4,
    group: 'Tests',
    test: (path) =>
      /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(path) ||
      path.includes('/__fixtures__/') ||
      path.includes('/fixtures/') ||
      path.includes('/mocks/') ||
      path.includes('/__mocks__/'),
  },
  {
    tier: 5,
    group: 'Configuration',
    test: (path) => {
      const fileName = path.split('/').pop() ?? '';
      return (
        fileName === 'package.json' ||
        fileName === 'kibana.jsonc' ||
        fileName === 'tsconfig.json' ||
        fileName === 'jest.config.js' ||
        fileName === 'jest.config.ts' ||
        fileName === '.eslintrc.js' ||
        path.includes('.buildkite/') ||
        path.includes('.github/')
      );
    },
  },
  {
    tier: 6,
    group: 'Documentation',
    test: (path) => /\.(md|mdx|txt|rst|adoc)$/i.test(path),
  },
];

function assignTier(path: string): { tier: number; group: string } {
  for (const { tier, group, test } of HEURISTIC_TIERS) {
    if (test(path)) {
      return { tier, group };
    }
  }
  return { tier: 99, group: 'Other' };
}

function depthOf(path: string): number {
  return path.split('/').length;
}

/**
 * Sorts files alphabetically by path and groups them by their parent directory,
 * producing a folder-tree structure equivalent to GitHub's "Files changed" view.
 */
export function sortAndGroupFiles(files: GhPullRequestFile[]): OrderedFile[] {
  return files
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => {
      const lastSlash = f.path.lastIndexOf('/');
      const group = lastSlash >= 0 ? f.path.slice(0, lastSlash) : '(root)';
      return { ...f, tier: 0, group };
    });
}

export function orderByHeuristic(files: GhPullRequestFile[]): OrderedFile[] {
  return files
    .map((f) => {
      const { tier, group } = assignTier(f.path);
      return { ...f, tier, group } satisfies OrderedFile;
    })
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const depthDiff = depthOf(a.path) - depthOf(b.path);
      if (depthDiff !== 0) return depthDiff;
      return a.path.localeCompare(b.path);
    });
}

// ─── LLM ordering ────────────────────────────────────────────────────────────

interface LlmOrderedFile {
  path: string;
  group: string;
}

async function callOpenAI(
  apiKey: string,
  model: string,
  prompt: string
): Promise<string> {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ message?: { content?: string } }>;
              error?: { message?: string };
            };
            if (parsed.error) {
              reject(new Error(`OpenAI error: ${parsed.error.message}`));
              return;
            }
            resolve(parsed.choices?.[0]?.message?.content ?? '');
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callAnthropic(
  apiKey: string,
  model: string,
  prompt: string
): Promise<string> {
  const body = JSON.stringify({
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as {
              content?: Array<{ type: string; text?: string }>;
              error?: { message?: string };
            };
            if (parsed.error) {
              reject(new Error(`Anthropic error: ${parsed.error.message}`));
              return;
            }
            const text = parsed.content?.find((c) => c.type === 'text')?.text ?? '';
            resolve(text);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildOrderingPrompt(
  prTitle: string,
  prBody: string,
  filePaths: string[]
): string {
  const truncatedBody = prBody.length > 1000 ? `${prBody.slice(0, 1000)}...` : prBody;
  return [
    'You are a code reviewer helping to organize a GitHub PR review.',
    'Given the PR title, description, and changed files, return a JSON object with an "order" key.',
    '"order" must be an array of objects, one per file, with "path" (exact file path) and "group" (one of: "core change", "supporting", "entry point", "test", "config", "docs").',
    'Sort files from most central to the PR purpose to most peripheral.',
    '',
    `PR Title: ${prTitle}`,
    `PR Description:\n${truncatedBody}`,
    '',
    'Files:',
    ...filePaths.map((p) => `  - ${p}`),
    '',
    'Return ONLY the JSON object, nothing else.',
  ].join('\n');
}

export class FileOrderingService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async orderFiles(
    files: GhPullRequestFile[],
    prTitle: string,
    prBody: string
  ): Promise<OrderedFile[]> {
    const config = vscode.workspace.getConfiguration('kibana-pr-reviewer');
    const provider = config.get<string>('llmProvider', 'none');

    if (provider === 'none') {
      return orderByHeuristic(files);
    }

    try {
      return await this.orderWithLlm(files, prTitle, prBody, provider);
    } catch (err) {
      void vscode.window.showWarningMessage(
        `Kibana PR Reviewer: LLM ordering failed, falling back to heuristics. ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return orderByHeuristic(files);
    }
  }

  async reorderWithLlm(
    files: GhPullRequestFile[],
    prTitle: string,
    prBody: string
  ): Promise<OrderedFile[]> {
    const config = vscode.workspace.getConfiguration('kibana-pr-reviewer');
    const provider = config.get<string>('llmProvider', 'none');

    if (provider === 'none') {
      void vscode.window.showInformationMessage(
        'Kibana PR Reviewer: Set kibana-pr-reviewer.llmProvider to "openai" or "anthropic" and add an API key to use LLM ordering.'
      );
      return orderByHeuristic(files);
    }

    return this.orderWithLlm(files, prTitle, prBody, provider);
  }

  private async orderWithLlm(
    files: GhPullRequestFile[],
    prTitle: string,
    prBody: string,
    provider: string
  ): Promise<OrderedFile[]> {
    const apiKey = await this.context.secrets.get('kibana-pr-reviewer.llmApiKey');
    if (!apiKey) {
      throw new Error(
        'No LLM API key found. Run "Kibana PR Reviewer: Set LLM API Key" from the command palette.'
      );
    }

    const config = vscode.workspace.getConfiguration('kibana-pr-reviewer');
    const modelOverride = config.get<string>('llmModel', '');
    const filePaths = files.map((f) => f.path);
    const prompt = buildOrderingPrompt(prTitle, prBody, filePaths);

    let rawResponse: string;
    if (provider === 'openai') {
      const model = modelOverride || 'gpt-4o-mini';
      rawResponse = await callOpenAI(apiKey, model, prompt);
    } else if (provider === 'anthropic') {
      const model = modelOverride || 'claude-haiku-4-5';
      rawResponse = await callAnthropic(apiKey, model, prompt);
    } else {
      throw new Error(`Unknown LLM provider: ${provider}`);
    }

    return this.parseLlmResponse(rawResponse, files);
  }

  private parseLlmResponse(
    rawResponse: string,
    originalFiles: GhPullRequestFile[]
  ): OrderedFile[] {
    let parsed: { order?: LlmOrderedFile[] };
    try {
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch?.[0] ?? rawResponse) as typeof parsed;
    } catch {
      throw new Error('LLM returned invalid JSON');
    }

    const ordered = parsed.order ?? [];
    const fileMap = new Map(originalFiles.map((f) => [f.path, f]));
    const result: OrderedFile[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < ordered.length; i++) {
      const { path, group } = ordered[i];
      const original = fileMap.get(path);
      if (original && !seen.has(path)) {
        result.push({ ...original, group, tier: i + 1 });
        seen.add(path);
      }
    }

    // Append any files the LLM missed, using heuristics
    for (const f of originalFiles) {
      if (!seen.has(f.path)) {
        const { tier, group } = assignTier(f.path);
        result.push({ ...f, group, tier: 1000 + tier });
      }
    }

    return result;
  }
}
