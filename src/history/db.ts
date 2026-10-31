// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import Database from "better-sqlite3";

export interface RequestRow {
  id: string;
  created_at: number;
  source: string;
  provider_id: string;
  provider_type: string;
  status: "pending" | "succeeded" | "failed";
  request_json: string;
  response_json: string | null;
  error: string | null;
}

export interface ImageRow {
  id: string;
  request_id: string;
  filename: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number;
  created_at: number;
}

export interface RequestListItem extends RequestRow {
  image_count: number;
  thumb_image_id: string | null;
}

export interface NewRequest {
  id: string;
  source: string;
  providerId: string;
  providerType: string;
  requestJson: string;
}

export interface NewImage {
  id: string;
  requestId: string;
  filename: string;
  mime: string;
  width?: number;
  height?: number;
  bytes: number;
}

export class HistoryDb {
  private db: Database.Database;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        response_json TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        mime TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_images_request ON images(request_id);
      CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at);
    `);
    // Runs interrupted by a restart should not stay "pending" forever.
    this.db
      .prepare("UPDATE requests SET status = 'failed', error = 'interrupted by server restart' WHERE status = 'pending'")
      .run();
  }

  createRequest(req: NewRequest): void {
    this.db
      .prepare(
        `INSERT INTO requests (id, created_at, source, provider_id, provider_type, status, request_json)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(req.id, Date.now(), req.source, req.providerId, req.providerType, req.requestJson);
  }

  completeRequest(id: string, responseJson: string): void {
    this.db
      .prepare("UPDATE requests SET status = 'succeeded', response_json = ? WHERE id = ?")
      .run(responseJson, id);
  }

  failRequest(id: string, error: string): void {
    this.db
      .prepare("UPDATE requests SET status = 'failed', error = ? WHERE id = ?")
      .run(error.slice(0, 4000), id);
  }

  addImage(img: NewImage): void {
    this.db
      .prepare(
        `INSERT INTO images (id, request_id, filename, mime, width, height, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(img.id, img.requestId, img.filename, img.mime, img.width ?? null, img.height ?? null, img.bytes, Date.now());
  }

  getRequest(id: string): RequestRow | undefined {
    return this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as RequestRow | undefined;
  }

  listImages(requestId: string): ImageRow[] {
    return this.db
      .prepare("SELECT * FROM images WHERE request_id = ? ORDER BY created_at, id")
      .all(requestId) as ImageRow[];
  }

  getImage(id: string): ImageRow | undefined {
    return this.db.prepare("SELECT * FROM images WHERE id = ?").get(id) as ImageRow | undefined;
  }

  listRequests(limit: number, offset: number): { total: number; items: RequestListItem[] } {
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM requests").get() as { c: number }).c;
    const items = this.db
      .prepare(
        `SELECT r.*,
                (SELECT COUNT(*) FROM images i WHERE i.request_id = r.id) AS image_count,
                (SELECT i.id FROM images i WHERE i.request_id = r.id ORDER BY i.created_at, i.id LIMIT 1) AS thumb_image_id
         FROM requests r
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as RequestListItem[];
    return { total, items };
  }

  /** Deletes a request (images cascade); returns image filenames to unlink from disk. */
  deleteRequest(id: string): string[] {
    const files = (
      this.db.prepare("SELECT filename FROM images WHERE request_id = ?").all(id) as { filename: string }[]
    ).map((r) => r.filename);
    this.db.prepare("DELETE FROM requests WHERE id = ?").run(id);
    return files;
  }

  /** Deletes a single image; returns its filename to unlink, or null if not found. */
  deleteImage(id: string): string | null {
    const img = this.getImage(id);
    if (!img) return null;
    this.db.prepare("DELETE FROM images WHERE id = ?").run(id);
    return img.filename;
  }

  /** Clears all history; returns all image filenames to unlink. */
  clear(): string[] {
    const files = (this.db.prepare("SELECT filename FROM images").all() as { filename: string }[]).map(
      (r) => r.filename,
    );
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM images").run();
      this.db.prepare("DELETE FROM requests").run();
    })();
    return files;
  }

  /** Deletes every failed request (images cascade); returns image filenames
   *  to unlink. Failed requests normally have no images, but any stray rows
   *  (there for historic reasons) are collected too. */
  clearFailed(): string[] {
    const files = (
      this.db
        .prepare(
          "SELECT i.filename FROM images i JOIN requests r ON i.request_id = r.id WHERE r.status = 'failed'",
        )
        .all() as { filename: string }[]
    ).map((r) => r.filename);
    this.db.prepare("DELETE FROM requests WHERE status = 'failed'").run();
    return files;
  }

  close(): void {
    this.db.close();
  }
}
