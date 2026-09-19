// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyMapping, listWorkflowNodes, type ComfyWorkflow } from "./workflow.js";

const workflowsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../workflows");

function loadWorkflow(name: string): ComfyWorkflow {
  return JSON.parse(fs.readFileSync(path.join(workflowsDir, name), "utf8")) as ComfyWorkflow;
}

describe("applyMapping", () => {
  it("writes values into mapped node inputs without mutating the original", () => {
    const wf = loadWorkflow("image_krea2_turbo_t2i.json");
    const mapping = {
      prompt: { node: "30:19", input: "value" },
      width: { node: "52", input: "value" },
      height: { node: "53", input: "value" },
      seed: { node: "55", input: "value" },
      steps: { node: "30:3", input: "steps" },
    };
    const { workflow, applied } = applyMapping(wf, mapping, {
      prompt: "a cat",
      width: 768,
      height: 512,
      seed: 42,
      steps: 6,
      cfg: 2, // not mapped -> ignored
    });

    expect(workflow).not.toBe(wf);
    expect((workflow["30:19"]!.inputs.value as string)).toBe("a cat");
    expect(workflow["52"]!.inputs.value).toBe(768);
    expect(workflow["53"]!.inputs.value).toBe(512);
    expect(workflow["55"]!.inputs.value).toBe(42);
    expect(workflow["30:3"]!.inputs.steps).toBe(6);
    // cfg unmapped, original value untouched
    expect(workflow["30:3"]!.inputs.cfg).toBe(1);
    // original untouched
    expect((wf["30:19"]!.inputs.value as string)).toContain("cheeseburger");
    expect(Object.keys(applied).sort()).toEqual(["height", "prompt", "seed", "steps", "width"]);
  });

  it("supports direct inputs on functional nodes (t2i2 inline style)", () => {
    const wf = loadWorkflow("image_krea2_turbo_t2i2.json");
    const mapping = {
      width: { node: "30:5", input: "width" },
      height: { node: "30:5", input: "height" },
      seed: { node: "30:3", input: "seed" },
    };
    const { workflow } = applyMapping(wf, mapping, { width: 640, height: 960, seed: 7 });
    expect(workflow["30:5"]!.inputs.width).toBe(640);
    expect(workflow["30:5"]!.inputs.height).toBe(960);
    expect(workflow["30:3"]!.inputs.seed).toBe(7);
  });

  it("throws a clear error when a mapping targets a missing node", () => {
    const wf = loadWorkflow("image_krea2_turbo_t2i.json");
    expect(() => applyMapping(wf, { width: { node: "nope", input: "value" } }, { width: 100 })).toThrow(
      /missing node 'nope'|does not exist/i,
    );
  });

  it("skips undefined values and null mappings", () => {
    const wf = loadWorkflow("image_krea2_turbo_t2i.json");
    const { applied, workflow } = applyMapping(
      wf,
      { width: { node: "52", input: "value" }, steps: null },
      { width: undefined, steps: 5 },
    );
    expect(applied).toEqual({});
    expect(workflow["52"]!.inputs.value).toBe(1024);
  });
});

describe("listWorkflowNodes", () => {
  it("classifies link vs scalar inputs and previews current values", () => {
    const wf = loadWorkflow("image_krea2_turbo_t2i.json");
    const nodes = listWorkflowNodes(wf);
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const primitive = byId.get("52")!;
    expect(primitive.classType).toBe("PrimitiveInt");
    expect(primitive.inputs).toEqual([
      { name: "value", kind: "scalar", valueType: "number", value: "1024" },
    ]);

    const clipEncode = byId.get("30:6")!;
    const textInput = clipEncode.inputs.find((i) => i.name === "text")!;
    expect(textInput.kind).toBe("link");
    expect(textInput.value).toBeUndefined();

    const sampler = byId.get("30:3")!;
    const seedInput = sampler.inputs.find((i) => i.name === "seed")!;
    expect(seedInput.kind).toBe("link");
    expect(sampler.title).toBe("KSampler");
    expect(sampler.inputs.find((i) => i.name === "steps")!.value).toBe("8");
    expect(sampler.inputs.find((i) => i.name === "cfg")!.value).toBe("1");
  });

  it("truncates and flattens long string values in previews", () => {
    const wf = loadWorkflow("image_krea2_turbo_t2i.json");
    const nodes = listWorkflowNodes(wf);
    const systemPrompt = nodes.find((n) => n.id === "30:18")!;
    const valueInput = systemPrompt.inputs.find((i) => i.name === "value")!;
    expect(valueInput.kind).toBe("scalar");
    expect(valueInput.value!.length).toBe(49); // 48 chars + ellipsis
    expect(valueInput.value!.endsWith("…")).toBe(true);
    expect(/\n/.test(valueInput.value!)).toBe(false);
  });

  it("ignores non-node entries", () => {
    const nodes = listWorkflowNodes({ bogus: { nope: true } } as unknown as ComfyWorkflow);
    expect(nodes).toEqual([]);
  });
});
