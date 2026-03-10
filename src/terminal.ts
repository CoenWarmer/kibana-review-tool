import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Creates a terminal and runs a command once the shell is ready.
 *
 * Uses VS Code's shell integration API to wait for the first interactive
 * prompt before sending the command, so .zshrc has fully executed.
 *
 * Lazy-NVM handling: if the working directory contains a `.nvmrc` or
 * `.node-version` file, `nvm use 2>/dev/null` is prepended so that the
 * lazy-loaded NVM stub is triggered and the right Node version is active
 * before the command runs. The redirect suppresses output/errors for
 * systems that don't have NVM installed.
 *
 * A `sent` flag is the source of truth — whichever path fires first
 * (shell integration or the fallback timer) wins; the other is ignored.
 * This prevents double-execution regardless of timing.
 *
 * Falls back to `sendText` after `fallbackMs` if shell integration never
 * fires (e.g. the user has it disabled or the shell doesn't support it).
 */
export function runInTerminal(
  options: vscode.TerminalOptions,
  command: string,
  fallbackMs = 4000
): vscode.Terminal {
  const terminal = vscode.window.createTerminal(options);
  let sent = false;

  const cwd =
    options.cwd instanceof vscode.Uri
      ? options.cwd.fsPath
      : (options.cwd as string | undefined);

  // Prepend `nvm use` when the project declares a Node version, so that
  // lazy-loaded NVM activates the right version before the command runs.
  // Semicolon (not &&) ensures the command runs even if nvm use fails.
  const effectiveCommand =
    cwd && hasNodeVersionFile(cwd) ? `nvm use 2>/dev/null; ${command}` : command;

  const disposable = vscode.window.onDidChangeTerminalShellIntegration(({ terminal: t }) => {
    if (t !== terminal || sent) return;
    sent = true;
    disposable.dispose();
    clearTimeout(fallbackTimer);
    t.shellIntegration!.executeCommand(effectiveCommand);
  });

  // Fallback: shell integration not available or took too long.
  const fallbackTimer = setTimeout(() => {
    if (sent) return;
    sent = true;
    disposable.dispose();
    terminal.sendText(effectiveCommand);
  }, fallbackMs);

  return terminal;
}

function hasNodeVersionFile(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.nvmrc')) || fs.existsSync(path.join(dir, '.node-version'));
}
