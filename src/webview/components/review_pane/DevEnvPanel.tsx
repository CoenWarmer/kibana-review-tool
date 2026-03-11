import { useState, useRef, useEffect } from 'react';
import type { InboundMessage } from '../../types';
import { Spinner } from '../Spinner';
import { PlayCircleIcon } from '../icons/PlayCircleIcon';
import { SettingsIcon } from '../icons/SettingsIcon';

const ES_CMD_HISTORY_KEY = 'elastic-pr-reviewer.esCmdHistory';
const KIBANA_CMD_HISTORY_KEY = 'elastic-pr-reviewer.kibanaCmdHistory';
const DEFAULT_ES_CMD = 'yarn es snapshot';
const DEFAULT_KIBANA_CMD = 'yarn start';
const MAX_HISTORY = 10;

function loadHistory(key: string, defaultCmd: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const saved = raw ? (JSON.parse(raw) as string[]) : [];
    // Always ensure the default is available as a fallback
    return saved.length > 0 ? saved : [defaultCmd];
  } catch {
    return [defaultCmd];
  }
}

function saveHistory(key: string, cmd: string, prev: string[]): string[] {
  const deduped = [cmd, ...prev.filter((c) => c !== cmd)].slice(0, MAX_HISTORY);
  try {
    localStorage.setItem(key, JSON.stringify(deduped));
  } catch {
    // ignore
  }
  return deduped;
}

interface ServerControlProps {
  label: string;
  status: string;
  defaultCmd: string;
  historyKey: string;
  onRun: (command: string) => void;
}

function ServerControl({ label, status, defaultCmd, historyKey, onRun }: ServerControlProps) {
  const [history, setHistory] = useState<string[]>(() => loadHistory(historyKey, defaultCmd));
  const [mode, setMode] = useState<'idle' | 'customize' | 'select'>('idle');
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Focus input when customize opens
  useEffect(() => {
    if (mode === 'customize') {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [mode]);

  // Close dropdown on outside click
  useEffect(() => {
    if (mode !== 'select') return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setMode('idle');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [mode]);

  const runCommand = (cmd: string) => {
    const trimmed = cmd.trim() || defaultCmd;
    const next = saveHistory(historyKey, trimmed, history);
    setHistory(next);
    onRun(trimmed);
    setMode('idle');
  };

  const openCustomize = () => {
    setInputValue(history[0] ?? defaultCmd);
    setMode(mode === 'customize' ? 'idle' : 'customize');
  };

  const openSelect = () => {
    setMode(mode === 'select' ? 'idle' : 'select');
  };
  console.log('status', status);
  return (
    <div className="server-control">
      <div className="server-btn">
        <span className="server-label">{label}</span>
        <button className="server-btn-run" onClick={() => runCommand(history[0] ?? defaultCmd)}>
          {status === 'stopped' ? (
            <PlayCircleIcon color="#C5C5C5" width={14} height={14} />
          ) : status === 'starting' ? (
            <span style={{ color: '#d29922' }}>
              <Spinner />
            </span>
          ) : (
            <span className={`server-dot ${status}`} />
          )}
        </button>
        <button
          className={`server-extra-btn${mode === 'customize' ? ' active' : ''}`}
          title="Customize command"
          onClick={openCustomize}
        >
          <SettingsIcon color="#C5C5C5" width={14} height={14} />
        </button>

        <div className="server-select-wrapper" ref={dropdownRef}>
          <button
            className={`server-extra-btn${mode === 'select' ? ' active' : ''}`}
            title="Select a saved command"
            disabled={history.length <= 1}
            onClick={openSelect}
          >
            ▾
          </button>
          {mode === 'select' && (
            <div className="server-history-dropdown">
              {history.map((cmd, i) => (
                <button key={i} className="server-history-item" onClick={() => runCommand(cmd)}>
                  {cmd}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {mode === 'customize' && (
        <div className="server-customize-row">
          <input
            ref={inputRef}
            className="server-cmd-input"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runCommand(inputValue);
              if (e.key === 'Escape') setMode('idle');
            }}
            spellCheck={false}
          />
          <button className="server-cmd-run-btn" onClick={() => runCommand(inputValue)}>
            ▶
          </button>
          <button className="server-cmd-cancel-btn" onClick={() => setMode('idle')}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

interface DevEnvPanelProps {
  esStatus: string;
  kibanaStatus: string;
  synthtraceScenarios: string[];
  postMessage: (message: InboundMessage) => void;
}

export function DevEnvPanel({
  esStatus,
  kibanaStatus,
  synthtraceScenarios,
  postMessage,
}: DevEnvPanelProps) {
  const [selectedScenario, setSelectedScenario] = useState<string>(synthtraceScenarios[0] ?? '');
  const [live, setLive] = useState(false);

  return (
    <div className="dev-env-panel">
      <div className="dev-env-row">
        <ServerControl
          label="ES"
          status={esStatus}
          defaultCmd={DEFAULT_ES_CMD}
          historyKey={ES_CMD_HISTORY_KEY}
          onRun={(cmd) => postMessage({ type: 'startEs', command: cmd })}
        />
        <ServerControl
          label="Kibana"
          status={kibanaStatus}
          defaultCmd={DEFAULT_KIBANA_CMD}
          historyKey={KIBANA_CMD_HISTORY_KEY}
          onRun={(cmd) => postMessage({ type: 'startKibana', command: cmd })}
        />
        <button
          className="open-kibana-btn"
          disabled={kibanaStatus !== 'running'}
          onClick={() => postMessage({ type: 'openKibana' })}
        >
          ⎋ Open Kibana
        </button>
      </div>
      <div className="synthtrace-row">
        <select
          className="synthtrace-select"
          value={selectedScenario}
          onChange={(e) => setSelectedScenario(e.target.value)}
          disabled={synthtraceScenarios.length === 0}
        >
          {synthtraceScenarios.length === 0 ? (
            <option value="">No scenarios found</option>
          ) : (
            synthtraceScenarios.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))
          )}
        </select>
        <button
          className="synthtrace-settings-btn"
          title="Refresh scenarios list"
          disabled
          onClick={() => postMessage({ type: 'refreshScenarios' })}
        >
          ⚙
        </button>
        <label className="synthtrace-live-label">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          live
        </label>
        <button
          className="synthtrace-run-btn"
          disabled={!selectedScenario || kibanaStatus !== 'running'}
          onClick={() => postMessage({ type: 'runSynthtrace', scenario: selectedScenario, live })}
        >
          ▶ Run synthtrace
        </button>
      </div>
    </div>
  );
}
