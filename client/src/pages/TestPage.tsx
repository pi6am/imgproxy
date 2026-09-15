import { useState } from "react";
import { api } from "../api.js";
import type { AppConfig, GenerateResult } from "../types.js";

export default function TestPage({ config }: { config: AppConfig }) {
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [width, setWidth] = useState("1024");
  const [height, setHeight] = useState("1024");
  const [steps, setSteps] = useState("");
  const [cfg, setCfg] = useState("");
  const [seed, setSeed] = useState("");
  const [n, setN] = useState("1");
  const [providerId, setProviderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<GenerateResult | null>(null);

  const run = async () => {
    if (!prompt.trim()) {
      setError("Prompt is required");
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const body: Record<string, unknown> = {
        prompt,
        n: Number(n) || 1,
        providerId: providerId || config.activeProviderId || undefined,
      };
      if (negativePrompt.trim()) body.negativePrompt = negativePrompt.trim();
      if (width) body.width = Number(width);
      if (height) body.height = Number(height);
      if (steps) body.steps = Number(steps);
      if (cfg) body.cfgScale = Number(cfg);
      if (seed.trim()) body.seed = Number(seed);
      setResult(await api.generate(body));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <section className="panel">
        <h2>Generate</h2>
        <div className="form-grid">
          <label className="span2">
            Prompt
            <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="A drawing of a cheeseburger" />
          </label>
          <label className="span2">
            Negative prompt <span className="hint">(optional)</span>
            <input value={negativePrompt} onChange={(e) => setNegativePrompt(e.target.value)} />
          </label>
          <label>
            Width
            <input inputMode="numeric" value={width} onChange={(e) => setWidth(e.target.value)} />
          </label>
          <label>
            Height
            <input inputMode="numeric" value={height} onChange={(e) => setHeight(e.target.value)} />
          </label>
          <label>
            Steps <span className="hint">(workflow default if empty)</span>
            <input inputMode="numeric" value={steps} onChange={(e) => setSteps(e.target.value)} />
          </label>
          <label>
            CFG <span className="hint">(workflow default if empty)</span>
            <input inputMode="decimal" value={cfg} onChange={(e) => setCfg(e.target.value)} />
          </label>
          <label>
            Seed <span className="hint">(empty = random)</span>
            <input inputMode="numeric" value={seed} onChange={(e) => setSeed(e.target.value)} />
          </label>
          <label>
            Count
            <input inputMode="numeric" value={n} onChange={(e) => setN(e.target.value)} />
          </label>
          <label>
            Provider
            <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              <option value="">Active ({config.activeProviderId || "none"})</option>
              {config.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.type})
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <button className="primary" disabled={busy} onClick={run}>
            {busy ? "Generating…" : "Generate"}
          </button>
          {busy && <span className="hint">This can take a while depending on the provider.</span>}
        </div>
        {error && <div className="banner error">{error}</div>}
      </section>

      {result && (
        <section className="panel">
          <h2>
            Result <span className="hint">request {result.requestId}</span>
          </h2>
          <div className="image-grid">
            {result.images.map((img) => (
              <a key={img.imageId} href={img.url} target="_blank" rel="noreferrer">
                <img src={img.url} alt="generated" />
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
