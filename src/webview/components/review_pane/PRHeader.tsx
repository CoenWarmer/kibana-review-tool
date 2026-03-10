import { useEffect, useRef, useState } from 'react';
import type { GhPullRequest } from '../../types';
import type { BuildkiteSummaryItem } from '../../utils';
import type { ReviewingPaneProps } from './ReviewingPane';
import { Spinner } from '../Spinner';
import { FileOwnershipRow } from './FileOwnershipRow';
import { TeamsTable } from './TeamTable';

const PR_HEADER_MAX_HEIGHT = 370;

export function PrHeader({
  pr,
  ciBuilds,
  ciBuildsLoading,
  cfFiles,
  cfOwnedByMePaths,
}: { pr: GhPullRequest; ciBuilds: BuildkiteSummaryItem[]; ciBuildsLoading: boolean } & Pick<
  ReviewingPaneProps,
  | 'checkoutBusy'
  | 'checkoutStage'
  | 'esStatus'
  | 'kibanaStatus'
  | 'checkedOutPrNumber'
  | 'cfFiles'
  | 'cfOwnedByMePaths'
>) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const innerRef = useRef<HTMLDivElement>(null);

  // Measure after mount and whenever the PR changes.
  useEffect(() => {
    setExpanded(false);
    // Read on next frame so the DOM has been painted.
    const id = requestAnimationFrame(() => {
      if (innerRef.current) {
        setOverflows(innerRef.current.scrollHeight > PR_HEADER_MAX_HEIGHT);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [pr.number]);

  return (
    <>
      <div
        ref={innerRef}
        className={`pr-header-collapsible${overflows && !expanded ? ' pr-header-clipped' : ''}`}
        style={expanded ? undefined : { maxHeight: PR_HEADER_MAX_HEIGHT, overflow: 'hidden' }}
      >
        <h2 className="pr-desc-title">
          <a href={pr.url} target="_blank" rel="noreferrer" className="pr-num">
            #{pr.number}
          </a>{' '}
          {pr.title}
        </h2>

        <div className="pr-info">
          <div className="info-row">
            <span className="label">Author</span>
            <span>{pr.author.login}</span>
          </div>
          <div className="info-row">
            <span className="label">Branch</span>
            <code>{pr.headRefName}</code>
          </div>

          <div className="info-row">
            <span className="label">Build</span>
            {ciBuildsLoading ? (
              <Spinner />
            ) : ciBuilds.length > 0 ? (
              ciBuilds.map((b) => (
                <span className="ci-status" key={b.pipelineName}>
                  <span className={`bk-icon ${b.cls}`}>{b.icon}</span>{' '}
                  <a href={b.url} className="bk-link">
                    #{b.buildNumber}
                  </a>{' '}
                </span>
              ))
            ) : (
              <span className="info-empty">—</span>
            )}
          </div>

          <FileOwnershipRow
            cfFiles={cfFiles}
            cfOwnedByMePaths={cfOwnedByMePaths}
            previewFiles={pr.files}
          />
          <TeamsTable pr={pr} />
        </div>
      </div>

      {overflows && !expanded && (
        <button className="pr-header-see-all" onClick={() => setExpanded(true)}>
          See all
        </button>
      )}
    </>
  );
}
