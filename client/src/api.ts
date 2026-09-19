// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

async function unwrap<T>(res: Promise<Response>): Promise<T> {
  const r = await res;
  if (!r.ok) {
    let message = `${r.status} ${r.statusText}`;
    try {
      const body = (await r.json()) as { error?: string; detail?: string };
      message = body.error ?? body.detail ?? message;
    } catch {
      /* keep status text */
    }
    throw new Error(message);
  }
  return (await r.json()) as T;
}

export const api = {
  getConfig: () => unwrap<import("./types.js").AppConfig>(fetch("/api/config")),

  saveConfig: (config: unknown) =>
    unwrap<import("./types.js").AppConfig>(
      fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      }),
    ),

  analyzeWorkflow: (workflow: unknown) =>
    unwrap<{ nodes: import("./types.js").WorkflowNodeInfo[] }>(
      fetch("/api/workflow/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow }),
      }),
    ),

  checkProvider: (id: string) =>
    unwrap<{ ok: boolean; detail: string }>(fetch(`/api/providers/${encodeURIComponent(id)}/check`, { method: "POST" })),

  generate: (body: Record<string, unknown>) =>
    unwrap<import("./types.js").GenerateResult>(
      fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),

  history: (limit = 24, offset = 0) =>
    unwrap<{ total: number; items: import("./types.js").HistoryItem[] }>(
      fetch(`/api/history?limit=${limit}&offset=${offset}`),
    ),

  historyDetail: (id: string) => unwrap<import("./types.js").HistoryDetail>(fetch(`/api/history/${id}`)),

  deleteHistoryItem: (id: string) => unwrap<{ deleted: string }>(fetch(`/api/history/${id}`, { method: "DELETE" })),

  clearHistory: () => unwrap<{ cleared: boolean }>(fetch("/api/history", { method: "DELETE" })),
};
