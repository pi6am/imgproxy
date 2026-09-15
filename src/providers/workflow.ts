import type { NodeMapping } from "../config/schema.js";
import { GenerationError } from "../core/types.js";

/** ComfyUI API-format workflow: node id -> node definition. */
export type ComfyWorkflow = Record<string, ComfyWorkflowNode>;

export interface ComfyWorkflowNode {
  inputs: Record<string, unknown>;
  class_type: string;
  _meta?: { title?: string };
}

export interface WorkflowNodeInputInfo {
  name: string;
  kind: "scalar" | "link";
  valueType: string;
  /** Truncated preview of the current value (scalar inputs only). */
  value?: string;
}

export interface WorkflowNodeInfo {
  id: string;
  classType: string;
  title?: string;
  inputs: WorkflowNodeInputInfo[];
}

/**
 * Enumerates nodes and their inputs for the UI mapping editor.
 * Inputs whose value is an array are ComfyUI links (not settable).
 */
export function listWorkflowNodes(workflow: ComfyWorkflow): WorkflowNodeInfo[] {
  const nodes: WorkflowNodeInfo[] = [];
  for (const [id, node] of Object.entries(workflow)) {
    if (!node || typeof node !== "object" || typeof node.class_type !== "string") continue;
    const inputs: WorkflowNodeInputInfo[] = [];
    const rawInputs = node.inputs ?? {};
    if (rawInputs && typeof rawInputs === "object") {
      for (const [name, value] of Object.entries(rawInputs)) {
        const isLink = Array.isArray(value);
        inputs.push({
          name,
          kind: isLink ? "link" : "scalar",
          valueType: isLink ? "link" : value === null ? "null" : typeof value,
          value: isLink ? undefined : previewValue(value),
        });
      }
    }
    nodes.push({
      id,
      classType: node.class_type,
      title: node._meta?.title,
      inputs,
    });
  }
  nodes.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return nodes;
}

const PREVIEW_MAX = 48;

/** Compact single-line string form of a node input value for display in the UI. */
function previewValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (value === null) text = "null";
  else text = JSON.stringify(value) ?? String(value);
  text = text.replace(/\s+/g, " ").trim();
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
}

export interface AppliedMapping {
  node: string;
  input: string;
  value: unknown;
}

/**
 * Deep-copies a workflow and writes mapped parameter values into their target
 * node inputs. Unmapped or undefined parameters are skipped; mappings that
 * point at a missing node raise a clear configuration error.
 */
export function applyMapping(
  workflow: ComfyWorkflow,
  mapping: Record<string, NodeMapping | null | undefined>,
  values: Record<string, unknown>,
): { workflow: ComfyWorkflow; applied: Record<string, AppliedMapping> } {
  const clone = structuredClone(workflow) as ComfyWorkflow;
  const applied: Record<string, AppliedMapping> = {};
  for (const [param, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const target = mapping[param];
    if (!target) continue;
    const node = clone[target.node];
    if (!node || typeof node !== "object") {
      throw new GenerationError(
        `Workflow mapping for '${param}' points at node '${target.node}' which does not exist in the workflow`,
        { statusCode: 500 },
      );
    }
    if (!node.inputs || typeof node.inputs !== "object") {
      throw new GenerationError(
        `Workflow node '${target.node}' (target of '${param}') has no inputs object`,
        { statusCode: 500 },
      );
    }
    node.inputs[target.input] = value;
    applied[param] = { node: target.node, input: target.input, value };
  }
  return { workflow: clone, applied };
}
