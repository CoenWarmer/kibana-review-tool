import * as vscode from 'vscode';
import * as net from 'net';

export type ServerStatus = 'running' | 'stopped';

export interface ServerState {
  es: ServerStatus;
  kibana: ServerStatus;
}

const ES_PORT = 9200;
const KIBANA_PORT = 5601;
const POLL_INTERVAL_MS = 5000;

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1500);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
    socket.connect(port, '127.0.0.1');
  });
}

export class ServerStatusService {
  private esStatus: ServerStatus = 'stopped';
  private kibanaStatus: ServerStatus = 'stopped';

  private esTerminal: vscode.Terminal | null = null;
  private kibanaTerminal: vscode.Terminal | null = null;

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  private readonly _onStatusChange = new vscode.EventEmitter<ServerState>();
  readonly onStatusChange = this._onStatusChange.event;

  startPolling(): void {
    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  getStatus(): ServerState {
    return { es: this.esStatus, kibana: this.kibanaStatus };
  }

  startEs(workspaceRoot: string): void {
    if (this.esTerminal) {
      this.esTerminal.dispose();
    }
    this.esTerminal = vscode.window.createTerminal({ name: '⚡ Elasticsearch', cwd: workspaceRoot });
    this.esTerminal.show(true);
    this.esTerminal.sendText('yarn es snapshot');
  }

  startKibana(workspaceRoot: string): void {
    if (this.kibanaTerminal) {
      this.kibanaTerminal.dispose();
    }
    this.kibanaTerminal = vscode.window.createTerminal({ name: '🟣 Kibana', cwd: workspaceRoot });
    this.kibanaTerminal.show(true);
    this.kibanaTerminal.sendText('yarn start');
  }

  dispose(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this._onStatusChange.dispose();
  }

  private async poll(): Promise<void> {
    const [esOpen, kibanaOpen] = await Promise.all([
      isPortOpen(ES_PORT),
      isPortOpen(KIBANA_PORT),
    ]);
    const newEs: ServerStatus = esOpen ? 'running' : 'stopped';
    const newKibana: ServerStatus = kibanaOpen ? 'running' : 'stopped';
    if (newEs !== this.esStatus || newKibana !== this.kibanaStatus) {
      this.esStatus = newEs;
      this.kibanaStatus = newKibana;
      this._onStatusChange.fire(this.getStatus());
    }
  }
}
