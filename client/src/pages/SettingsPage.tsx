import { useState } from "react";
import { api } from "../api.js";
import type { AppConfig, ProviderCfg } from "../types.js";
import { newProvider, ProviderEditor } from "../components/ProviderEditor.js";

export default function SettingsPage({
  config,
  onSaved,
}: {
  config: AppConfig;
  onSaved: () => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<AppConfig>(config);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError("");
    setStatus("");
    try {
      await api.saveConfig(draft);
      setStatus("Saved. Server settings (host/port) take effect after restart; everything else is live.");
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const updateProvider = (updated: ProviderCfg) => {
    setDraft((d) => ({
      ...d,
      providers: d.providers.map((p) => (p.id === updated.id ? updated : p)),
    }));
  };

  const removeProvider = (id: string) => {
    setDraft((d) => ({
      ...d,
      providers: d.providers.filter((p) => p.id !== id),
      activeProviderId: d.activeProviderId === id ? "" : d.activeProviderId,
    }));
  };

  const addProvider = (type: ProviderCfg["type"]) => {
    setDraft((d) => ({ ...d, providers: [...d.providers, newProvider(type)] }));
  };

  return (
    <div className="page">
      <section className="panel">
        <div className="row space-between">
          <h2>Server</h2>
          <button className="primary" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
        {status && <div className="banner ok">{status}</div>}
        {error && <div className="banner error">{error}</div>}
        <div className="form-grid">
          <label>
            Host
            <input value={draft.server.host} onChange={(e) => setDraft({ ...draft, server: { ...draft.server, host: e.target.value } })} />
          </label>
          <label>
            Port
            <input
              inputMode="numeric"
              value={draft.server.port}
              onChange={(e) => setDraft({ ...draft, server: { ...draft.server, port: Number(e.target.value) || 7800 } })}
            />
          </label>
        </div>
        <h3>Exposed APIs</h3>
        <ApiToggle
          title="OpenAI-compatible"
          endpoint="POST /v1/images/generations"
          value={draft.apis.openai}
          onChange={(v) =>
            setDraft({ ...draft, apis: { ...draft.apis, openai: { enabled: v.enabled, token: v.token ?? "" } } })
          }
        />
        <ApiToggle
          title="A1111-compatible"
          endpoint="POST /sdapi/v1/txt2img"
          value={draft.apis.a1111}
          onChange={(v) => setDraft({ ...draft, apis: { ...draft.apis, a1111: { enabled: v.enabled } } })}
        />
      </section>

      <section className="panel">
        <div className="row space-between">
          <h2>
            Providers <span className="hint">requests are forwarded to the active provider</span>
          </h2>
          <div className="row">
            <button onClick={() => addProvider("comfyui")}>+ ComfyUI</button>
            <button onClick={() => addProvider("openai")}>+ OpenAI-compatible</button>
            <button onClick={() => addProvider("a1111")}>+ A1111</button>
          </div>
        </div>
        <label className="active-provider-select">
          Active provider
          <select
            value={draft.activeProviderId}
            onChange={(e) => setDraft({ ...draft, activeProviderId: e.target.value })}
          >
            {draft.providers.length === 0 && <option value="">(none)</option>}
            {draft.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.type})
              </option>
            ))}
          </select>
        </label>
        {draft.providers.map((p) => (
          <ProviderEditor key={p.id} provider={p} onChange={updateProvider} onRemove={() => removeProvider(p.id)} />
        ))}
        {draft.providers.length === 0 && (
          <p className="hint">No providers yet — add one above. For ComfyUI you'll also paste a workflow and map its inputs.</p>
        )}
      </section>
    </div>
  );
}

function ApiToggle({
  title,
  endpoint,
  value,
  onChange,
}: {
  title: string;
  endpoint: string;
  value: { enabled: boolean; token?: string };
  onChange: (v: { enabled: boolean; token?: string }) => void;
}) {
  return (
    <div className="api-toggle">
      <label className="inline">
        <input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />
        {title} <code>{endpoint}</code>
      </label>
      {value.token !== undefined && (
        <label className="inline">
          Bearer token <span className="hint">(optional)</span>
          <input
            type="password"
            value={value.token}
            onChange={(e) => onChange({ ...value, token: e.target.value })}
            placeholder="leave empty for no auth"
          />
        </label>
      )}
    </div>
  );
}
