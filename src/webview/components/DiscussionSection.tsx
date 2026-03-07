import { useEffect, useRef, useState } from 'react';
import { postMessage } from '../vscode';
import { ageLabel } from '../utils';
import type { GhDiscussionComment } from '../types';
import { MarkdownBody } from './MarkdownBody';

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

  const count = comments.length;

  return (
    <>
      <div className="section-header">
        <span className="section-title">Discussion{count > 0 ? ` (${count})` : ''}</span>
      </div>
      {count > 0 && (
        <div className="discussion-thread">
          {comments.map((c) => (
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
