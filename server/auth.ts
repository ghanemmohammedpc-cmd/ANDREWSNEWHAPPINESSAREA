import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { HubError, type User } from '../shared/schema';
import type { Config } from './config';
import { requireDiscordConfig } from './config';
import type { Store } from './store';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const opaque = () => randomBytes(32).toString('base64url');
export class Vault {
  key: Buffer;
  constructor(secret: string) { this.key = createHash('sha256').update(secret).digest(); }
  seal(value: string) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv); return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64'); }
  open(value: string) { const all = Buffer.from(value, 'base64'); const decipher = createDecipheriv('aes-256-gcm', this.key, all.subarray(0, 12)); decipher.setAuthTag(all.subarray(-16)); return Buffer.concat([decipher.update(all.subarray(12, -16)), decipher.final()]).toString('utf8'); }
}
export interface DiscordProvider {
  exchange(code: string, verifier: string): Promise<any>;
  refresh(token: string): Promise<any>;
  identity(token: string): Promise<{ id: string; username: string; global_name?: string | null; avatar?: string | null }>;
  membership(token: string, userId: string): Promise<{ roles: string[] }>;
  revoke(token: string): Promise<void>;
}
export class Discord implements DiscordProvider {
  constructor(private config: Config) {}
  async token(form: Record<string, string>) {
    const result = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...form }), signal: AbortSignal.timeout(20000) });
    if (!result.ok) throw new HubError('DISCORD_UNAVAILABLE', 'Discord sign-in could not be completed. Please try again.', 502);
    return result.json();
  }
  exchange(code: string, verifier: string) { return this.token({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri, code_verifier: verifier }); }
  refresh(refresh_token: string) { return this.token({ grant_type: 'refresh_token', refresh_token }); }
  async get(endpoint: string, token: string) {
    const result = await fetch(`https://discord.com/api/v10${endpoint}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
    if (result.status === 404 || result.status === 403) throw new HubError('NOT_A_MEMBER', 'Join the Team Razka Discord server to continue.', 403);
    if (result.status === 401) throw new HubError('SESSION_EXPIRED', 'Sign in with Discord again.', 401);
    if (!result.ok) throw new HubError('DISCORD_UNAVAILABLE', 'Discord verification is temporarily unavailable.', 503);
    return result.json();
  }
  identity(token: string): Promise<any> { return this.get('/users/@me', token); }
  async membership(_token: string, userId: string): Promise<{ roles: string[] }> {
    const response = await fetch(`https://discord.com/api/v10/guilds/${this.config.guildId}/members/${userId}`, { headers: { authorization: `Bot ${this.config.botToken}` }, signal: AbortSignal.timeout(15000) });
    if (response.status === 404) throw new HubError('NOT_A_MEMBER', 'Join the Team Razka Discord server to continue.', 403);
    if (!response.ok) throw new HubError('BOT_UNAVAILABLE', 'The verification bot could not check your membership. Try again shortly.', 503);
    return response.json() as Promise<{ roles: string[] }>;
  }
  async revoke(token: string) {
    await fetch('https://discord.com/api/oauth2/token/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, token }), signal: AbortSignal.timeout(10000) }).catch(() => {});
  }
}
export class Auth {
  vault: Vault;
  constructor(public config: Config, public store: Store, public discord: DiscordProvider = new Discord(config)) { this.vault = new Vault(config.secret); }
  start() {
    requireDiscordConfig(this.config);
    const state = opaque(), pollToken = opaque(), verifier = opaque();
    this.store.run('DELETE FROM pairing WHERE expires_at<?', Date.now());
    this.store.run('INSERT INTO pairing(state_hash,poll_hash,verifier,expires_at) VALUES(?,?,?,?)', hash(state), hash(pollToken), this.vault.seal(verifier), Date.now() + 600000);
    const url = new URL('https://discord.com/oauth2/authorize');
    url.search = new URLSearchParams({ client_id: this.config.clientId, response_type: 'code', redirect_uri: this.config.redirectUri, scope: 'identify', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'consent' }).toString();
    return { authorizeUrl: url.toString(), pollToken, expiresIn: 600 };
  }
  async callback(code: string, state: string, issuer?: string) {
    if (issuer && issuer !== 'https://discord.com') throw new HubError('INVALID_OAUTH_STATE', 'This sign-in request is not valid.', 400);
    const pair = this.store.get("SELECT * FROM pairing WHERE state_hash=? AND expires_at>? AND status='pending'", hash(state), Date.now());
    if (!pair) throw new HubError('INVALID_OAUTH_STATE', 'The sign-in request expired. Start sign-in again.', 400);
    this.store.run("UPDATE pairing SET status='checking' WHERE state_hash=?", hash(state));
    try {
      const tokens = await this.discord.exchange(code, this.vault.open(pair.verifier));
      const identity = await this.discord.identity(tokens.access_token);
      const member = await this.discord.membership(tokens.access_token, identity.id);
      this.checkRole(member.roles);
      const now = Date.now();
      this.store.run(`INSERT INTO users(id,name,avatar,verified_at,access_token,refresh_token,token_expires) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,avatar=excluded.avatar,verified_at=excluded.verified_at,access_token=excluded.access_token,refresh_token=excluded.refresh_token,token_expires=excluded.token_expires`, identity.id, identity.global_name || identity.username, identity.avatar ? `https://cdn.discordapp.com/avatars/${identity.id}/${identity.avatar}.png?size=128` : null, now, this.vault.seal(tokens.access_token), this.vault.seal(tokens.refresh_token), now + tokens.expires_in * 1000);
      const session = opaque();
      this.store.run('INSERT INTO sessions(hash,user_id,created_at,expires_at) VALUES(?,?,?,?)', hash(session), identity.id, now, now + 7 * 86400000);
      this.store.run("UPDATE pairing SET status='complete',session_token=? WHERE state_hash=?", this.vault.seal(session), hash(state));
    } catch (error) {
      this.store.run("UPDATE pairing SET status='failed',error_code=? WHERE state_hash=?", error instanceof HubError ? error.code : 'DISCORD_UNAVAILABLE', hash(state));
      throw error;
    }
  }
  exchange(pollToken: string) {
    const pair = this.store.get('SELECT * FROM pairing WHERE poll_hash=? AND expires_at>?', hash(pollToken), Date.now());
    if (!pair) throw new HubError('SIGNIN_EXPIRED', 'Start Discord sign-in again.', 401);
    if (pair.status === 'failed') throw new HubError(pair.error_code, pair.error_code === 'NOT_A_MEMBER' ? 'Join the Team Razka Discord server to continue.' : 'Discord sign-in could not be completed.', 403);
    if (pair.status !== 'complete') return { status: 'pending' };
    const token = this.vault.open(pair.session_token);
    this.store.run('DELETE FROM pairing WHERE poll_hash=?', hash(pollToken));
    return { status: 'complete', token };
  }
  checkRole(roles: string[]) { if (this.config.requiredRoleId && !roles.includes(this.config.requiredRoleId)) throw new HubError('ROLE_REQUIRED', 'Your Discord role does not have library access.', 403); }
  async require(request: Pick<FastifyRequest, 'headers'>, admin = false, fresh = false): Promise<User & { sessionHash: string; authenticatedAt: number }> {
    const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,100})$/)?.[1];
    if (!token) throw new HubError('UNAUTHORIZED', 'Sign in with Discord to continue.', 401);
    const sessionHash = hash(token);
    const row = this.store.get('SELECT s.*,u.name,u.avatar,u.verified_at,u.access_token,u.refresh_token,u.token_expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.revoked_at IS NULL AND s.expires_at>?', sessionHash, Date.now());
    if (!row) throw new HubError('SESSION_EXPIRED', 'Your session expired. Sign in with Discord again.', 401);
    let verifiedAt = row.verified_at;
    if (fresh || Date.now() - verifiedAt >= 60000) {
      try {
        let access = this.vault.open(row.access_token);
        if (row.token_expires <= Date.now() + 60000) {
          const tokens = await this.discord.refresh(this.vault.open(row.refresh_token)); access = tokens.access_token;
          this.store.run('UPDATE users SET access_token=?,refresh_token=?,token_expires=? WHERE id=?', this.vault.seal(access), this.vault.seal(tokens.refresh_token), Date.now() + tokens.expires_in * 1000, row.user_id);
        }
        this.checkRole((await this.discord.membership(access, row.user_id)).roles);
        verifiedAt = Date.now(); this.store.run('UPDATE users SET verified_at=? WHERE id=?', verifiedAt, row.user_id);
      } catch (error) {
        if (error instanceof HubError && ['NOT_A_MEMBER', 'ROLE_REQUIRED', 'SESSION_EXPIRED'].includes(error.code)) this.store.run('UPDATE sessions SET revoked_at=? WHERE user_id=?', Date.now(), row.user_id);
        throw error;
      }
    }
    const isAdmin = this.config.adminIds.has(row.user_id);
    if (admin && !isAdmin) throw new HubError('FORBIDDEN', 'This action is only available to the library owner.', 403);
    return { id: row.user_id, name: row.name, avatar: row.avatar, admin: isAdmin, mode: 'discord', verifiedAt, sessionHash, authenticatedAt: row.created_at };
  }
  async logout(request: Pick<FastifyRequest, 'headers'>) {
    const user = await this.require(request);
    this.store.run('UPDATE sessions SET revoked_at=? WHERE hash=?', Date.now(), user.sessionHash);
  }
}
