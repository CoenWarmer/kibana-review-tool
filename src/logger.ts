import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLogger(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('Kibana PR Reviewer');
  context.subscriptions.push(channel);
}

export function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
  channel?.appendLine(`[${ts}] ${message}`);
}

export function logJson(label: string, value: unknown): void {
  log(`${label}: ${JSON.stringify(value, null, 2)}`);
}

export function showLog(): void {
  channel?.show(true);
}
