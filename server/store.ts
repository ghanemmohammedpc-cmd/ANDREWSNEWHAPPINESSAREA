import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HubError, normalizedSearch, type Mod, type ModMetadata, type ModVersion } from '../shared/schema';

type Row = Record<string, any>;
export class Store {
  db: DatabaseSync;
  constructor(dataDir: string, migrationSql?: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'library.sqlite'));
    this.db.exec(migrationSql || readFileSync(new URL('./migrations.sql', import.meta.url), 'utf8'));
  }
  get(sql: string, ...args: any[]): Row | undefined { return this.db.prepare(sql).get(...args) as Row | undefined; }
  all(sql: string, ...args: any[]): Row[] { return this.db.prepare(sql).all(...args) as Row[]; }
  run(sql: string, ...args: any[]) { return this.db.prepare(sql).run(...args); }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  audit(actor: string, action: string, target: string | null, detail: Record<string, unknown> = {}) {
    this.run('INSERT INTO audit VALUES(?,?,?,?,?,?)', randomUUID(), actor, action, target, JSON.stringify(detail), Date.now());
  }
  version(row: Row | undefined): ModVersion | null {
    if (!row) return null;
    return { id: row.id, modId: row.mod_id, version: row.version, changelog: row.changelog, filename: row.filename, size: row.size, sha256: row.sha256, createdAt: row.created_at };
  }
  mod(row: Row): Mod {
    const metadata = JSON.parse(row.metadata) as ModMetadata;
    const reviews = this.get('SELECT count(*) n,avg(rating) average FROM reviews WHERE mod_id=?', row.id);
    return { ...metadata, id: row.id, name: row.name, creator: row.creator, type: row.type, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, downloads: Number(this.get("SELECT count(*) AS n FROM download_tickets WHERE mod_id=? AND result='completed'", row.id)?.n || 0), rating: reviews?.average == null ? null : Number(reviews.average), reviewCount: Number(reviews?.n || 0), activeVersion: this.version(row.active_version ? this.get('SELECT * FROM versions WHERE id=?', row.active_version) : undefined) };
  }
  requireMod(id: string, admin = false): Mod {
    const row = this.get('SELECT * FROM mods WHERE id=? AND deleted_at IS NULL', id);
    if (!row || !admin && row.status !== 'published') throw new HubError('NOT_FOUND', 'This mod is not available.', 404);
    return this.mod(row);
  }
  list(query: { q: string; type: string; tag: string; sort: string; page: number; limit: number }, admin = false, favorites?: string[]) {
    const conditions = ['deleted_at IS NULL']; const args: any[] = [];
    if (favorites) { conditions.push(favorites.length ? `id IN (${favorites.map(() => '?').join(',')})` : '0'); args.push(...favorites); }
    if (!admin) conditions.push("status='published'");
    if (query.type !== 'all') { conditions.push('type=?'); args.push(query.type); }
    if (query.q) { conditions.push("search LIKE ? ESCAPE '\\'"); args.push(`%${normalizedSearch(query.q).replace(/[\\%_]/g, '\\$&')}%`); }
    if (query.tag) { conditions.push('EXISTS(SELECT 1 FROM json_each(json_extract(mods.metadata,\'$.tags\')) WHERE value=?)'); args.push(query.tag); }
    const where = conditions.join(' AND ');
    const sort = { newest: 'updated_at DESC,id', name: 'name COLLATE NOCASE,id', size: '(SELECT size FROM versions WHERE id=active_version) DESC,id', downloads: "(SELECT count(*) FROM download_tickets WHERE mod_id=mods.id AND result='completed') DESC,id" }[query.sort] || 'updated_at DESC,id';
    const total = Number(this.get(`SELECT count(*) AS n FROM mods WHERE ${where}`, ...args)?.n || 0);
    const items = this.all(`SELECT * FROM mods WHERE ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`, ...args, query.limit, (query.page - 1) * query.limit).map(row => this.mod(row));
    return { items, total, page: query.page, limit: query.limit };
  }
  createMod(metadata: ModMetadata) {
    const id = randomUUID(), now = Date.now();
    this.run('INSERT INTO mods(id,name,creator,type,metadata,search,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', id, metadata.name, metadata.creator, metadata.type, JSON.stringify(metadata), this.search(metadata), now, now);
    return id;
  }
  search(m: ModMetadata) { return normalizedSearch([m.name, m.creator, m.manufacturer, m.model, m.years, ...m.tags].join(' ')); }
  updateMod(id: string, metadata: ModMetadata) {
    this.requireMod(id, true);
    this.run('UPDATE mods SET name=?,creator=?,type=?,metadata=?,search=?,updated_at=? WHERE id=?', metadata.name, metadata.creator, metadata.type, JSON.stringify(metadata), this.search(metadata), Date.now(), id);
    return this.requireMod(id, true);
  }
  stats() {
    return {
      published: Number(this.get("SELECT count(*) n FROM mods WHERE status='published' AND deleted_at IS NULL")?.n || 0),
      drafts: Number(this.get("SELECT count(*) n FROM mods WHERE status='draft' AND deleted_at IS NULL")?.n || 0),
      catalogBytes: Number(this.get('SELECT coalesce(sum(v.size),0) n FROM mods m JOIN versions v ON v.id=m.active_version WHERE m.deleted_at IS NULL')?.n || 0),
      completedDownloads: Number(this.get("SELECT count(*) n FROM download_tickets WHERE result='completed'")?.n || 0),
      failedDownloads: Number(this.get("SELECT count(*) n FROM download_tickets WHERE result='failed'")?.n || 0),
      storedBytes: Number(this.get('SELECT coalesce(sum(size),0) n FROM versions')?.n || 0),
    };
  }
  close() { this.db.close(); }
}
