import { useState, useEffect, useRef, useCallback } from 'react';
import type { ReactElement } from 'react';
import { postMessage } from '../../vscode';
import { cfBuildTree, cfCompactFolders, cfStatusIcon, normalizeFileStatus } from '../../utils';
import type { CfTreeChild } from '../../utils';
import type {
  CommitFile,
  GhDiscussionComment,
  GhPrFile,
  OrderedFile,
  ReviewOrderSuggestion,
  OrderMode,
} from '../../types';
import { Spinner } from '../Spinner';
import { CommitLabel } from '../CommitLabel';

interface Props {
  files: OrderedFile[];
  activeFile: string | null;
  reviewedPaths: string[];
  ownedByMePaths: string[] | null;
  isLoading: boolean;
  errorMessage: string;
  suggestedOrder: ReviewOrderSuggestion | null;
  orderMode: OrderMode;
  isOrderLoading: boolean;
  /** Files from the PR detail API — shown as a locked preview when not checked out. */
  previewFiles?: GhPrFile[];
  isCheckedOut: boolean;
  /** Commits on this PR, for the commit stepper. */
  commits: GhDiscussionComment[];
  /** Currently selected commit SHA in the stepper; null = All. */
  commitFilter: string | null;
  /** Files changed by the selected commit; null while loading. */
  commitFilterFiles: CommitFile[] | null;
  /** True while git diff-tree is running for the current commit selection. */
  commitFilterLoading: boolean;
  /** When set, each file row shows a commit-selection checkbox. */
  selectedForCommit?: Set<string>;
  onToggleFileForCommit?: (path: string) => void;
  onSelectAllFilesForCommit?: (paths: string[], select: boolean) => void;
}

export function FilesSection({
  files,
  activeFile,
  reviewedPaths,
  ownedByMePaths,
  isLoading,
  errorMessage,
  suggestedOrder,
  orderMode,
  isOrderLoading,
  previewFiles,
  isCheckedOut,
  commits,
  commitFilter,
  commitFilterFiles,
  commitFilterLoading,
  selectedForCommit,
  onToggleFileForCommit,
  onSelectAllFilesForCommit,
}: Props) {
  const [search, setSearch] = useState('');
  const [showOwnedByMe, setShowOwnedByMe] = useState(false);
  const reviewedSet = new Set(reviewedPaths);

  // Reset the filter whenever the owned-paths list is cleared (new checkout).
  useEffect(() => {
    if (ownedByMePaths === null) setShowOwnedByMe(false);
  }, [ownedByMePaths]);

  const hasSuggestion = suggestedOrder !== null;

  // Build a set of paths touched by the selected commit (null = no filter active).
  // These must be computed before any early return so that the useCallback below
  // is always called unconditionally (Rules of Hooks).
  const touchedPaths: Set<string> | null =
    commitFilter && commitFilterFiles ? new Set(commitFilterFiles.map((f) => f.path)) : null;

  // Map from path → CommitFile for rename lookup when opening commit diffs.
  const commitFileMap: Map<string, CommitFile> = commitFilterFiles
    ? new Map(commitFilterFiles.map((f) => [f.path, f]))
    : new Map();

  // Files that appear in the commit but not in the PR's net diff (e.g. a file added then
  // deleted within the same PR). Inject them as extra rows so they aren't invisible.
  const commitOnlyFiles: OrderedFile[] =
    commitFilter && commitFilterFiles
      ? commitFilterFiles
          .filter((cf) => !files.some((f) => f.path === cf.path))
          .map((cf) => ({ path: cf.path, additions: 0, deletions: 0, changeType: cf.status }))
      : [];

  const allFiles = commitOnlyFiles.length > 0 ? [...files, ...commitOnlyFiles] : files;
  const total = allFiles.length || (previewFiles?.length ?? 0);

  // "Select all" state — only relevant in My Branch mode when selectedForCommit is provided.
  const allPaths = allFiles.map((f) => f.path);
  const allSelected = allPaths.length > 0 && allPaths.every((p) => selectedForCommit?.has(p));
  const someSelected = !allSelected && allPaths.some((p) => selectedForCommit?.has(p));
  // useCallback must be called unconditionally — keep it above every early return.
  const selectAllRef = useCallback(
    (el: HTMLInputElement | null) => {
      if (el) el.indeterminate = someSelected;
    },
    [someSelected]
  );

  // When not checked out but we have preview files, show them under an overlay.
  if (!isCheckedOut && files.length === 0 && previewFiles && previewFiles.length > 0) {
    return <PreviewFileList previewFiles={previewFiles} />;
  }
  const visible =
    showOwnedByMe && ownedByMePaths
      ? allFiles.filter((f) => ownedByMePaths.includes(f.path))
      : allFiles;

  let body: React.ReactNode;
  if (isLoading) {
    body = (
      <div className="cf-status">
        <Spinner className="spinner-mr" /> Loading…
      </div>
    );
  } else if (errorMessage) {
    body = <div className="cf-status error">✕ {errorMessage}</div>;
  } else if (allFiles.length === 0) {
    body = (
      <div className="cf-status">
        {isCheckedOut ? 'No changed files.' : 'Checkout this PR to see changed files.'}
      </div>
    );
  } else {
    const q = search.trim().toLowerCase();
    const filtered = q ? visible.filter((f) => f.path.toLowerCase().includes(q)) : visible;

    // When a suggestion is active, sort files by suggestion order and build an
    // orderMap so FileRow can show the number badge and reason inside the tree.
    let orderMap: Map<string, { num: number; reason: string }> | undefined;
    let treeInput = filtered;
    if (orderMode !== 'default' && hasSuggestion) {
      const ordered = orderMode === 'top-down' ? suggestedOrder!.topDown : suggestedOrder!.bottomUp;
      orderMap = new Map(ordered.map((sf, i) => [sf.path, { num: i + 1, reason: sf.reason }]));
      const visibleMap = new Map(filtered.map((f) => [f.path, f]));
      // Sort filtered files by suggestion order; unranked files go to the end.
      treeInput = ordered
        .filter((sf) => visibleMap.has(sf.path))
        .map((sf) => visibleMap.get(sf.path)!);
    }

    const tree = cfCompactFolders(cfBuildTree(treeInput));
    const fileListNode = (
      <TreeChildren
        children={tree.children}
        activeFile={activeFile}
        reviewedSet={reviewedSet}
        touchedPaths={touchedPaths}
        commitFilter={commitFilter}
        commitFileMap={commitFileMap}
        orderMap={orderMap}
        selectedForCommit={selectedForCommit}
        onToggleFileForCommit={onToggleFileForCommit}
      />
    );

    body = (
      <>
        <div className="cf-toolbar">
          <div className="cf-toolbar-row">
            <input
              className="cf-search"
              type="text"
              placeholder="Filter files…"
              autoComplete="off"
              spellCheck={false}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {selectedForCommit ? (
              <label className="cf-select-all-label">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="commit-check commit-check-all"
                  title={allSelected ? 'Deselect all' : 'Select all'}
                  checked={allSelected}
                  onChange={() => onSelectAllFilesForCommit?.(allPaths, !allSelected)}
                  onClick={(e) => e.stopPropagation()}
                />
                Select all
              </label>
            ) : (
              <button
                className={`cf-filter-btn${showOwnedByMe ? ' active' : ''}`}
                title={
                  ownedByMePaths === null
                    ? 'Computing owned files…'
                    : showOwnedByMe
                      ? 'Show all files'
                      : 'Show only files I own'
                }
                disabled={ownedByMePaths === null}
                onClick={() => setShowOwnedByMe((v) => !v)}
              >
                👤 Owned by me
              </button>
            )}
          </div>

          <div className="cf-toolbar-row">
            <button
              className={`suggest-order-btn${isOrderLoading ? ' loading' : ''}`}
              disabled={isOrderLoading}
              title="Ask an LLM to suggest the best review order for these files"
              onClick={() => postMessage({ type: 'suggestOrder' })}
            >
              {isOrderLoading ? (
                <>
                  <Spinner className="spinner-mr" /> Analyzing…
                </>
              ) : (
                '✦ Suggest review order'
              )}
            </button>
            <div className="order-mode-toggle">
              {(['default', 'top-down', 'bottom-up'] as OrderMode[]).map((mode) => (
                <button
                  key={mode}
                  className={`order-mode-btn${orderMode === mode ? ' active' : ''}`}
                  disabled={mode !== 'default' && !hasSuggestion}
                  onClick={() => postMessage({ type: 'setOrderMode', mode })}
                >
                  {mode === 'default'
                    ? 'Default'
                    : mode === 'top-down'
                      ? '↓ Top-down'
                      : '↑ Bottom-up'}
                </button>
              ))}
            </div>
          </div>
          <CommitStepper
            commits={commits}
            commitFilter={commitFilter}
            isLoading={commitFilterLoading}
          />
        </div>

        <div className="cf-file-list">{fileListNode}</div>
      </>
    );
  }

  return (
    <>
      <div className="section-header">
        <span className="section-title">
          Changed Files
          {total > 0
            ? touchedPaths !== null
              ? ` (${allFiles.filter((f) => touchedPaths.has(f.path)).length}`
              : ` (${total})`
            : ''}
        </span>
      </div>
      <div className="cf-file-list-wrapper">{body}</div>
    </>
  );
}

function TreeChildren({
  children,
  activeFile,
  reviewedSet,
  touchedPaths,
  commitFilter,
  commitFileMap,
  orderMap,
  selectedForCommit,
  onToggleFileForCommit,
}: {
  children: CfTreeChild[];
  activeFile: string | null;
  reviewedSet: Set<string>;
  touchedPaths: Set<string> | null;
  commitFilter: string | null;
  commitFileMap: Map<string, CommitFile>;
  orderMap?: Map<string, { num: number; reason: string }>;
  selectedForCommit?: Set<string>;
  onToggleFileForCommit?: (path: string) => void;
}): ReactElement {
  return (
    <>
      {children.map((child, i) => {
        if (child.type === 'file') {
          const dimmed = touchedPaths !== null && !touchedPaths.has(child.file.path);
          return (
            <FileRow
              key={child.file.path}
              file={child.file}
              isActive={child.file.path === activeFile}
              isReviewed={reviewedSet.has(child.file.path)}
              dimmed={dimmed}
              commitFilter={commitFilter}
              commitFile={commitFileMap.get(child.file.path)}
              orderEntry={orderMap?.get(child.file.path)}
              selectedForCommit={selectedForCommit}
              onToggleFileForCommit={onToggleFileForCommit}
            />
          );
        }
        return (
          <details key={child.name + i} className="folder" open>
            <summary className="folder-row">
              <span className="fold-arrow">▶</span>
              <span className="fold-name">{child.name}</span>
            </summary>
            <div className="folder-contents">
              <TreeChildren
                children={child.children}
                activeFile={activeFile}
                reviewedSet={reviewedSet}
                touchedPaths={touchedPaths}
                commitFilter={commitFilter}
                commitFileMap={commitFileMap}
                orderMap={orderMap}
                selectedForCommit={selectedForCommit}
                onToggleFileForCommit={onToggleFileForCommit}
              />
            </div>
          </details>
        );
      })}
    </>
  );
}

function FileRow({
  file,
  isActive,
  isReviewed,
  dimmed = false,
  commitFilter = null,
  commitFile,
  orderEntry,
  selectedForCommit,
  onToggleFileForCommit,
}: {
  file: OrderedFile;
  isActive: boolean;
  isReviewed: boolean;
  dimmed?: boolean;
  commitFilter?: string | null;
  commitFile?: CommitFile;
  orderEntry?: { num: number; reason: string };
  selectedForCommit?: Set<string>;
  onToggleFileForCommit?: (path: string) => void;
}) {
  const status = normalizeFileStatus(file);
  const { icon, colorClass } = cfStatusIcon(status);
  const fileName = file.path.split('/').pop() ?? file.path;
  const handleClick = () => {
    if (commitFilter && commitFile) {
      postMessage({
        type: 'openCommitFile',
        sha: commitFilter,
        path: commitFile.path,
        beforePath: commitFile.beforePath,
      });
    } else if (!commitFilter) {
      postMessage({ type: 'openFile', path: file.path });
    }
  };
  return (
    <>
      <div
        className={`file-row${isActive ? ' active' : ''}${isReviewed ? ' reviewed' : ''}${dimmed ? ' cf-file-dimmed' : ''}`}
        data-path={file.path}
        onClick={dimmed ? undefined : handleClick}
      >
        {selectedForCommit ? (
          <input
            type="checkbox"
            className="commit-check"
            title="Include in commit"
            checked={selectedForCommit.has(file.path)}
            onChange={(e) => {
              e.stopPropagation();
              onToggleFileForCommit?.(file.path);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <input
            type="checkbox"
            className="review-check"
            title="Mark as reviewed"
            checked={isReviewed}
            onChange={(e) => {
              e.stopPropagation();
              postMessage({ type: 'toggleReviewed', path: file.path });
            }}
            onClick={(e) => e.stopPropagation()}
          />
        )}
        {orderEntry && <span className="ordered-num">{orderEntry.num}</span>}
        <span className={`status-icon ${colorClass}`} title={status}>
          {icon}
        </span>
        <span className="cf-file-name">{fileName}</span>
        <span className="cf-stats">
          {(commitFile?.additions ?? file.additions) > 0 && (
            <span className="cf-adds">+{commitFile?.additions ?? file.additions}</span>
          )}
          {(commitFile?.deletions ?? file.deletions) > 0 && (
            <span className="cf-dels">-{commitFile?.deletions ?? file.deletions}</span>
          )}
        </span>
      </div>
      {orderEntry?.reason && <div className="order-reason">{orderEntry.reason}</div>}
    </>
  );
}

// ─── Commit stepper ───────────────────────────────────────────────────────────

function CommitStepper({
  commits,
  commitFilter,
  isLoading,
}: {
  commits: GhDiscussionComment[];
  commitFilter: string | null;
  isLoading: boolean;
}) {
  const idx = commitFilter ? commits.findIndex((c) => c.commitSha === commitFilter) : -1;
  const total = commits.length;

  const select = (sha: string | null) => {
    postMessage({ type: 'selectCommitFilter', sha });
  };

  const activeCommit = idx >= 0 ? commits[idx] : null;

  const empty = total === 0;

  return (
    <div className="commit-stepper">
      <button
        className={`commit-stepper-all${idx === -1 ? ' active' : ''}`}
        disabled={empty}
        onClick={() => select(null)}
        title="Show all changes"
      >
        All
      </button>
      <button
        className="commit-stepper-nav"
        disabled={empty || (idx === -1 ? true : idx === 0)}
        onClick={() => {
          if (idx === -1) return;
          if (idx === 0) select(null);
          else select(commits[idx - 1].commitSha!);
        }}
        title="Previous commit"
      >
        ←
      </button>
      <span className="commit-stepper-label">
        {empty ? (
          <span className="commit-stepper-hint">no commits yet</span>
        ) : idx === -1 ? (
          <span className="commit-stepper-hint">step through commits →</span>
        ) : (
          <>
            <span className="commit-stepper-pos">
              {idx + 1}/{total}
            </span>
            {isLoading ? (
              <Spinner className="spinner-mr" />
            ) : (
              activeCommit && (
                <CommitLabel sha={activeCommit.commitSha!} message={activeCommit.body} />
              )
            )}
          </>
        )}
      </span>
      <button
        className="commit-stepper-nav"
        disabled={empty || idx >= total - 1}
        onClick={() => {
          const next = idx === -1 ? 0 : idx + 1;
          if (next < total) select(commits[next].commitSha!);
        }}
        title="Next commit"
      >
        →
      </button>
    </div>
  );
}

// ─── Preview file list ────────────────────────────────────────────────────────

const PREVIEW_MAX_HEIGHT = 500;

function PreviewFileList({ previewFiles }: { previewFiles: GhPrFile[] }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setExpanded(false);
    const id = requestAnimationFrame(() => {
      if (listRef.current) {
        setOverflows(listRef.current.scrollHeight > PREVIEW_MAX_HEIGHT);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [previewFiles.length]);

  return (
    <>
      <div className="section-header">
        <span className="section-title">Changed Files ({previewFiles.length})</span>
      </div>
      <div
        ref={listRef}
        className="cf-file-list-wrapper cf-locked"
        style={expanded ? undefined : { maxHeight: PREVIEW_MAX_HEIGHT, overflow: 'hidden' }}
      >
        <div className="cf-file-list">
          {previewFiles.map((f) => {
            const fileName = f.path.split('/').pop() ?? f.path;
            return (
              <div key={f.path} className="file-row">
                <span className="cf-file-name" title={f.path}>
                  {fileName}
                </span>
                <span className="cf-stats">
                  {f.additions > 0 && <span className="cf-adds">+{f.additions}</span>}
                  {f.deletions > 0 && <span className="cf-dels">-{f.deletions}</span>}
                </span>
              </div>
            );
          })}
        </div>
        <div className="cf-locked-overlay">
          <button className="cf-locked-message" onClick={() => postMessage({ type: 'checkout' })}>
            Check out branch to see files
          </button>
        </div>
      </div>
      {overflows && !expanded && (
        <button className="pr-header-see-all" onClick={() => setExpanded(true)}>
          See all {previewFiles.length} files
        </button>
      )}
    </>
  );
}
