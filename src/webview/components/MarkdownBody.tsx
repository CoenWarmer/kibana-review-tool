import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import type { Components } from 'react-markdown';
import {
  applyEmoji,
  extractBuildkiteSummary,
  renderMarkdown,
  escHtml,
  type BuildkiteSummaryItem,
} from '../utils';

interface Props {
  content: string;
  repoUrl?: string;
}

/**
 * Pre-processes the raw markdown string before handing it to react-markdown.
 *
 * Responsibilities:
 * 1. Extract and pre-render <details> blocks so their inner markdown is rendered
 *    correctly (GitHub-specific: markdown inside <details> is rendered as markdown).
 * 2. Strip HTML comments (except Buildkite ones, already extracted by extractBuildkiteSummary).
 * 3. Remove GitHub's empty-tag auto-link suppression trick (e.g. `#<span></span>6`).
 * 4. Convert [[text]](url) → [text](url) (GitHub bot double-bracket links).
 * 5. Apply emoji shortcodes.
 * 6. Convert bare #NNN issue refs → markdown links.
 */
function preprocessMarkdown(text: string, repoUrl?: string): string {
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Strip Buildkite CI comment blocks (rendered separately as React components).
  text = text.replace(
    /<!--buildkite-pr-comment-([^\n]+)\n([\s\S]*?)\nbuildkite-pr-comment-->/g,
    ''
  );

  // Pre-render <details> blocks so inner markdown renders correctly.
  // We process innermost-first (the regex only matches a <details> whose body
  // contains no nested <details> opening tag), then restore in reverse order
  // so outer placeholders resolve inner ones correctly.
  const liftedDetails: string[] = [];
  let detailsFound = true;
  while (detailsFound) {
    detailsFound = false;
    text = text.replace(
      /<details[^>]*>((?:(?!<details)[\s\S])*?)<\/details>/gi,
      (_, inner: string) => {
        detailsFound = true;
        const summaryMatch = inner.match(/^\s*<summary>([\s\S]*?)<\/summary>\s*/i);
        const summaryHtml = summaryMatch ? escHtml(summaryMatch[1].trim()) : '';
        const bodyText = summaryMatch ? inner.slice(summaryMatch[0].length) : inner;
        // Render inner body with the existing HTML renderer — it handles nested
        // details (via its own recursive call) and all standard markdown elements.
        const renderedBody = bodyText.trim() ? renderMarkdown(bodyText, repoUrl) : '';
        liftedDetails.push(
          `<details class="md-details"><summary class="md-details-summary">${summaryHtml}</summary>` +
            `<div class="md-details-body">${renderedBody}</div></details>`
        );
        return `\x00DETAILS${liftedDetails.length - 1}\x00`;
      }
    );
  }

  // Strip remaining HTML comments.
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Remove GitHub's empty-tag auto-link suppression (e.g. `Jest Tests #<span></span>6`).
  text = text.replace(/<(?!details\b)([a-zA-Z]+)[^>]*><\/\1>/g, '');

  // Convert [[text]](url) → [text](url) (GitHub bot double-bracket links).
  text = text.replace(/\[\[([^\]]+)\]\]\((https?:\/\/[^)]+)\)/g, '[$1]($2)');

  // Apply emoji shortcodes (:smile: → 😄 etc.).
  text = applyEmoji(text);

  // Convert bare #NNN refs → markdown links when repoUrl is known.
  if (repoUrl) {
    text = text.replace(
      /(^|[\s(,;])#(\d+)/gm,
      (_, pre, n) => `${pre}[#${n}](${repoUrl}/issues/${n})`
    );
  }

  // Restore pre-rendered <details> blocks (reverse order so outer → inner resolves).
  for (let i = liftedDetails.length - 1; i >= 0; i--) {
    text = text.replace(`\x00DETAILS${i}\x00`, liftedDetails[i]);
  }

  return text;
}

/** Recursively flatten React children to a plain string for comparison. */
function flattenChildren(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(flattenChildren).join('');
  if (children != null && typeof children === 'object' && 'props' in children) {
    return flattenChildren((children as { props: { children?: ReactNode } }).props.children);
  }
  return '';
}

function BuildkiteWidgets({ builds }: { builds: BuildkiteSummaryItem[] }) {
  if (builds.length === 0) return null;
  return (
    <div className="bk-widgets">
      {builds.map((b) => (
        <div className="bk-widget" key={b.pipelineName}>
          <div className="bk-header">
            <span className="bk-logo">▶</span>
            <span className="bk-title">Buildkite · {b.pipelineName}</span>
          </div>
          <div className="bk-row">
            <span className={`bk-icon ${b.cls}`}>{b.icon}</span>
            <a className="bk-link" href={b.url}>
              #{b.buildNumber}
            </a>
            <span className={`bk-state ${b.cls}`}>{b.state}</span>
            {b.hasRetries && <span className="bk-retry">has retries</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Renders GitHub-flavoured markdown as React. Replaces the old `dangerouslySetInnerHTML`
 * approach with react-markdown + remark-gfm (tables, task lists, strikethrough, autolinks)
 * + rehype-raw (pass-through raw HTML such as pre-rendered <details> blocks).
 */
export function MarkdownBody({ content, repoUrl }: Props) {
  if (!content.trim()) {
    return (
      <p>
        <em>No description provided.</em>
      </p>
    );
  }

  const bkBuilds = extractBuildkiteSummary(content);
  const processed = preprocessMarkdown(content, repoUrl);

  const components: Components = {
    // Custom link renderer: shorten bare GitHub PR/issue URLs and render bare
    // video/image attachment URLs as their respective media elements.
    a: ({ href, children }) => {
      if (href) {
        const childText = flattenChildren(children as ReactNode);

        // Bare GitHub video attachment → <video>
        if (childText === href && /^https:\/\/github\.com\/user-attachments\/assets\//.test(href)) {
          return (
            <div className="media-wrap">
              <video controls preload="metadata" src={href}>
                <a href={href}>View video</a>
              </video>
            </div>
          );
        }

        // Bare githubusercontent image URL → <img>
        if (
          childText === href &&
          /^https:\/\/(?:user-images|camo)\.githubusercontent\.com\//.test(href)
        ) {
          return (
            <div className="media-wrap">
              <img src={href} alt="attachment" />
            </div>
          );
        }

        // Shorten bare GitHub PR/issue URLs (auto-linked by remark-gfm).
        const m = href.match(
          /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:pull|issues)\/(\d+)(#[^\s]*)?$/
        );
        if (m && childText === href) {
          const [, owner, repo, num, fragment] = m;
          const isSameRepo = repoUrl && `https://github.com/${owner}/${repo}` === repoUrl;
          const ref = isSameRepo ? `#${num}` : `${owner}/${repo}#${num}`;
          const suffix = fragment ? ' (comment)' : '';
          return <a href={href}>{`${ref}${suffix}`}</a>;
        }
      }

      return <a href={href}>{children}</a>;
    },

    // Images: ensure they never overflow their container.
    img: ({ src, alt }) => <img src={src} alt={alt ?? ''} />,
  };

  return (
    <>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={components}
      >
        {processed}
      </ReactMarkdown>
      <BuildkiteWidgets builds={bkBuilds} />
    </>
  );
}
