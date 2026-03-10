import * as vscode from 'vscode';
import * as net from 'net';
import * as http from 'http';
import { runInTerminal } from '../terminal';

export type ServerStatus = 'running' | 'starting' | 'stopped';

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
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * Makes an HTTP GET request to the Kibana status API.
 * Returns true only when Kibana responds with HTTP 2xx or 3xx — meaning the
 * server is fully up and serving requests (not just the basepath proxy).
 */
function isKibanaReady(baseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = `${baseUrl}/api/status`;
    const req = http.get(url, { timeout: 2000 }, (res) => {
      res.resume(); // drain body
      resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
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

  constructor(private readonly kibanaBaseUrl: string = 'http://127.0.0.1:5601/kibana') {}

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
    this.esTerminal = runInTerminal(
      { name: '⚡ Elasticsearch', cwd: workspaceRoot },
      'yarn es snapshot'
    );
    this.esTerminal.show(true);
  }

  startKibana(workspaceRoot: string): void {
    if (this.kibanaTerminal) {
      this.kibanaTerminal.dispose();
    }
    this.kibanaTerminal = runInTerminal({ name: '🟣 Kibana', cwd: workspaceRoot }, 'yarn start');
    this.kibanaTerminal.show(true);
  }

  dispose(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this._onStatusChange.dispose();
  }

  private async poll(): Promise<void> {
    const [esOpen, kibanaOpen] = await Promise.all([isPortOpen(ES_PORT), isPortOpen(KIBANA_PORT)]);

    const newEs: ServerStatus = esOpen ? 'running' : 'stopped';

    let newKibana: ServerStatus;
    if (!kibanaOpen) {
      newKibana = 'stopped';
    } else {
      // Port is open (basepath proxy is up) but we need to confirm the actual
      // Kibana HTTP server is ready before showing green.
      newKibana = (await isKibanaReady(this.kibanaBaseUrl)) ? 'running' : 'starting';
    }

    if (newEs !== this.esStatus || newKibana !== this.kibanaStatus) {
      this.esStatus = newEs;
      this.kibanaStatus = newKibana;
      this._onStatusChange.fire(this.getStatus());
    }
  }
}
