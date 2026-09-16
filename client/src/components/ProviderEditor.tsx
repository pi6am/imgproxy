import { useRef, useState } from "react";
import { api } from "../api.js";
import type { ComfyUIProviderCfg, GenDefaults, ProviderCfg } from "../types.js";
import MappingEditor from "../components/MappingEditor.js";

let idCounter = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export function ProviderEditor({
  provider,
  onChange,
  onRemove,
}: {
  provider: ProviderCfg;
  onChange: (p: ProviderCfg) => void;
  onRemove: () => void;
}) {
  const [checkResult, setCheckResult] = useState<string>("");
  const [checking, setChecking] = useState(false);
  const [workflowText, setWorkflowText] = useState(() =>
    Object.keys(provider.type === "comfyui" ? provider.workflow : {}).length > 0
      ? JSON.stringify((provider as ComfyUIProviderCfg).workflow, null, 2)
      : "",
  );
  const [workflowError, setWorkflowError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const check = async () => {
    setChecking(true);
    try {
      const res = await api.checkProvider(provider.id);
      setCheckResult(`${res.ok ? "OK" : "FAILED"}: ${res.detail}`);
    } catch (err) {
      setCheckResult(`ERROR: ${(err as Error).message}`);
    } finally {
      setChecking(false);
    }
  };

  const applyWorkflowText = (text: string) => {
    setWorkflowText(text);
    if (!text.trim()) {
      setWorkflowError("");
      if (provider.type === "comfyui") onChange({ ...provider, workflow: {} } as ProviderCfg);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      setWorkflowError("");
      if (provider.type === "comfyui") onChange({ ...provider, workflow: parsed } as ProviderCfg);
    } catch (err) {
      setWorkflowError(`Invalid JSON: ${(err as Error).message}`);
    }
  };

  const loadFile = async (file: File) => {
    applyWorkflowText(await file.text());
  };

  return (
    <div className="provider-card">
      <div className="row space-between">
        <input
          className="name-input"
          value={provider.name}
          onChange={(e) => onChange({ ...provider, name: e.target.value })}
          placeholder="Provider name"
        />
        <div className="row">
          <span className="badge">{provider.type}</span>
          <button onClick={check} disabled={checking}>
            {checking ? "Checking…" : "Check"}
          </button>
          <button className="danger" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
      {checkResult && <div className={`banner ${checkResult.startsWith("OK") ? "ok" : "error"}`}>{checkResult}</div>}

      <label>
        {provider.type === "openai" ? "Base URL (incl. /v1)" : "Base URL"}
        <input
          value={provider.baseUrl}
          onChange={(e) => onChange({ ...provider, baseUrl: e.target.value })}
          placeholder={
            provider.type === "comfyui"
              ? "http://127.0.0.1:8188"
              : provider.type === "openai"
                ? "https://api.openai.com/v1"
                : "http://127.0.0.1:7860"
          }
        />
      </label>

      {provider.type === "comfyui" && (
        <>
          <label>
            Bearer token <span className="hint">(optional — sent to ComfyUI if it requires token auth)</span>
            <input
              type="password"
              value={provider.apiKey}
              onChange={(e) => onChange({ ...provider, apiKey: e.target.value } as ProviderCfg)}
              placeholder="leave empty if ComfyUI has no auth"
            />
          </label>
          <label>
            Workflow JSON (ComfyUI API format)
            <textarea
              className="workflow-textarea"
              rows={10}
              value={workflowText}
              onChange={(e) => applyWorkflowText(e.target.value)}
              placeholder='{"3": {"inputs": {...}, "class_type": "KSampler"}, ...}'
            />
          </label>
          <div className="row">
            <button onClick={() => fileRef.current?.click()}>Upload workflow file…</button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void loadFile(f);
                e.target.value = "";
              }}
            />
            {workflowText && (
              <span className="hint">{Object.keys(provider.workflow).length} top-level nodes</span>
            )}
          </div>
          {workflowError && <div className="banner error">{workflowError}</div>}

          <h4>Input-to-node mapping</h4>
          <MappingEditor
            workflow={provider.workflow}
            mapping={provider.mapping}
            onChange={(mapping) => onChange({ ...provider, mapping } as ProviderCfg)}
          />

          <h4>Defaults (used when the request doesn't specify)</h4>
          <DefaultsEditor
            defaults={provider.defaults ?? {}}
            onChange={(defaults) => onChange({ ...provider, defaults } as ProviderCfg)}
          />

          <div className="form-grid">
            <label>
              Poll interval (ms)
              <input
                inputMode="numeric"
                value={provider.pollIntervalMs}
                onChange={(e) =>
                  onChange({ ...provider, pollIntervalMs: Number(e.target.value) || 500 } as ProviderCfg)
                }
              />
            </label>
            <label>
              Timeout (ms)
              <input
                inputMode="numeric"
                value={provider.timeoutMs}
                onChange={(e) =>
                  onChange({ ...provider, timeoutMs: Number(e.target.value) || 600000 } as ProviderCfg)
                }
              />
            </label>
          </div>
        </>
      )}

      {provider.type === "openai" && (
        <>
          <label>
            Model
            <input value={provider.model} onChange={(e) => onChange({ ...provider, model: e.target.value })} />
          </label>
          <label>
            API key
            <input
              type="password"
              value={provider.apiKey}
              onChange={(e) => onChange({ ...provider, apiKey: e.target.value })}
              placeholder="sk-…"
            />
          </label>
          <label>
            Timeout (ms)
            <input
              inputMode="numeric"
              value={provider.timeoutMs}
              onChange={(e) => onChange({ ...provider, timeoutMs: Number(e.target.value) || 300000 } as ProviderCfg)}
            />
          </label>
        </>
      )}

      {provider.type === "a1111" && (
        <>
          <label>
            API key <span className="hint">(optional bearer token)</span>
            <input
              type="password"
              value={provider.apiKey}
              onChange={(e) => onChange({ ...provider, apiKey: e.target.value })}
            />
          </label>
          <label>
            Timeout (ms)
            <input
              inputMode="numeric"
              value={provider.timeoutMs}
              onChange={(e) => onChange({ ...provider, timeoutMs: Number(e.target.value) || 300000 } as ProviderCfg)}
            />
          </label>
        </>
      )}
    </div>
  );
}

function DefaultsEditor({
  defaults,
  onChange,
}: {
  defaults: GenDefaults;
  onChange: (d: GenDefaults) => void;
}) {
  const num = (v: string): number | undefined => (v.trim() === "" ? undefined : Number(v));
  return (
    <div className="form-grid">
      <label>
        Width
        <input
          inputMode="numeric"
          value={defaults.width ?? ""}
          onChange={(e) => onChange({ ...defaults, width: num(e.target.value) })}
        />
      </label>
      <label>
        Height
        <input
          inputMode="numeric"
          value={defaults.height ?? ""}
          onChange={(e) => onChange({ ...defaults, height: num(e.target.value) })}
        />
      </label>
      <label>
        Steps
        <input
          inputMode="numeric"
          value={defaults.steps ?? ""}
          onChange={(e) => onChange({ ...defaults, steps: num(e.target.value) })}
        />
      </label>
      <label>
        CFG
        <input
          inputMode="decimal"
          value={defaults.cfg ?? ""}
          onChange={(e) => onChange({ ...defaults, cfg: num(e.target.value) })}
        />
      </label>
      <label>
        Seed <span className="hint">(empty = random)</span>
        <input
          inputMode="numeric"
          value={defaults.seed ?? ""}
          onChange={(e) => onChange({ ...defaults, seed: num(e.target.value) })}
        />
      </label>
      <label className="span2">
        Negative prompt
        <input
          value={defaults.negativePrompt ?? ""}
          onChange={(e) => onChange({ ...defaults, negativePrompt: e.target.value })}
        />
      </label>
    </div>
  );
}

export function newProvider(type: ProviderCfg["type"]): ProviderCfg {
  const id = newId(type);
  const name = { comfyui: "New ComfyUI", openai: "New OpenAI-compatible", a1111: "New A1111" }[type];
  if (type === "comfyui") {
    return {
      id,
      name,
      type,
      baseUrl: "http://127.0.0.1:8188",
      apiKey: "",
      workflow: {},
      mapping: {},
      defaults: {},
      pollIntervalMs: 500,
      timeoutMs: 600000,
    };
  }
  if (type === "openai") {
    return { id, name, type, baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-image-1", timeoutMs: 300000 };
  }
  return { id, name, type, baseUrl: "http://127.0.0.1:7860", apiKey: "", timeoutMs: 300000 };
}
