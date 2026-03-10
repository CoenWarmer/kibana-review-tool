import type { GhPrFile } from '../../types';
import { Spinner } from '../Spinner';
import type { ReviewingPaneProps } from './ReviewingPane';

export function FileOwnershipRow({
  cfFiles,
  cfOwnedByMePaths,
  previewFiles,
}: Pick<ReviewingPaneProps, 'cfFiles' | 'cfOwnedByMePaths'> & { previewFiles?: GhPrFile[] }) {
  // Prefer the live checkout file list; fall back to the PR detail preview list.
  const files = cfFiles.length > 0 ? cfFiles : (previewFiles ?? []);

  // Ownership (and possibly files) still loading — keep the row visible with a spinner
  // so the label is always present and there is no layout jump when data arrives.
  if (cfOwnedByMePaths === null) {
    return (
      <div className="info-row">
        <span className="label">Files</span>
        <Spinner />
      </div>
    );
  }

  // Everything loaded but this PR genuinely has no files — hide the row.
  if (files.length === 0) return null;

  const ownedSet = new Set(cfOwnedByMePaths);
  const mine = files.filter((f) => ownedSet.has(f.path)).length;
  const other = files.length - mine;
  const total = files.length;
  const minePct = total > 0 ? (mine / total) * 100 : 0;

  return (
    <div className="info-row">
      <span className="label">Files</span>
      <div className="files-ownership">
        <div
          className="files-ownership-bar"
          title={`${mine} owned by my team, ${other} owned by other teams`}
        >
          <div className="files-ownership-mine" style={{ width: `${minePct}%` }} />
          <div className="files-ownership-other" style={{ width: `${100 - minePct}%` }} />
        </div>
        <span className="files-ownership-counts">
          <span className="files-ownership-mine-label">{mine} owned by my team</span>
          {' · '}
          <span className="files-ownership-other-label">{other} owned by others</span>
        </span>
      </div>
    </div>
  );
}
