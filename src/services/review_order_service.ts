import { execFile } from 'child_process';
import * as https from 'https';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { log } from '../logger';
import type { GhPullRequest, GhPullRequestFile } from './github_service';

const execFileAsync = promisify(execFile);

export interface SuggestedFile {
  path: string;
  reason: string;
}

export interface ReviewOrderSuggestion {
  topDown: SuggestedFile[];
  bottomUp: SuggestedFile[];
}

/** Max lines of diff to include per file before truncating. */
const MAX_DIFF_LINES_PER_FILE = 150;

/** Max total diff lines across all files before subsequent diffs are omitted. */
const MAX_TOTAL_DIFF_LINES = 2000;

// ─── Diff fetching ────────────────────────────────────────────────────────────

async function getFileDiff(
  filePath: string,
  baseCommit: string,
  cwd: string | undefined
): Promise<string> {
  try {
    // Omitting HEAD compares baseCommit against the working tree (includes uncommitted changes).
    const { stdout } = await execFileAsync('git', ['diff', baseCommit, '--', filePath], {
      cwd,
    });
    const lines = stdout.split('\n');
    if (lines.length > MAX_DIFF_LINES_PER_FILE) {
      return lines.slice(0, MAX_DIFF_LINES_PER_FILE).join('\n') + '\n[… diff truncated]';
    }
    return stdout || '[no changes]';
  } catch {
    return '[diff unavailable]';
  }
}

async function buildFileSections(
  files: GhPullRequestFile[],
  baseCommit: string,
  cwd: string | undefined,
  token: vscode.CancellationToken
): Promise<string[]> {
  let totalLines = 0;
  const sections: string[] = [];
  for (const file of files) {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    let diffText: string;
    if (totalLines >= MAX_TOTAL_DIFF_LINES) {
      diffText = '[diff omitted — budget reached]';
    } else {
      diffText = await getFileDiff(file.path, baseCommit, cwd);
      totalLines += diffText.split('\n').length;
    }
    sections.push(
      `### ${file.path}  (+${file.additions} -${file.deletions})\n\`\`\`diff\n${diffText}\n\`\`\``
    );
  }
  return sections;
}

function buildPrompt(pr: GhPullRequest | null, fileSections: string[]): string {
  const prBody = (pr?.body ?? '').slice(0, 800);
  const prHeader = pr
    ? `PR #${pr.number}: ${pr.title}\n${prBody ? `\nDescription:\n${prBody}\n` : ''}`
    : 'Local branch changes (no associated PR yet)\n';
  return `You are helping a software engineer review a GitHub pull request.
Your task: suggest two orderings for reviewing the changed files.

${prHeader}
Changed files with diffs:
${fileSections.join('\n\n')}

Produce two review orderings:

TOP_DOWN — Start with the highest-level entry point of the change: the public API, \
the interface, the route handler, the component — whatever reveals *intent* first. \
Then move through orchestration logic to implementation details, and finish with tests \
and config.

BOTTOM_UP — Start with foundational pieces others depend on: types, schemas, \
utility functions, base classes. Then move up through the call stack to the code that \
uses them, finishing with integration tests and UI.

Rules:
- Every changed file must appear in each ordering exactly once.
- Keep reasons to one short sentence.

Respond with ONLY valid JSON — no markdown fences, no explanation:
{
  "topDown": [
    { "path": "exact/file/path.ts", "reason": "…" }
  ],
  "bottomUp": [
    { "path": "exact/file/path.ts", "reason": "…" }
  ]
}`;
}

function parseResponse(raw: string, allPaths: Set<string>): ReviewOrderSuggestion {
  const jsonText = raw
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  let parsed: ReviewOrderSuggestion;
  try {
    parsed = JSON.parse(jsonText) as ReviewOrderSuggestion;
  } catch {
    throw new Error(
      `The model returned a response that could not be parsed. Try again.\n\nRaw: ${raw.slice(0, 300)}`
    );
  }

  // Fill in files the model forgot; drop paths it hallucinated.
  const fillMissing = (ordered: SuggestedFile[]): SuggestedFile[] => {
    const seen = new Set(ordered.map((f) => f.path));
    const missing = [...allPaths].filter((p) => !seen.has(p));
    return [
      ...ordered.filter((f) => allPaths.has(f.path)),
      ...missing.map((p) => ({ path: p, reason: '' })),
    ];
  };

  return {
    topDown: fillMissing(parsed.topDown ?? []),
    bottomUp: fillMissing(parsed.bottomUp ?? []),
  };
}

// ─── LLM backends ─────────────────────────────────────────────────────────────

/** Try every known strategy to get a usable vscode.lm model. Returns null if none found. */
async function selectVscodeLmModel(): Promise<vscode.LanguageModelChat | null> {
  // Strategy 1: all models, no filter (broadest — also picks up Cursor-registered models).
  try {
    const models = await vscode.lm.selectChatModels();
    if (models.length > 0) {
      log(
        `[ReviewOrder] vscode.lm found ${models.length} model(s): ${models.map((m) => `${m.name}/${m.family}`).join(', ')}`
      );
      return (
        models.find((m) =>
          /gpt-4|claude-3|claude-4|opus|sonnet/i.test(`${m.family ?? ''}${m.name ?? ''}`)
        ) ?? models[0]
      );
    }
    log('[ReviewOrder] vscode.lm: selectChatModels() returned 0 models');
  } catch (err) {
    log(`[ReviewOrder] vscode.lm.selectChatModels() threw: ${err}`);
  }

  // Strategy 2: explicitly request the Cursor vendor (Cursor ≥ 0.45 registers models under "cursor").
  try {
    const cursorModels = await vscode.lm.selectChatModels({ vendor: 'cursor' });
    if (cursorModels.length > 0) {
      log(`[ReviewOrder] vscode.lm cursor-vendor: ${cursorModels.map((m) => m.name).join(', ')}`);
      return cursorModels[0];
    }
  } catch {
    // ignore
  }

  // Strategy 3: Copilot vendor (VS Code with GitHub Copilot).
  try {
    const copilotModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (copilotModels.length > 0) {
      log(`[ReviewOrder] vscode.lm copilot-vendor: ${copilotModels.map((m) => m.name).join(', ')}`);
      return copilotModels[0];
    }
  } catch {
    // ignore
  }

  return null;
}

async function suggestWithVscodeLm(
  model: vscode.LanguageModelChat,
  prompt: string,
  token: vscode.CancellationToken
): Promise<string> {
  log(`[ReviewOrder] Using vscode.lm model: ${model.name} (${model.family})`);
  const messages = [vscode.LanguageModelChatMessage.User(prompt)];
  const response = await model.sendRequest(messages, {}, token);
  let raw = '';
  for await (const chunk of response.text) {
    raw += chunk;
  }
  return raw;
}

function httpsPost(url: string, headers: Record<string, string>, body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    };
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
        } else {
          resolve(text);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function suggestWithOpenAi(apiKey: string, model: string, prompt: string): Promise<string> {
  log(`[ReviewOrder] Using OpenAI model: ${model}`);
  const responseText = await httpsPost(
    'https://api.openai.com/v1/chat/completions',
    { Authorization: `Bearer ${apiKey}` },
    {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    }
  );
  const json = JSON.parse(responseText) as {
    choices: Array<{ message: { content: string } }>;
    error?: { message: string };
  };
  if (json.error) throw new Error(`OpenAI error: ${json.error.message}`);
  return json.choices[0].message.content;
}

async function suggestWithAnthropic(
  apiKey: string,
  model: string,
  prompt: string
): Promise<string> {
  log(`[ReviewOrder] Using Anthropic model: ${model}`);
  const responseText = await httpsPost(
    'https://api.anthropic.com/v1/messages',
    {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    {
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }
  );
  const json = JSON.parse(responseText) as {
    content: Array<{ type: string; text: string }>;
    error?: { message: string };
  };
  if (json.error) throw new Error(`Anthropic error: ${json.error.message}`);
  return json.content.find((b) => b.type === 'text')?.text ?? '';
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function suggestReviewOrder(
  pr: GhPullRequest | null,
  files: GhPullRequestFile[],
  baseCommit: string,
  cwd: string | undefined,
  token: vscode.CancellationToken
): Promise<ReviewOrderSuggestion> {
  const fileSections = await buildFileSections(files, baseCommit, cwd, token);
  const prompt = buildPrompt(pr, fileSections);
  const allPaths = new Set(files.map((f) => f.path));

  log(`[ReviewOrder] Prompt length: ${prompt.length} chars`);
  log(`[ReviewOrder] Prompt:\n${prompt}`);

  // ── 1. Try vscode.lm (GitHub Copilot, Cursor built-in, or any registered provider) ──
  const lmModel = await selectVscodeLmModel();
  if (lmModel) {
    const raw = await suggestWithVscodeLm(lmModel, prompt, token);
    log(`[ReviewOrder] vscode.lm response: ${raw.length} chars`);
    return parseResponse(raw, allPaths);
  }

  // ── 2. Fall back to a configured API key ─────────────────────────────────────
  const config = vscode.workspace.getConfiguration('elastic-pr-reviewer');
  const provider = config.get<string>('llmProvider') ?? 'none';
  const apiKey = config.get<string>('llmApiKey') ?? '';
  const modelOverride = config.get<string>('llmModel') ?? '';

  if (provider === 'openai' && apiKey) {
    const model = modelOverride || 'gpt-4o';
    const raw = await suggestWithOpenAi(apiKey, model, prompt);
    log(`[ReviewOrder] OpenAI response: ${raw.length} chars`);
    return parseResponse(raw, allPaths);
  }

  if (provider === 'anthropic' && apiKey) {
    const model = modelOverride || 'claude-opus-4-5';
    const raw = await suggestWithAnthropic(apiKey, model, prompt);
    log(`[ReviewOrder] Anthropic response: ${raw.length} chars`);
    return parseResponse(raw, allPaths);
  }

  // ── 3. Nothing available — give a clear, actionable error ────────────────────
  const isCursor = vscode.env.appName.toLowerCase().includes('cursor');

  let hint: string;
  if (provider !== 'none' && !apiKey) {
    hint =
      `"llmProvider" is set to "${provider}" but "llmApiKey" is empty.\n` +
      `Add your key under elastic-pr-reviewer.llmApiKey in Settings.`;
  } else if (isCursor) {
    hint =
      `You are running Cursor, which does not yet expose its built-in AI to third-party extensions.\n\n` +
      `To enable this feature, add an OpenAI API key:\n` +
      `  1. Get a key at platform.openai.com/api-keys\n` +
      `  2. Set elastic-pr-reviewer.llmProvider → "openai"\n` +
      `  3. Set elastic-pr-reviewer.llmApiKey → your key\n\n` +
      `Click "Open Settings" in this notification to configure.`;
  } else {
    hint =
      `Set elastic-pr-reviewer.llmProvider to "openai" or "anthropic" and add your API key ` +
      `in elastic-pr-reviewer.llmApiKey. Click "Open Settings" to configure.`;
  }

  throw new Error(hint);
}
