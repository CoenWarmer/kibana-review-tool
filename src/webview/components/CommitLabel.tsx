import { postMessage } from '../vscode';

interface CommitLabelProps {
  sha: string;
  /** Full commit message; first line is shown, rest appears in tooltip. */
  message: string;
}

/**
 * Renders a clickable commit SHA + first line of the commit message, with a
 * CSS tooltip showing the full message on hover. Clicking the SHA opens the
 * commit diff QuickPick in the IDE.
 *
 * Reuses `.disc-commit-sha` / `.disc-commit-msg-wrap` styles so both the
 * Discussion section and the CommitStepper look identical.
 */
export function CommitLabel({ sha, message }: CommitLabelProps) {
  const firstLine = message.split('\n')[0];
  const hasMore = message !== firstLine;

  return (
    <>
      <button
        className="disc-commit-sha"
        title={`Open commit ${sha} in IDE`}
        onClick={() => postMessage({ type: 'openCommit', sha })}
      >
        {sha}
      </button>
      <span className="disc-commit-msg-wrap">
        <span className="disc-commit-msg">{firstLine}</span>
        {hasMore && <span className="disc-commit-tooltip">{message}</span>}
      </span>
    </>
  );
}
