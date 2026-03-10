import { useState } from 'react';
import type { InboundMessage } from '../../types';

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
        <button className="server-btn" onClick={() => postMessage({ type: 'startEs' })}>
          <span className={`server-dot ${esStatus}`} />
          <span className="server-label">Elasticsearch</span>
          <span className="server-action">{esStatus === 'running' ? 'Restart' : 'Start'}</span>
        </button>
        <button className="server-btn" onClick={() => postMessage({ type: 'startKibana' })}>
          <span className={`server-dot ${kibanaStatus}`} />
          <span className="server-label">Kibana</span>
          <span className="server-action">
            {kibanaStatus === 'running'
              ? 'Restart'
              : kibanaStatus === 'starting'
                ? 'Starting…'
                : 'Start'}
          </span>
        </button>
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
