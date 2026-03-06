import { useState } from 'react';
import type { ReactElement } from 'react';
import { postMessage } from '../vscode';
import { cfBuildTree, cfCompactFolders, cfStatusIcon, normalizeFileStatus } from '../utils';
import type { CfTreeChild } from '../utils';
import type { OrderedFile, ReviewOrderSuggestion, OrderMode } from '../types';

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
}

export function FilesSection({
  files, activeFile, reviewedPaths, ownedByMePaths,
  isLoading, errorMessage, suggestedOrder, orderMode, isOrderLoading,
}: Props) {
  const [search, setSearch] = useState('');
  const reviewedSet = new Set(reviewedPaths);

  const total = files.length;
  const visible = ownedByMePaths
    ? files.filter((f) => ownedByMePaths.includes(f.path))
    : files;
  const hasSuggestion = suggestedOrder !== null;

  let body: React.ReactNode;
  if (isLoading) {
    body = <div className="cf-status"><span className="cf-spin">⟳</span> Loading…</div>;
  } else if (errorMessage) {
    body = <div className="cf-status error">✕ {errorMessage}</div>;
  } else if (files.length === 0) {
    body = <div className="cf-status">Checkout this PR to see changed files.</div>;
  } else {
    const q = search.trim().toLowerCase();
    const filtered = q ? visible.filter((f) => f.path.toLowerCase().includes(q)) : visible;

    let fileListNode: React.ReactNode;
    if (orderMode !== 'default' && hasSuggestion) {
      const ordered = orderMode === 'top-down' ? suggestedOrder!.topDown : suggestedOrder!.bottomUp;
      const visibleMap = new Map(filtered.map((f) => [f.path, f]));
      fileListNode = ordered
        .filter((sf) => visibleMap.has(sf.path))
        .map((sf, i) => (
          <OrderedFileRow
            key={sf.path}
            file={visibleMap.get(sf.path)!}
            reason={sf.reason}
            num={i + 1}
            isActive={sf.path === activeFile}
            isReviewed={reviewedSet.has(sf.path)}
          />
        ));
    } else {
      const tree = cfCompactFolders(cfBuildTree(filtered));
      fileListNode = (
        <TreeChildren
          children={tree.children}
          activeFile={activeFile}
          reviewedSet={reviewedSet}
        />
      );
    }

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
            <button
              className={`cf-filter-btn${ownedByMePaths ? ' active' : ''}`}
              title={ownedByMePaths ? 'Show all files' : 'Show only files I own'}
              onClick={() => postMessage({ type: 'toggleOwnedByMe' })}
            >
              👤 Owned by me
            </button>
          </div>
          <div className="cf-toolbar-row">
            <button
              className={`suggest-order-btn${isOrderLoading ? ' loading' : ''}`}
              disabled={isOrderLoading}
              title="Ask an LLM to suggest the best review order for these files"
              onClick={() => postMessage({ type: 'suggestOrder' })}
            >
              {isOrderLoading ? <><span className="cf-spin">⟳</span> Analyzing…</> : '✦ Suggest review order'}
            </button>
            <div className="order-mode-toggle">
              {(['default', 'top-down', 'bottom-up'] as OrderMode[]).map((mode) => (
                <button
                  key={mode}
                  className={`order-mode-btn${orderMode === mode ? ' active' : ''}`}
                  disabled={mode !== 'default' && !hasSuggestion}
                  onClick={() => postMessage({ type: 'setOrderMode', mode })}
                >
                  {mode === 'default' ? 'Default' : mode === 'top-down' ? '↓ Top-down' : '↑ Bottom-up'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="cf-file-list">
          {fileListNode}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="section-header">
        <span className="section-title">Changed Files{total > 0 ? ` (${total})` : ''}</span>
      </div>
      <div className="cf-file-list-wrapper">
        {body}
      </div>
    </>
  );
}

function OrderedFileRow({ file, reason, num, isActive, isReviewed }: {
  file: OrderedFile; reason: string; num: number; isActive: boolean; isReviewed: boolean;
}) {
  const status = normalizeFileStatus(file);
  const { icon, colorClass } = cfStatusIcon(status);
  return (
    <>
      <div
        className={`file-row${isActive ? ' active' : ''}${isReviewed ? ' reviewed' : ''}`}
        data-path={file.path}
        onClick={() => postMessage({ type: 'openFile', path: file.path })}
      >
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
        <span className="ordered-num">{num}</span>
        <span className={`status-icon ${colorClass}`} title={status}>{icon}</span>
        <span className="cf-file-name">{file.path}</span>
        <span className="cf-stats">
          {file.additions > 0 && <span className="cf-adds">+{file.additions}</span>}
          {file.deletions > 0 && <span className="cf-dels">-{file.deletions}</span>}
        </span>
      </div>
      {reason && <div className="order-reason">{reason}</div>}
    </>
  );
}

function TreeChildren({ children, activeFile, reviewedSet }: {
  children: CfTreeChild[]; activeFile: string | null; reviewedSet: Set<string>;
}): ReactElement {
  return (
    <>
      {children.map((child, i) => {
        if (child.type === 'file') {
          return (
            <FileRow
              key={child.file.path}
              file={child.file}
              isActive={child.file.path === activeFile}
              isReviewed={reviewedSet.has(child.file.path)}
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
              <TreeChildren children={child.children} activeFile={activeFile} reviewedSet={reviewedSet} />
            </div>
          </details>
        );
      })}
    </>
  );
}

function FileRow({ file, isActive, isReviewed }: { file: OrderedFile; isActive: boolean; isReviewed: boolean }) {
  const status = normalizeFileStatus(file);
  const { icon, colorClass } = cfStatusIcon(status);
  const fileName = file.path.split('/').pop() ?? file.path;
  return (
    <div
      className={`file-row${isActive ? ' active' : ''}${isReviewed ? ' reviewed' : ''}`}
      data-path={file.path}
      onClick={() => postMessage({ type: 'openFile', path: file.path })}
    >
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
      <span className={`status-icon ${colorClass}`} title={status}>{icon}</span>
      <span className="cf-file-name">{fileName}</span>
      <span className="cf-stats">
        {file.additions > 0 && <span className="cf-adds">+{file.additions}</span>}
        {file.deletions > 0 && <span className="cf-dels">-{file.deletions}</span>}
      </span>
    </div>
  );
}
