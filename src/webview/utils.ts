import type { GhPullRequest, OrderedFile, ReviewDecision } from './types';

// ─── Age label ────────────────────────────────────────────────────────────────

export function ageLabel(createdAt: string): string {
  const diffMs = Date.now() - new Date(createdAt).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  return `${Math.floor(weeks / 4)}mo ago`;
}

// ─── Review decision label ───────────────────────────────────────────────────

export function reviewDecisionLabel(decision: ReviewDecision): string {
  switch (decision) {
    case 'APPROVED': return '✓ Approved';
    case 'CHANGES_REQUESTED': return '✗ Changes requested';
    case 'REVIEW_REQUIRED': return '⏳ Review required';
    default: return '— No review yet';
  }
}

// ─── Is review in progress ───────────────────────────────────────────────────

const BOT_LOGINS = new Set(['coderabbitai', 'coderabbitai[bot]', 'elasticmachine']);

export function isReviewInProgress(pr: GhPullRequest): boolean {
  const authorLogin = pr.author.login;
  const isHuman = (login: string) => login !== authorLogin && !BOT_LOGINS.has(login);
  return (pr.latestReviews ?? []).some(
    (r) => r.state !== 'PENDING' && isHuman(r.author.login)
  );
}

// ─── File status icon ─────────────────────────────────────────────────────────

export function cfStatusIcon(status: string): { icon: string; colorClass: string } {
  switch (status) {
    case 'added':   return { icon: '+', colorClass: 'status-added' };
    case 'deleted': return { icon: '−', colorClass: 'status-deleted' };
    case 'renamed': return { icon: '→', colorClass: 'status-renamed' };
    default:        return { icon: '●', colorClass: 'status-modified' };
  }
}

export function normalizeFileStatus(file: OrderedFile): string {
  return ((file as { changeType?: string }).changeType?.toLowerCase() ?? file.status ?? 'modified');
}

// ─── File tree ────────────────────────────────────────────────────────────────

export interface CfFolderNode { type: 'folder'; name: string; children: CfTreeChild[]; }
export interface CfFileLeaf   { type: 'file';   file: OrderedFile; }
export type CfTreeChild = CfFolderNode | CfFileLeaf;

export function cfBuildTree(files: OrderedFile[]): CfFolderNode {
  const root: CfFolderNode = { type: 'folder', name: '', children: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let folder = cur.children.find(
        (c): c is CfFolderNode => c.type === 'folder' && c.name === parts[i]
      );
      if (!folder) {
        folder = { type: 'folder', name: parts[i], children: [] };
        cur.children.push(folder);
      }
      cur = folder;
    }
    cur.children.push({ type: 'file', file });
  }
  return root;
}

export function cfCompactFolders(node: CfFolderNode): CfFolderNode {
  const compacted: CfTreeChild[] = node.children.map((child) => {
    if (child.type !== 'folder') return child;
    let current = cfCompactFolders(child);
    while (current.children.length === 1 && current.children[0].type === 'folder') {
      const only = current.children[0] as CfFolderNode;
      current = cfCompactFolders({
        type: 'folder',
        name: current.name + '/' + only.name,
        children: only.children,
      });
    }
    return current;
  });
  return { ...node, children: compacted };
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

// ─── Buildkite CI widget ──────────────────────────────────────────────────────

interface BuildkiteBuild {
  buildStatus: { state: string; success: boolean; hasRetries: boolean; hasNonPreemptionRetries: boolean };
  url: string;
  number: number;
  commit: string;
}

export const bkStateIcon = (state: string): { icon: string; cls: string } => {
  switch (state) {
    case 'passed':   return { icon: '✓', cls: 'bk-passed' };
    case 'failed':   return { icon: '✗', cls: 'bk-failed' };
    case 'failing':  return { icon: '⚠', cls: 'bk-failing' };
    case 'running':  return { icon: '⟳', cls: 'bk-running' };
    case 'blocked':  return { icon: '⏸', cls: 'bk-blocked' };
    default:         return { icon: '●', cls: 'bk-unknown' };
  }
};

export interface BuildkiteSummaryItem {
  pipelineName: string;
  state: string;
  icon: string;
  cls: string;
  url: string;
  buildNumber: number;
  hasRetries: boolean;
}

/** Extracts the latest build summary for each Buildkite pipeline embedded in PR body text. */
export function extractBuildkiteSummary(text: string): BuildkiteSummaryItem[] {
  const results: BuildkiteSummaryItem[] = [];
  const re = /<!--buildkite-pr-comment-([^\n]+)\n([\s\S]*?)\nbuildkite-pr-comment-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const pipeline = m[1].trim();
    let data: { builds: BuildkiteBuild[] };
    try { data = JSON.parse(m[2].trim()) as { builds: BuildkiteBuild[] }; } catch { continue; }
    const latest = data.builds[0];
    if (!latest) continue;
    const { icon, cls } = bkStateIcon(latest.buildStatus.state);
    results.push({
      pipelineName: pipeline.replace(/-/g, ' '),
      state: latest.buildStatus.state,
      icon,
      cls,
      url: latest.url,
      buildNumber: latest.number,
      hasRetries: latest.buildStatus.hasNonPreemptionRetries,
    });
  }
  return results;
}

function renderBuildkiteWidget(pipeline: string, json: string): string {
  let data: { builds: BuildkiteBuild[] };
  try {
    data = JSON.parse(json) as { builds: BuildkiteBuild[] };
  } catch {
    return '';
  }

  const rows = data.builds.map((b) => {
    const { icon, cls } = bkStateIcon(b.buildStatus.state);
    const short = b.commit.slice(0, 7);
    const retryNote = b.buildStatus.hasNonPreemptionRetries
      ? '<span class="bk-retry">has retries</span>'
      : b.buildStatus.hasRetries
        ? '<span class="bk-retry">preemption retries</span>'
        : '';
    return `<div class="bk-row">
      <span class="bk-icon ${cls}">${icon}</span>
      <a class="bk-link" href="${escHtml(b.url)}">#${b.number}</a>
      <span class="bk-state ${cls}">${escHtml(b.buildStatus.state)}</span>
      <code class="bk-sha">${short}</code>
      ${retryNote}
    </div>`;
  }).join('');

  const pipelineName = pipeline.replace(/-/g, ' ');
  return `<div class="bk-widget">
    <div class="bk-header">
      <span class="bk-logo">▶</span>
      <span class="bk-title">Buildkite · ${escHtml(pipelineName)}</span>
    </div>
    ${rows}
  </div>`;
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

export function renderMarkdown(text: string, repoUrl?: string): string {
  if (!text.trim()) return '<p><em>No description provided.</em></p>';

  // Normalise Windows line endings so all regex can use \n without special-casing \r\n.
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Extract Buildkite CI comment blocks before stripping HTML comments.
  // Format: <!--buildkite-pr-comment-{pipeline}\n{json}\nbuildkite-pr-comment-->
  let bkWidgets = '';
  const withBk = text.replace(
    /<!--buildkite-pr-comment-([^\n]+)\n([\s\S]*?)\nbuildkite-pr-comment-->/g,
    (_m, pipeline: string, json: string) => {
      bkWidgets += renderBuildkiteWidget(pipeline.trim(), json.trim());
      return '';
    }
  );

  // Strip remaining HTML comments and GitHub's empty-tag auto-link suppression
  // (exclude <details> from the empty-tag strip so it isn't removed before we lift it)
  const cleaned = withBk
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(?!details\b)([a-zA-Z]+)[^>]*><\/\1>/g, '');

  // Lift <details>...</details> blocks before escaping so they render as real
  // collapsible elements. Their body is recursively rendered as markdown.
  //
  // We process innermost-first: the regex only matches a <details> whose content
  // contains no nested <details> opening tag. Each pass replaces one nesting level
  // with a placeholder; subsequent passes handle the next level up. This correctly
  // handles arbitrary nesting depth (e.g. CodeRabbit's nested collapsible sections).
  const liftedDetails: string[] = [];
  let withLiftedDetails = cleaned;
  let detailsFound = true;
  while (detailsFound) {
    detailsFound = false;
    withLiftedDetails = withLiftedDetails.replace(
      /<details[^>]*>((?:(?!<details)[\s\S])*?)<\/details>/gi,
      (_, inner: string) => {
        detailsFound = true;
        const summaryMatch = inner.match(/^\s*<summary>([\s\S]*?)<\/summary>\s*/i);
        const summaryText = summaryMatch ? summaryMatch[1].trim() : '';
        const bodyText = summaryMatch ? inner.slice(summaryMatch[0].length) : inner;
        const renderedSummary = escHtml(summaryText);
        // Body may contain placeholders for already-lifted inner blocks — they survive
        // renderMarkdown untouched and will be resolved during the reverse restore pass.
        const renderedBody = bodyText.trim() ? renderMarkdown(bodyText, repoUrl) : '';
        liftedDetails.push(
          `<details class="md-details"><summary class="md-details-summary">${renderedSummary}</summary>` +
            `<div class="md-details-body">${renderedBody}</div></details>`
        );
        return `\x00DETAILS${liftedDetails.length - 1}\x00`;
      }
    );
  }

  // Lift <img> tags out before escaping so their attributes survive intact.
  const liftedImgs: string[] = [];
  const withLiftedImgs = withLiftedDetails.replace(/<img\b([^>]*)>/gi, (_, attrs: string) => {
    const srcMatch = attrs.match(/\bsrc="([^"]+)"/i);
    const altMatch = attrs.match(/\balt="([^"]*)"/i);
    if (!srcMatch) return '';
    const src = srcMatch[1];
    const alt = escHtml(altMatch?.[1] ?? '');
    liftedImgs.push(`<div class="media-wrap"><img src="${src}" alt="${alt}"></div>`);
    return `\x00IMG${liftedImgs.length - 1}\x00`;
  });

  let html = escHtml(withLiftedImgs);

  // Restore lifted <img> elements (placeholders were not touched by escHtml)
  for (let i = 0; i < liftedImgs.length; i++) {
    html = html.replace(`\x00IMG${i}\x00`, liftedImgs[i]);
  }

  html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code) =>
    `<pre><code>${code.trim()}</code></pre>`
  );
  html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Markdown images: ![alt](url) — must run before the link regex to avoid turning them into links
  html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, (_, alt, src) =>
    `<img src="${src}" alt="${alt}" style="max-width:100%">`
  );
  // Handles both [text](url) and [[text]](url) (GitHub bot double-bracket links)
  html = html.replace(/\[{1,2}([^\]]+)\]{1,2}\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
  // Bare GitHub PR/issue URLs → short reference links.
  // Negative lookbehind (?<!\]\() skips URLs already inside a markdown ](…) that was just linked above.
  // e.g. https://github.com/elastic/kibana/pull/254943#event-… → #254943 (comment)
  //      https://github.com/other/repo/pull/42              → other/repo#42
  html = html.replace(
    /(?<!\]\()(?<!href=")https:\/\/github\.com\/([^/\s"<]+)\/([^/\s"<]+)\/(?:pull|issues)\/(\d+)(#[^\s"<]*)?/g,
    (match, owner, repo, num, fragment) => {
      const isSameRepo = repoUrl && `https://github.com/${owner}/${repo}` === repoUrl;
      const ref = isSameRepo ? `#${num}` : `${owner}/${repo}#${num}`;
      const suffix = fragment ? ' (comment)' : '';
      return `<a href="${match}">${ref}${suffix}</a>`;
    }
  );
  // Issue/PR references like "Fixes #232699" — only when repo is known and not inside a URL
  if (repoUrl) {
    html = html.replace(/(^|[\s(,;])#(\d+)/gm, (_, pre, n) =>
      `${pre}<a href="${repoUrl}/issues/${n}">#${n}</a>`
    );
  }
  // Emoji shortcodes — applied after inline code so :code: inside backticks is protected
  html = applyEmoji(html);
  html = html.replace(/^- \[x\] (.+)$/gm, '<li class="checked">☑ $1</li>');
  html = html.replace(/^- \[ \] (.+)$/gm, '<li class="unchecked">☐ $1</li>');
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  html = html.replace(/^(?:---|\*\*\*|___)$/gm, '<hr>');

  // Tables: header row | separator row | one-or-more data rows
  html = html.replace(
    /^(\|.+)\n\|[\s|:+-]+\n((?:\|.+\n?)+)/gm,
    (_, headerLine: string, bodyLines: string) => {
      // Strip any trailing \r that survived line-ending normalisation
      const parseRow = (line: string) =>
        line.replace(/\r$/, '').split('|').slice(1, -1).map((c) => c.trim());
      const headers = parseRow(headerLine);
      const rows = bodyLines.trim().split('\n').map(parseRow);
      const th = headers.map((h) => `<th>${h}</th>`).join('');
      const trs = rows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
        .join('');
      return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
    }
  );

  html = html.replace(
    /^(https:\/\/github\.com\/user-attachments\/assets\/[a-zA-Z0-9_-]+)\s*$/gm,
    (_m, url) =>
      `<div class="media-wrap"><video controls preload="metadata" src="${url}">` +
      `<a href="${url}">View video</a></video></div>`
  );
  html = html.replace(
    /^(https:\/\/(?:user-images|camo)\.githubusercontent\.com\/\S+)\s*$/gm,
    (_m, url) => `<div class="media-wrap"><img src="${url}" alt="attachment"></div>`
  );

  const blockRe = /^<(h[1-6]|ol|pre|blockquote|hr|div|p\b|table)/;
  const out: string[] = [];
  let pending: string[] = [];
  let listItems: string[] = [];

  const flushPending = () => {
    const content = pending.join('<br>').trim();
    if (content) out.push(`<p>${content}</p>`);
    pending = [];
  };
  const flushList = () => {
    if (listItems.length > 0) {
      out.push(`<ul>${listItems.join('')}</ul>`);
      listItems = [];
    }
  };

  for (const line of html.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushPending();
      flushList();
    } else if (trimmed.startsWith('<li')) {
      flushPending();
      listItems.push(trimmed);
    } else if (blockRe.test(trimmed)) {
      flushPending();
      flushList();
      out.push(trimmed);
    } else {
      flushList();
      pending.push(trimmed);
    }
  }
  flushPending();
  flushList();

  let body = out.join('\n');

  // Restore lifted <details> blocks in reverse order: outermost blocks (highest index)
  // are restored first, which injects inner placeholders into the live body string so
  // the next iterations can resolve them correctly.
  for (let i = liftedDetails.length - 1; i >= 0; i--) {
    body = body.replace(`\x00DETAILS${i}\x00`, liftedDetails[i]);
  }

  return bkWidgets ? body + bkWidgets : body;
}

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Emoji map ────────────────────────────────────────────────────────────────

const EMOJI: Record<string, string> = {
  // Hearts & emotions
  heart: '❤️', yellow_heart: '💛', green_heart: '💚', blue_heart: '💙',
  purple_heart: '💜', orange_heart: '🧡', black_heart: '🖤', white_heart: '🤍',
  broken_heart: '💔', heavy_heart_exclamation: '❣️', two_hearts: '💕',
  sparkling_heart: '💖', heartpulse: '💗', heartbeat: '💓', revolving_hearts: '💞',
  heart_eyes: '😍', smiling_face_with_3_hearts: '🥰',

  // Faces
  smile: '😄', grinning: '😀', laughing: '😆', joy: '😂', rofl: '🤣',
  slightly_smiling_face: '🙂', upside_down_face: '🙃', wink: '😉', blush: '😊',
  sweat_smile: '😅', hugs: '🤗', thinking: '🤔', zipper_mouth_face: '🤐',
  raised_eyebrow: '🤨', neutral_face: '😐', expressionless: '😑', no_mouth: '😶',
  smirk: '😏', unamused: '😒', roll_eyes: '🙄', grimacing: '😬',
  lying_face: '🤥', relieved: '😌', pensive: '😔', sleepy: '😪',
  drooling_face: '🤤', sleeping: '😴', mask: '😷', face_with_thermometer: '🤒',
  face_with_head_bandage: '🤕', nauseated_face: '🤢', sneezing_face: '🤧',
  hot_face: '🥵', cold_face: '🥶', woozy_face: '🥴', dizzy_face: '😵',
  exploding_head: '🤯', cowboy_hat_face: '🤠', partying_face: '🥳',
  sunglasses: '😎', nerd_face: '🤓', monocle_face: '🧐',
  confused: '😕', worried: '😟', slightly_frowning_face: '🙁',
  frowning_face: '☹️', open_mouth: '😮', hushed: '😯', astonished: '😲',
  flushed: '😳', pleading_face: '🥺', anguished: '😧', fearful: '😨',
  cold_sweat: '😰', disappointed_relieved: '😥', cry: '😢', sob: '😭',
  scream: '😱', confounded: '😖', persevere: '😣', disappointed: '😞',
  sweat: '😓', weary: '😩', tired_face: '😫', yawning_face: '🥱',
  triumph: '😤', rage: '😡', angry: '😠', skull: '💀', skull_and_crossbones: '☠️',
  pile_of_poo: '💩', poop: '💩', clown_face: '🤡', japanese_ogre: '👹',
  japanese_goblin: '👺', ghost: '👻', alien: '👽', space_invader: '👾',
  robot: '🤖',

  // Hands & gestures
  '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎',
  clap: '👏', raised_hands: '🙌', open_hands: '👐', pray: '🙏',
  handshake: '🤝', point_up: '☝️', point_up_2: '👆', point_down: '👇',
  point_left: '👈', point_right: '👉', fu: '🖕', raised_hand: '✋',
  hand: '✋', v: '✌️', metal: '🤘', call_me_hand: '🤙',
  muscle: '💪', mechanical_arm: '🦾', wave: '👋', ok_hand: '👌',
  pinched_fingers: '🤌', pinching_hand: '🤏', crossed_fingers: '🤞',
  love_you_gesture: '🤟', writing_hand: '✍️', nail_care: '💅',
  selfie: '🤳', ear: '👂', nose: '👃', eyes: '👀', eye: '👁️',
  tongue: '👅', lips: '👄', brain: '🧠',

  // People
  baby: '👶', boy: '👦', girl: '👧', man: '👨', woman: '👩',
  technologist: '🧑‍💻', man_technologist: '👨‍💻', woman_technologist: '👩‍💻',
  scientist: '🧑‍🔬', teacher: '🧑‍🏫', firefighter: '🧑‍🚒',
  superhero: '🦸', supervillain: '🦹', ninja: '🥷',
  construction_worker: '👷', guardsman: '💂', detective: '🕵️',
  fairy: '🧚', mage: '🧙', zombie: '🧟', person_shrugging: '🤷',
  man_shrugging: '🤷‍♂️', woman_shrugging: '🤷‍♀️',
  person_facepalming: '🤦', man_facepalming: '🤦‍♂️', woman_facepalming: '🤦‍♀️',

  // Nature & animals
  dog: '🐶', cat: '🐱', mouse: '🐭', hamster: '🐹', rabbit: '🐰',
  fox_face: '🦊', bear: '🐻', panda_face: '🐼', koala: '🐨', tiger: '🐯',
  lion: '🦁', cow: '🐮', pig: '🐷', frog: '🐸', monkey_face: '🐵',
  chicken: '🐔', penguin: '🐧', bird: '🐦', hatching_chick: '🐣',
  hatched_chick: '🐥', duck: '🦆', eagle: '🦅', owl: '🦉', bat: '🦇',
  wolf: '🐺', boar: '🐗', horse: '🐴', unicorn: '🦄', bee: '🐝',
  bug: '🐛', butterfly: '🦋', snail: '🐌', shell: '🐚', ladybug: '🐞',
  ant: '🐜', mosquito: '🦟', cricket: '🦗', spider: '🕷️',
  turtle: '🐢', snake: '🐍', lizard: '🦎', dragon_face: '🐲',
  whale: '🐳', dolphin: '🐬', fish: '🐟', blowfish: '🐡', shark: '🦈',
  octopus: '🐙', crab: '🦀', lobster: '🦞', shrimp: '🦐', squid: '🦑',
  sneezing: '🤧', seedling: '🌱', evergreen_tree: '🌲', deciduous_tree: '🌳',
  palm_tree: '🌴', cactus: '🌵', ear_of_rice: '🌾', herb: '🌿',
  shamrock: '☘️', four_leaf_clover: '🍀', maple_leaf: '🍁', fallen_leaf: '🍂',
  leaves: '🍃', mushroom: '🍄', sunflower: '🌻', tulip: '🌷', rose: '🌹',
  wilted_flower: '🥀', blossom: '🌼', cherry_blossom: '🌸',
  sun: '☀️', sunny: '☀️', cloud: '☁️', rain: '🌧️', snow: '❄️',
  zap: '⚡', tornado: '🌪️', rainbow: '🌈', fire: '🔥', droplet: '💧',
  ocean: '🌊', earth_africa: '🌍', earth_americas: '🌎', earth_asia: '🌏',
  globe_with_meridians: '🌐', world_map: '🗺️', mount_fuji: '🗻', camping: '🏕️',

  // Food & drink
  apple: '🍎', green_apple: '🍏', pear: '🍐', tangerine: '🍊', orange: '🍊',
  lemon: '🍋', banana: '🍌', watermelon: '🍉', grapes: '🍇',
  strawberry: '🍓', blueberries: '🫐', melon: '🍈', cherries: '🍒',
  peach: '🍑', mango: '🥭', pineapple: '🍍', coconut: '🥥',
  tomato: '🍅', eggplant: '🍆', avocado: '🥑', broccoli: '🥦',
  pizza: '🍕', hamburger: '🍔', fries: '🍟', hotdog: '🌭',
  sandwich: '🥪', taco: '🌮', burrito: '🌯', sushi: '🍣',
  cake: '🎂', birthday: '🎂', cookie: '🍪', candy: '🍬',
  lollipop: '🍭', chocolate_bar: '🍫', doughnut: '🍩', ice_cream: '🍨',
  coffee: '☕', tea: '🍵', beer: '🍺', beers: '🍻', wine_glass: '🍷',
  cocktail: '🍸', tropical_drink: '🍹', champagne: '🍾', bottle_with_popping_cork: '🍾',

  // Activities & objects
  soccer: '⚽', basketball: '🏀', football: '🏈', baseball: '⚾',
  tennis: '🎾', volleyball: '🏐', rugby_football: '🏉', flying_disc: '🥏',
  '8ball': '🎱', golf: '⛳', trophy: '🏆', medal_sports: '🏅',
  first_place_medal: '🥇', second_place_medal: '🥈', third_place_medal: '🥉',
  dart: '🎯', video_game: '🎮', dice: '🎲', jigsaw: '🧩',
  art: '🎨', performing_arts: '🎭', slot_machine: '🎰', game_die: '🎲',
  guitar: '🎸', musical_note: '🎵', notes: '🎶', microphone: '🎤',
  headphones: '🎧', radio: '📻', saxophone: '🎷', trumpet: '🎺',
  violin: '🎻', drum: '🥁', piano: '🎹',

  // Travel & places
  car: '🚗', taxi: '🚕', bus: '🚌', trolleybus: '🚎', racing_car: '🏎️',
  police_car: '🚓', ambulance: '🚑', fire_engine: '🚒', truck: '🚚',
  articulated_lorry: '🚛', tractor: '🚜', kick_scooter: '🛴', bike: '🚲',
  motor_scooter: '🛵', motorcycle: '🏍️', train: '🚂', monorail: '🚝',
  bullettrain_side: '🚄', flight_departure: '🛫', airplane: '✈️',
  rocket: '🚀', flying_saucer: '🛸', helicopter: '🚁', ship: '🚢',
  speedboat: '🚤', anchor: '⚓', construction: '🚧', fuelpump: '⛽',
  house: '🏠', office: '🏢', school: '🏫', hospital: '🏥',
  bank: '🏦', hotel: '🏨', convenience_store: '🏪', department_store: '🏬',
  european_castle: '🏰', japanese_castle: '🏯', stadium: '🏟️',
  statue_of_liberty: '🗽', moyai: '🗿',

  // Symbols & misc
  check: '✅', white_check_mark: '✅', x: '❌', heavy_check_mark: '✔️',
  heavy_multiplication_x: '✖️', bangbang: '‼️', interrobang: '⁉️',
  question: '❓', grey_question: '❔', grey_exclamation: '❕', exclamation: '❗',
  warning: '⚠️', no_entry: '⛔', no_entry_sign: '🚫', prohibited: '🚫',
  name_badge: '📛', sos: '🆘', id: '🆔', atom_symbol: '⚛️',
  radioactive: '☢️', biohazard: '☣️', recycle: '♻️', fleur_de_lis: '⚜️',
  beginner: '🔰', trident: '🔱', white_square_button: '🔳',
  black_square_button: '🔲', red_circle: '🔴', orange_circle: '🟠',
  yellow_circle: '🟡', green_circle: '🟢', blue_circle: '🔵',
  purple_circle: '🟣', brown_circle: '🟤', black_circle: '⚫',
  white_circle: '⚪', red_square: '🟥', orange_square: '🟧',
  yellow_square: '🟨', green_square: '🟩', blue_square: '🟦',
  purple_square: '🟪', brown_square: '🟫', black_large_square: '⬛',
  white_large_square: '⬜', star: '⭐', star2: '🌟', dizzy: '💫',
  sparkles: '✨', boom: '💥', anger: '💢', speech_balloon: '💬',
  thought_balloon: '💭', zzz: '💤', wave_dash: '〰️', hash: '#️⃣',
  keycap_ten: '🔟', one: '1️⃣', two: '2️⃣', three: '3️⃣', four: '4️⃣',
  five: '5️⃣', six: '6️⃣', seven: '7️⃣', eight: '8️⃣', nine: '9️⃣', zero: '0️⃣',
  new: '🆕', up: '🆙', cool: '🆒', free: '🆓', ng: '🆖', ok: '🆗',
  sos_button: '🆘', sos2: '🆘', top: '🔝', soon: '🔜', back: '🔙',
  end: '🔚', on: '🔛', clock1: '🕐', clock2: '🕑', clock3: '🕒',
  clock12: '🕛', hourglass: '⌛', hourglass_flowing_sand: '⏳',
  alarm_clock: '⏰', timer_clock: '⏱️', stopwatch: '⏱️',

  // Tech & tools
  computer: '💻', desktop_computer: '🖥️', printer: '🖨️', keyboard: '⌨️',
  computer_mouse: '🖱️', trackball: '🖲️', minidisc: '💽', floppy_disk: '💾',
  cd: '💿', dvd: '📀', abacus: '🧮', movie_camera: '🎥', film_strip: '🎞️',
  film_projector: '📽️', clapper: '🎬', tv: '📺', camera: '📷',
  camera_flash: '📸', video_camera: '📹', bulb: '💡', flashlight: '🔦',
  candle: '🕯️', money_with_wings: '💸', dollar: '💵', yen: '💴',
  euro: '💶', pound: '💷', moneybag: '💰', gem: '💎', balance_scale: '⚖️',
  wrench: '🔧', hammer: '🔨', axe: '🪓', pick: '⛏️', hammer_and_pick: '⚒️',
  hammer_and_wrench: '🛠️', dagger: '🗡️', sword: '⚔️', shield: '🛡️',
  smoking: '🚬', coffin: '⚰️', urn: '⚱️', amphora: '🏺', telescope: '🔭',
  microscope: '🔬', stethoscope: '🩺', pill: '💊', syringe: '💉',
  dna: '🧬', microbe: '🦠', petri_dish: '🧫', test_tube: '🧪',
  adhesive_bandage: '🩹', drop_of_blood: '🩸', goggles: '🥽', lab_coat: '🥼',
  safety_vest: '🦺', scissors: '✂️', card_index_dividers: '🗂️',
  card_box: '🗃️', wastebasket: '🗑️', file_cabinet: '🗄️',
  clipboard: '📋', spiral_notepad: '🗒️', spiral_calendar: '🗓️',
  calendar: '📅', date: '📅', card_index: '📇', chart_with_upwards_trend: '📈',
  chart_with_downwards_trend: '📉', bar_chart: '📊',
  memo: '📝', pencil: '📝', pencil2: '✏️', pen: '🖊️', fountain_pen: '🖋️',
  black_nib: '✒️', paintbrush: '🖌️', crayon: '🖍️', paperclip: '📎',
  paperclips: '🖇️', straight_ruler: '📏', triangular_ruler: '📐',
  bookmark_tabs: '📑', package: '📦', mailbox: '📫', mailbox_closed: '📪',
  mailbox_with_mail: '📬', mailbox_with_no_mail: '📭', postbox: '📮',
  email: '📧', envelope: '✉️', envelope_with_arrow: '📩', inbox_tray: '📥',
  outbox_tray: '📤', file_folder: '📁', open_file_folder: '📂',
  card_file_box: '🗃️', bookmark: '🔖', label: '🏷️', moneybag2: '💰',
  pushpin: '📌', round_pushpin: '📍', lock: '🔒', unlock: '🔓',
  lock_with_ink_pen: '🔏', key: '🔑', old_key: '🗝️', hammer2: '🔨',
  pick2: '⛏️', link: '🔗', chains: '⛓️', hook: '🪝', toolbox: '🧰',
  magnet: '🧲', ladder: '🪜', brick: '🧱', mirror: '🪞', door: '🚪',
  couch_and_lamp: '🛋️', chair: '🪑', toilet: '🚽', shower: '🚿',
  bathtub: '🛁', safety_pin: '🧷', broom: '🧹', basket: '🧺',
  roll_of_paper: '🧻', soap: '🧼', sponge: '🧽', lotion_bottle: '🧴',
  thread: '🧵', yarn: '🧶', eyeglasses: '👓', goggles2: '🥽',
  lab_coat2: '🥼', briefcase: '💼', handbag: '👜', purse: '👛',
  shopping: '🛍️', backpack: '🎒', luggage: '🧳', umbrella: '☂️',
  umbrella_on_ground: '⛱️', parasol_on_ground: '⛱️',

  // Celebration
  tada: '🎉', confetti_ball: '🎊', balloon: '🎈', gift: '🎁',
  ribbon: '🎀', ticket: '🎟️', tickets: '🎫', fireworks: '🎆',
  sparkler: '🎇', party_popper: '🎉', christmas_tree: '🎄',
  jack_o_lantern: '🎃', snowman: '⛄', snowflake: '❄️',

  // Flags (a few common ones)
  checkered_flag: '🏁', triangular_flag_on_post: '🚩', crossed_flags: '🎌',
  black_flag: '🏴', white_flag: '🏳️', rainbow_flag: '🏳️‍🌈',

  // Misc useful
  100: '💯', soon2: '🔜', back2: '🔙', information_source: 'ℹ️',
  abc: '🔤', ab: '🆎', cl: '🆑', cool2: '🆒', free2: '🆓',
  sos3: '🆘', vs: '🆚', koko: '🈁', sa: '🈂️',
  secret: '㊙️', congratulations: '㊗️',
};

export function applyEmoji(text: string): string {
  return text.replace(/:([a-zA-Z0-9_+\-]+):/g, (match, name: string) => EMOJI[name] ?? match);
}
