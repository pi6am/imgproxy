// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import type { HistoryDetail, HistoryItem } from "../types.js";

const PAGE_SIZE = 24;

export default function HistoryPage() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (off: number) => {
    setLoading(true);
    try {
      const res = await api.history(PAGE_SIZE, off);
      setItems(res.items);
      setTotal(res.total);
      setOffset(off);
      setError("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(0);
  }, [load]);

  const remove = async (id: string) => {
    await api.deleteHistoryItem(id);
    setDetail(null);
    void load(offset);
  };

  const clearAll = async () => {
    if (!window.confirm("Delete the entire generation history? This cannot be undone.")) return;
    await api.clearHistory();
    setDetail(null);
    void load(0);
  };

  const clearFailed = async () => {
    if (!window.confirm("Delete all failed generations? Successful generations are kept.")) return;
    await api.clearFailedHistory();
    setDetail(null);
    void load(0);
  };

  const openDetail = async (id: string) => {
    try {
      setDetail(await api.historyDetail(id));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="page">
      <section className="panel">
        <div className="row space-between">
          <h2>
            History <span className="hint">{total} request{total === 1 ? "" : "s"}</span>
          </h2>
          <div className="row">
            <button onClick={() => void load(offset)} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            {total > PAGE_SIZE && (
              <>
                <button disabled={offset === 0 || loading} onClick={() => load(Math.max(0, offset - PAGE_SIZE))}>
                  ← Newer
                </button>
                <button
                  disabled={offset + PAGE_SIZE >= total || loading}
                  onClick={() => load(offset + PAGE_SIZE)}
                >
                  Older →
                </button>
              </>
            )}
            {total > 0 && (
              <>
                <button className="danger" onClick={clearFailed}>
                  Clear failed
                </button>
                <button className="danger" onClick={clearAll}>
                  Clear all
                </button>
              </>
            )}
          </div>
        </div>
        {error && <div className="banner error">{error}</div>}
        {items.length === 0 && !loading && <p className="hint">No generations yet — make one in the Test tab.</p>}
        <div className="image-grid cards">
          {items.map((item) => (
            <div key={item.id} className="card" onClick={() => void openDetail(item.id)}>
              <div className="card-thumb">
                {item.thumb_image_id ? (
                  <img src={`/api/images/${item.thumb_image_id}/file`} alt="" loading="lazy" />
                ) : (
                  <div className={`card-placeholder ${item.status}`}>{item.status === "failed" ? "✕" : "…"}</div>
                )}
              </div>
              <div className="card-meta">
                <span className={`badge ${item.source}`}>{item.source}</span>
                <span className={`badge ${item.status}`}>{item.status}</span>
                <span className="hint">{item.image_count > 0 && `${item.image_count} img`}</span>
                <span className="hint">{new Date(item.created_at).toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="row space-between">
              <h3>
                {detail.request.provider_id} <span className="hint">via {detail.request.source}</span>
              </h3>
              <div className="row">
                <button className="danger" onClick={() => void remove(detail.request.id)}>
                  Delete
                </button>
                <button onClick={() => setDetail(null)}>Close</button>
              </div>
            </div>
            {detail.request.error && <div className="banner error">{detail.request.error}</div>}
            <div className="modal-images">
              {detail.images.map((img) => (
                <a
                  key={img.id}
                  href={img.url}
                  target="_blank"
                  rel="noreferrer"
                  title={`${img.width ?? "?"}×${img.height ?? "?"} — click for full size`}
                >
                  <img src={img.url} alt="generated" />
                </a>
              ))}
            </div>
            <details>
              <summary>Request</summary>
              <pre>{JSON.stringify(JSON.parse(detail.request.request_json), null, 2)}</pre>
            </details>
            {detail.request.response_json && (
              <details>
                <summary>Response</summary>
                <pre>{JSON.stringify(JSON.parse(detail.request.response_json), null, 2)}</pre>
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
