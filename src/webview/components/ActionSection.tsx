import { useState } from 'react';
import type { GhPullRequest, InboundMessage } from '../types';

interface ActionSectionProps {
  pr: GhPullRequest;
  checkoutBusy: boolean;
  checkoutStage: string;
  esStatus: string;
  kibanaStatus: string;
  checkedOutPrNumber: number | null;
  synthtraceScenarios: string[];
  postMessage: (message: InboundMessage) => void;
}

export function ActionSection({
  pr,
  checkoutBusy,
  checkedOutPrNumber,
  checkoutStage,
  esStatus,
  kibanaStatus,
  synthtraceScenarios,
  postMessage,
}: ActionSectionProps) {
  const isCheckedOut = pr.number === checkedOutPrNumber;
  const [selectedScenario, setSelectedScenario] = useState<string>(synthtraceScenarios[0] ?? '');
  const [live, setLive] = useState(false);
  const [devEnvOpen, setDevEnvOpen] = useState(false);

  return (
    <div className="action-rows">
      <div className="checkout-row">
        <button
          className={`checkout-btn${checkoutBusy ? ' busy' : ''}`}
          disabled={isCheckedOut || checkoutBusy}
          onClick={() => postMessage({ type: 'checkout' })}
        >
          {checkoutBusy ? (
            <>
              <span className="checkout-spin">⟳</span>
              {checkoutStage || 'Checking out…'}
            </>
          ) : isCheckedOut ? (
            '✓ Checked out'
          ) : (
            '↓ Checkout'
          )}
        </button>
        <button
          className="refresh-btn"
          title="Refresh PR data"
          onClick={() => postMessage({ type: 'refreshPR' })}
        >
          &#8635;
        </button>
        <button
          className={`dev-env-toggle-btn${devEnvOpen ? ' active' : ''}`}
          title={devEnvOpen ? 'Hide dev environment' : 'Show dev environment'}
          onClick={() => setDevEnvOpen((v) => !v)}
        >
          ⚡
        </button>
      </div>
      <div className={`dev-env-row${devEnvOpen ? '' : ' hidden'}`}>
        <button className="server-btn" onClick={() => postMessage({ type: 'startEs' })}>
          <span className={`server-dot ${esStatus}`} />
          <span className="server-label">Elasticsearch</span>
          <span className="server-action">{esStatus === 'running' ? 'Restart' : 'Start'}</span>
        </button>
        <button className="server-btn" onClick={() => postMessage({ type: 'startKibana' })}>
          <span className={`server-dot ${kibanaStatus}`} />
          <span className="server-label">Kibana</span>
          <span className="server-action">
            {kibanaStatus === 'running' ? 'Restart' : kibanaStatus === 'starting' ? 'Starting…' : 'Start'}
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
      <div className={`synthtrace-row${devEnvOpen ? '' : ' hidden'}`}>
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
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
          />
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