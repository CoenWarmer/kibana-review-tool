import { useEffect, useRef, useState } from 'react';
import { postMessage } from '../../vscode';
import { ageLabel } from '../../utils';
import type { GhDiscussionComment } from '../../types';
import { MarkdownBody } from '../MarkdownBody';
import { CommitLabel } from '../CommitLabel';

const HIDDEN_USERS_KEY = 'disc-hidden-users';

function loadHiddenUsers(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_USERS_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveHiddenUsers(hidden: Set<string>): void {
  localStorage.setItem(HIDDEN_USERS_KEY, JSON.stringify([...hidden]));
}

interface Props {
  comments: GhDiscussionComment[];
  repoUrl: string;
  onCommentPosted: boolean;
  onReviewSubmitted: { event: 'APPROVE' | 'REQUEST_CHANGES' } | null;
  onClearFeedback: () => void;
}

export function DiscussionSection({
  comments,
  repoUrl,
  onCommentPosted,
  onReviewSubmitted,
  onClearFeedback,
}: Props) {
  const [body, setBody] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);
  const [approveBusy, setApproveBusy] = useState(false);
  const [requestBusy, setRequestBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hiddenUsers, setHiddenUsers] = useState<Set<string>>(loadHiddenUsers);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  // Unique commenters ordered by first appearance.
  const commenters = Array.from(
    new Map(comments.map((c) => [c.author, { login: c.author, avatarUrl: c.avatarUrl }])).values()
  );

  const toggleUser = (login: string) => {
    setHiddenUsers((prev) => {
      const next = new Set(prev);
      if (next.has(login)) {
        next.delete(login);
      } else {
        next.add(login);
      }
      saveHiddenUsers(next);
      return next;
    });
  };

  // Close dropdown when clicking outside.
  useEffect(() => {
    if (!filterOpen) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [filterOpen]);

  const showStatus = (msg: string) => {
    setStatusMsg(msg);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatusMsg(''), 3000);
  };

  useEffect(() => {
    if (onCommentPosted) {
      setBody('');
      setCommentBusy(false);
      showStatus('✓ Posted');
      onClearFeedback();
    }
  }, [onCommentPosted]);

  useEffect(() => {
    if (onReviewSubmitted) {
      setBody('');
      setApproveBusy(false);
      setRequestBusy(false);
      showStatus(onReviewSubmitted.event === 'APPROVE' ? '✓ Approved' : '✓ Changes requested');
      onClearFeedback();
    }
  }, [onReviewSubmitted]);

  const handleComment = () => {
    if (!body.trim()) return;
    setCommentBusy(true);
    postMessage({ type: 'postComment', body: body.trim() });
  };

  const handleApprove = () => {
    setApproveBusy(true);
    postMessage({ type: 'approveReview', body });
  };

  const handleRequestChanges = () => {
    setRequestBusy(true);
    postMessage({ type: 'requestChanges', body });
  };

  const visibleComments = comments.filter((c) => !hiddenUsers.has(c.author));
  const hiddenCount = comments.length - visibleComments.length;

  return (
    <>
      <div className="section-header">
        <span className="section-title">
          Discussion
          {comments.length > 0
            ? ` (${visibleComments.length}${hiddenCount > 0 ? `/${comments.length}` : ''})`
            : ''}
        </span>
        {commenters.length > 0 && (
          <div className="disc-filter-wrap" ref={filterRef}>
            <button
              className={`disc-filter-btn${hiddenUsers.size > 0 ? ' active' : ''}`}
              title="Filter by commenter"
              onClick={() => setFilterOpen((v) => !v)}
            >
              Filter{' '}
              {hiddenUsers.size > 0
                ? `${commenters.length - hiddenUsers.size}/${commenters.length}`
                : '⊟'}
            </button>
            {filterOpen && (
              <div className="disc-filter-dropdown">
                {commenters.map(({ login, avatarUrl }) => (
                  <label key={login} className="disc-filter-row">
                    <input
                      type="checkbox"
                      checked={!hiddenUsers.has(login)}
                      onChange={() => toggleUser(login)}
                    />
                    {avatarUrl ? (
                      <img className="disc-filter-avatar" src={avatarUrl} alt={login} />
                    ) : (
                      <span className="disc-filter-avatar disc-filter-avatar-fallback">
                        {login.slice(0, 2).toUpperCase()}
                      </span>
                    )}
                    <span className="disc-filter-login">{login}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {visibleComments.length > 0 && (
        <div className="discussion-thread">
          {visibleComments.map((c) => (
            <DiscussionComment key={c.id} comment={c} repoUrl={repoUrl} />
          ))}
        </div>
      )}
      <div className="comment-box">
        <textarea
          className="comment-textarea"
          placeholder="Write a comment on this PR… (optional for Approve / Request Changes)"
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="comment-actions">
          <span className="comment-status">{statusMsg}</span>
          <button
            className="comment-request-changes-btn"
            disabled={requestBusy || approveBusy || commentBusy}
            onClick={handleRequestChanges}
          >
            {requestBusy ? 'Requesting…' : 'Request Changes'}
          </button>
          <button
            className="comment-approve-btn"
            disabled={approveBusy || requestBusy || commentBusy}
            onClick={handleApprove}
          >
            {approveBusy ? 'Approving…' : 'Approve'}
          </button>
          <button
            className="comment-submit-btn"
            disabled={!body.trim() || commentBusy || approveBusy || requestBusy}
            onClick={handleComment}
          >
            {commentBusy ? 'Posting…' : 'Post Comment'}
          </button>
        </div>
      </div>
    </>
  );
}

function DiscussionComment({
  comment: c,
  repoUrl,
}: {
  comment: GhDiscussionComment;
  repoUrl: string;
}) {
  if (c.kind === 'commit') {
    return (
      <div className="disc-commit">
        <span className="disc-avatar disc-avatar-sm">
          {c.avatarUrl ? (
            <img src={c.avatarUrl} alt={c.author} />
          ) : (
            c.author.slice(0, 2).toUpperCase()
          )}
        </span>
        <span className="disc-commit-author">{c.author}</span>
        <span className="disc-commit-label">pushed</span>
        <CommitLabel sha={c.commitSha!} message={c.body} />
        <span className="disc-age disc-commit-age">{ageLabel(c.createdAt)}</span>
      </div>
    );
  }

  const reviewBadge =
    c.kind === 'review' && c.reviewState && c.reviewState !== 'COMMENTED' ? (
      <span className={`disc-review-badge disc-${c.reviewState.toLowerCase()}`}>
        {c.reviewState === 'APPROVED' ? '✓ Approved' : '✗ Changes requested'}
      </span>
    ) : null;

  return (
    <div className="disc-comment">
      <div className="disc-header">
        <span className="disc-avatar">
          {c.avatarUrl ? (
            <img src={c.avatarUrl} alt={c.author} />
          ) : (
            c.author.slice(0, 2).toUpperCase()
          )}
        </span>
        <span className="disc-author">{c.author}</span>
        <span className="disc-age">{ageLabel(c.createdAt)}</span>
        {reviewBadge}
      </div>
      <div className="disc-body">
        <MarkdownBody content={c.body} repoUrl={repoUrl} />
      </div>
    </div>
  );
}
