import { HubError, normalizedSearch, type ModMetadata } from '../shared/schema';
export interface Statement { bind(...values: unknown[]): Statement; first<T = Record<string, any>>(): Promise<T | null>; all<T = Record<string, any>>(): Promise<{ results: T[] }>; run(): Promise<unknown>; }
export interface Database { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<unknown[]>; }
export interface Env {
  DB: Database; APP_BASE_URL?: string; DISCORD_REDIRECT_URI?: string; SESSION_SECRET: string; DISCORD_CLIENT_ID: string; DISCORD_CLIENT_SECRET: string; DISCORD_BOT_TOKEN: string; DISCORD_GUILD_ID: string; DISCORD_REQUIRED_ROLE_ID?: string; ADMIN_DISCORD_IDS: string; DISCORD_INVITE_URL: string; GITHUB_REPOSITORY: string; GITHUB_TOKEN: string; PUBLISH_CALLBACK_SECRET: string;
}
export class Store {
  constructor(public db: Database) {}
  select = `SELECT mods.*,(SELECT count(*) FROM reviews WHERE mod_id=mods.id) _review_count,(SELECT avg(rating) FROM reviews WHERE mod_id=mods.id) _rating,(SELECT count(*) FROM download_tickets WHERE mod_id=mods.id AND result='completed') _downloads,(SELECT json_object('id',id,'mod_id',mod_id,'version',version,'changelog',changelog,'filename',filename,'size',size,'sha256',sha256,'created_at',created_at) FROM versions WHERE id=mods.active_version) _version FROM mods`;
  statement(sql: string, ...args: unknown[]) { return this.db.prepare(sql).bind(...args); }
  get(sql: string, ...args: unknown[]) { return this.statement(sql, ...args).first(); }
  async all(sql: string, ...args: unknown[]) { return (await this.statement(sql, ...args).all()).results; }
  run(sql: string, ...args: unknown[]) { return this.statement(sql, ...args).run(); }
  audit(actor: string, action: string, target: string | null, detail: unknown = {}) { return this.run('INSERT INTO audit VALUES(?,?,?,?,?,?)', crypto.randomUUID(), actor, action, target, JSON.stringify(detail), Date.now()); }
  search(m: ModMetadata) { return normalizedSearch([m.name, m.creator, m.manufacturer, m.model, m.years, ...m.tags].join(' ')); }
  version(row: Record<string, any> | null) { return row ? { id: row.id, modId: row.mod_id, version: row.version, changelog: row.changelog, filename: row.filename, size: row.size, sha256: row.sha256, createdAt: row.created_at } : null; }
  async mod(row: Record<string, any>) {
    return { ...JSON.parse(row.metadata), id: row.id, name: row.name, creator: row.creator, type: row.type, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, downloads: Number(row._downloads || 0), rating: row._rating == null ? null : Number(row._rating), reviewCount: Number(row._review_count || 0), activeVersion: this.version(row._version ? JSON.parse(row._version) : null) };
  }
  async requireMod(id: string, admin = false) {
    const row = await this.get(`${this.select} WHERE id=? AND deleted_at IS NULL`, id);
    if (!row || !admin && row.status !== 'published') throw new HubError('NOT_FOUND', 'This mod is not available.', 404);
    return this.mod(row);
  }
  async list(query: { q: string; type: string; tag: string; brand?: string; sort: string; page: number; limit: number }, admin = false, favorites?: string[]) {
    const conditions = ['deleted_at IS NULL'], args: unknown[] = [];
    if (!admin) conditions.push("status='published'");
    if (favorites) { conditions.push(favorites.length ? `id IN (${favorites.map(() => '?').join(',')})` : '0'); args.push(...favorites); }
    if (query.type !== 'all') { conditions.push('type=?'); args.push(query.type); }
    if (query.brand) { if (query.brand === '__unknown__') conditions.push("trim(coalesce(json_extract(metadata,'$.manufacturer'),''))=''"); else { conditions.push("json_extract(metadata,'$.manufacturer')=? COLLATE NOCASE"); args.push(query.brand); } }
    if (query.q) { conditions.push("search LIKE ? ESCAPE '\\'"); args.push(`%${normalizedSearch(query.q).replace(/[\\%_]/g, '\\$&')}%`); }
    if (query.tag) { conditions.push("EXISTS(SELECT 1 FROM json_each(json_extract(mods.metadata,'$.tags')) WHERE value=?)"); args.push(query.tag); }
    const where = conditions.join(' AND '), sort = { brand: "CASE WHEN trim(coalesce(json_extract(metadata,'$.manufacturer'),''))='' THEN 1 ELSE 0 END,json_extract(metadata,'$.manufacturer') COLLATE NOCASE,name COLLATE NOCASE,id", name: 'name COLLATE NOCASE,id', size: '(SELECT size FROM versions WHERE id=active_version) DESC,id', downloads: "(SELECT count(*) FROM download_tickets WHERE mod_id=mods.id AND result='completed') DESC,id", newest: 'updated_at DESC,id' }[query.sort] || 'updated_at DESC,id';
    const total = Number((await this.get(`SELECT count(*) n FROM mods WHERE ${where}`, ...args))?.n || 0);
    const rows = await this.all(`${this.select} WHERE ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`, ...args, query.limit, (query.page - 1) * query.limit);
    return { items: await Promise.all(rows.map(row => this.mod(row))), total, page: query.page, limit: query.limit };
  }
}
