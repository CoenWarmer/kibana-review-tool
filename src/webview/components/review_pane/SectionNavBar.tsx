import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshIcon } from '../icons/RefreshIcon';
import type { GhPullRequest } from '../../types';
import { Spinner } from '../Spinner';
import { PlayCircleIcon } from '../icons/PlayCircleIcon';
import { DoneIcon } from '../icons/DoneIcon';
import { DownloadIcon } from '../icons/DownloadIcon';

const NAV_ITEMS: Array<{ id: string | null; label: string }> = [
  { id: null, label: 'Top' },
  { id: 'description-section', label: 'Description' },
  { id: 'files-section', label: 'Files' },
  { id: 'discussion-section', label: 'Discussion' },
];

const SECTION_IDS = ['description-section', 'files-section', 'discussion-section'];

interface SectionNavBarProps {
  pr: GhPullRequest;
  checkoutBusy: boolean;
  checkoutStage: string;
  checkedOutPrNumber: number | null;
  isKibanaRepo: boolean;
  devEnvOpen: boolean;
  onToggleDevEnv: () => void;
}

export function SectionNavBar({
  pr,
  checkoutBusy,
  checkoutStage,
  checkedOutPrNumber,
  isKibanaRepo,
  devEnvOpen,
  onToggleDevEnv,
}: SectionNavBarProps) {
  const [active, setActive] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const isCheckedOut = pr.number === checkedOutPrNumber;

  // Clear spinner once PR data arrives after a refresh
  const prevPrRef = useRef(pr);
  useEffect(() => {
    if (refreshing && pr !== prevPrRef.current) {
      setRefreshing(false);
    }
    prevPrRef.current = pr;
  }, [pr, refreshing]);

  const scrollTo = useCallback((id: string | null) => {
    const nav = navRef.current;
    if (!nav) return;
    const pane = findScrollParent(nav);
    if (!pane) return;

    if (!id) {
      pane.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      setActive(null);
      return;
    }
    const el = document.getElementById(id);
    if (el) {
      const top =
        el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
      pane.scrollTo({ top, behavior: 'instant' as ScrollBehavior });
      setActive(id);
    }
  }, []);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const pane = findScrollParent(nav);
    if (!pane) return;

    const handleScroll = () => {
      if (pane.scrollTop < 60) {
        setActive(null);
        return;
      }
      const paneTop = pane.getBoundingClientRect().top;
      // 50px threshold: section becomes active when its header is within 50px of the pane top
      const triggerY = paneTop + 50;
      let latest: string | null = null;
      for (const id of SECTION_IDS) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= triggerY) {
          latest = id;
        }
      }
      setActive(latest);
    };

    pane.addEventListener('scroll', handleScroll, { passive: true });
    // Sync on mount in case the pane is already scrolled
    handleScroll();
    return () => pane.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <nav ref={navRef} className="section-nav">
      {NAV_ITEMS.map(({ id, label }) => (
        <button
          key={label}
          className={`section-nav-btn${active === id ? ' active' : ''}`}
          onClick={() => scrollTo(id)}
        >
          {label}
        </button>
      ))}
      <div className="section-nav-actions">
        <button
          className={`checkout-btn${checkoutBusy ? ' busy' : ''}`}
          disabled={isCheckedOut || checkoutBusy}
          onClick={() => postMessage({ type: 'checkout' })}
        >
          {checkoutBusy ? (
            <>
              <Spinner className="spinner-mr" />
              {checkoutStage || 'Checking out…'}
            </>
          ) : isCheckedOut ? (
            <>
              <DoneIcon color="#C5C5C5" width={16} height={16} />
              Checked out
            </>
          ) : (
            <>
              <DownloadIcon color="#C5C5C5" width={16} height={16} />
              Checkout
            </>
          )}
        </button>
        <button
          className="refresh-btn"
          title="Refresh PR data"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            postMessage({ type: 'refreshPR' });
          }}
        >
          {refreshing ? <Spinner /> : <RefreshIcon color="#C5C5C5" />}
        </button>
        <button
          className={`dev-env-toggle-btn${devEnvOpen ? ' active' : ''}`}
          title={
            isKibanaRepo
              ? devEnvOpen
                ? 'Hide dev environment'
                : 'Show dev environment'
              : 'Only available in elastic/kibana'
          }
          disabled={!isKibanaRepo}
          onClick={onToggleDevEnv}
        >
          <PlayCircleIcon color="#C5C5C5" />
        </button>
      </div>
    </nav>
  );
}

/** Walks up the DOM to find the nearest ancestor with overflow-y scroll/auto. */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const oy = getComputedStyle(cur).overflowY;
    if (oy === 'auto' || oy === 'scroll') return cur;
    cur = cur.parentElement;
  }
  return null;
}
