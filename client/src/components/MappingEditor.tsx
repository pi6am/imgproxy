import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import type { WorkflowNodeInfo } from "../types.js";
import { MAPPABLE_PARAMS, type NodeMapping } from "../types.js";

const PARAM_LABELS: Record<string, string> = {
  prompt: "Prompt",
  negative_prompt: "Negative prompt",
  width: "Width",
  height: "Height",
  seed: "Seed",
  steps: "Steps",
  cfg: "CFG",
  sampler: "Sampler",
  scheduler: "Scheduler",
  batch_size: "Batch size",
  model: "Model",
};

export default function MappingEditor({
  workflow,
  mapping,
  onChange,
}: {
  workflow: unknown;
  mapping: Record<string, NodeMapping | null>;
  onChange: (mapping: Record<string, NodeMapping | null>) => void;
}) {
  const [nodes, setNodes] = useState<WorkflowNodeInfo[] | null>(null);
  const [analyzeError, setAnalyzeError] = useState("");

  const isWorkflowObject = useMemo(
    () => Boolean(workflow) && typeof workflow === "object" && !Array.isArray(workflow) && Object.keys(workflow as object).length > 0,
    [workflow],
  );

  useEffect(() => {
    if (!isWorkflowObject) {
      setNodes(null);
      return;
    }
    const timer = setTimeout(() => {
      api
        .analyzeWorkflow(workflow)
        .then((res) => {
          setNodes(res.nodes);
          setAnalyzeError("");
        })
        .catch((err: Error) => {
          setNodes(null);
          setAnalyzeError(err.message);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [isWorkflowObject, workflow]);

  const nodesById = useMemo(() => new Map((nodes ?? []).map((n) => [n.id, n])), [nodes]);

  const setEntry = (param: string, entry: NodeMapping | null) => {
    onChange({ ...mapping, [param]: entry });
  };

  return (
    <div className="mapping-editor">
      <p className="hint">
        Maps public API parameters onto this workflow's node inputs. Unmapped parameters are not forwarded.
        {nodes && ` ${nodes.length} nodes detected.`}
      </p>
      {analyzeError && <div className="banner error">{analyzeError}</div>}
      {!isWorkflowObject && <div className="banner">Paste or upload a workflow JSON first.</div>}
      <table className="mapping-table">
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Node</th>
            <th>Input</th>
          </tr>
        </thead>
        <tbody>
          {MAPPABLE_PARAMS.map((param) => {
            const entry = mapping[param] ?? null;
            const node = entry ? nodesById.get(entry.node) : undefined;
            const scalarInputs = node?.inputs.filter((i) => i.kind === "scalar") ?? [];
            const missing = Boolean(entry) && nodes !== null && !node;
            return (
              <tr key={param} className={missing ? "warn" : undefined}>
                <td>{PARAM_LABELS[param] ?? param}</td>
                <td>
                  <select
                    value={entry?.node ?? ""}
                    onChange={(e) => {
                      const nodeId = e.target.value;
                      if (!nodeId) return setEntry(param, null);
                      const target = nodesById.get(nodeId);
                      const firstScalar = target?.inputs.find((i) => i.kind === "scalar")?.name ?? "value";
                      setEntry(param, { node: nodeId, input: entry?.node === nodeId ? entry.input : firstScalar });
                    }}
                  >
                    <option value="">— not mapped —</option>
                    {(nodes ?? []).map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.id} · {n.title ?? n.classType}
                      </option>
                    ))}
                    {entry && !node && <option value={entry.node}>{entry.node} (missing from workflow)</option>}
                  </select>
                </td>
                <td>
                  <select
                    value={entry?.input ?? ""}
                    disabled={!entry || scalarInputs.length === 0}
                    onChange={(e) => entry && setEntry(param, { node: entry.node, input: e.target.value })}
                  >
                    {entry && scalarInputs.length === 0 && <option value={entry.input}>{entry.input}</option>}
                    {scalarInputs.map((i) => (
                      <option key={i.name} value={i.name}>
                        {i.name} ({i.valueType})
                      </option>
                    ))}
                  </select>
                  {missing && <span className="hint warn-text">node missing in current workflow</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
