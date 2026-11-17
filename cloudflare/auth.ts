import { HubError, discordIdSchema } from '../shared/schema';
import { Store, type Env } from './database';
const enc = new TextEncoder();
export function opaque() { return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'); }
export async function hash(value: string) { return Buffer.from(await crypto.subtle.digest('SHA-256', enc.encode(value))).toString('hex'); }
async function key(secret: string) { if (!secret || secret.length < 32) throw new HubError('SERVER_NOT_CONFIGURED', 'The service is not configured.', 503); return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode(secret)), 'AES-GCM', false, ['encrypt', 'decrypt']); }
export async function seal(value: string, secret: string) { const iv = crypto.getRandomValues(new Uint8Array(12)); return Buffer.concat([Buffer.from(iv), Buffer.from(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(secret), enc.encode(value)))]).toString('base64'); }
export async function open(value: string, secret: string) { const bytes = Buffer.from(value, 'base64'); return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, await key(secret), bytes.subarray(12))); }
export class Auth {
  constructor(public env: Env, public store: Store, public origin: string) {}
  get redirectUri() { return this.env.DISCORD_REDIRECT_URI || `${this.origin}/api/v1/auth/discord/callback`; }
  async membership(id: string) {
    discordIdSchema.parse(id);
    const response = await fetch(`https://discord.com/api/v10/guilds/${this.env.DISCORD_GUILD_ID}/members/${id}`, { headers: { authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}` }, signal: AbortSignal.timeout(15000) });
    if (response.status === 404) throw new HubError('NOT_A_MEMBER', 'Join the Team Razka Discord server to continue.', 403);
    if (!response.ok) throw new HubError('BOT_UNAVAILABLE', 'Discord membership could not be checked.', 503);
    const member = await response.json() as { roles: string[] };
    if (this.env.DISCORD_REQUIRED_ROLE_ID && !member.roles.includes(this.env.DISCORD_REQUIRED_ROLE_ID)) throw new HubError('ROLE_REQUIRED', 'Your Discord role does not have library access.', 403);
  }
  async token(form: Record<string, string>) {
    const r = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.env.DISCORD_CLIENT_ID, client_secret: this.env.DISCORD_CLIENT_SECRET, ...form }), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new HubError('DISCORD_UNAVAILABLE', 'Discord sign-in could not be completed.', 502);
    return r.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
  }
  async start() {
    if (!this.env.DISCORD_CLIENT_SECRET || !this.env.DISCORD_BOT_TOKEN || !this.env.SESSION_SECRET) throw new HubError('DISCORD_NOT_CONFIGURED', 'Discord sign-in is not configured.', 503);
    const state = opaque(), pollToken = opaque(), verifier = opaque();
    await this.store.run('DELETE FROM pairing WHERE expires_at<?', Date.now());
    await this.store.run('INSERT INTO pairing(state_hash,poll_hash,verifier,expires_at) VALUES(?,?,?,?)', await hash(state), await hash(pollToken), await seal(verifier, this.env.SESSION_SECRET), Date.now() + 600000);
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', enc.encode(verifier))).toString('base64url');
    const url = new URL('https://discord.com/oauth2/authorize');
    url.search = new URLSearchParams({ client_id: this.env.DISCORD_CLIENT_ID, response_type: 'code', redirect_uri: this.redirectUri, scope: 'identify', state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'consent' }).toString();
    return { authorizeUrl: url.toString(), pollToken, expiresIn: 600 };
  }
  async callback(code: string, state: string, issuer?: string) {
    if (issuer && issuer !== 'https://discord.com') throw new HubError('INVALID_OAUTH_STATE', 'The sign-in request is invalid.');
    const stateHash = await hash(state), pair = await this.store.get("UPDATE pairing SET status='checking' WHERE state_hash=? AND status='pending' AND expires_at>? RETURNING *", stateHash, Date.now());
    if (!pair) throw new HubError('INVALID_OAUTH_STATE', 'Start sign-in again.');
    try {
      const tokens = await this.token({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: await open(pair.verifier, this.env.SESSION_SECRET) });
      const response = await fetch('https://discord.com/api/v10/users/@me', { headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new HubError('DISCORD_UNAVAILABLE', 'Your Discord account could not be checked.', 502);
      const identity = await response.json() as { id: string; username: string; global_name?: string; avatar?: string }; discordIdSchema.parse(identity.id); await this.membership(identity.id);
      const now = Date.now(), session = opaque();
      const avatar = identity.avatar && /^[a-zA-Z0-9_]+$/.test(identity.avatar) ? `https://cdn.discordapp.com/avatars/${identity.id}/${identity.avatar}.png?size=128` : null;
      await this.env.DB.batch([
        this.store.statement('INSERT INTO users(id,name,avatar,verified_at,access_token,refresh_token,token_expires) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,avatar=excluded.avatar,verified_at=excluded.verified_at,access_token=excluded.access_token,refresh_token=excluded.refresh_token,token_expires=excluded.token_expires', identity.id, identity.global_name || identity.username, avatar, now, await seal(tokens.access_token, this.env.SESSION_SECRET), await seal(tokens.refresh_token, this.env.SESSION_SECRET), now + tokens.expires_in * 1000),
        this.store.statement('INSERT INTO sessions(hash,user_id,created_at,expires_at) VALUES(?,?,?,?)', await hash(session), identity.id, now, now + 7 * 86400000),
        this.store.statement("UPDATE pairing SET status='complete',session_token=? WHERE state_hash=?", await seal(session, this.env.SESSION_SECRET), stateHash),
      ]);
    } catch (error) { await this.store.run("UPDATE pairing SET status='failed',error_code=? WHERE state_hash=?", error instanceof HubError ? error.code : 'DISCORD_UNAVAILABLE', stateHash); throw error; }
  }
  async exchange(pollToken: string) {
    const pair = await this.store.get('SELECT * FROM pairing WHERE poll_hash=? AND expires_at>?', await hash(pollToken), Date.now());
    if (!pair) throw new HubError('SIGNIN_EXPIRED', 'Start sign-in again.', 401);
    if (pair.status === 'failed') throw new HubError(pair.error_code, 'Discord sign-in could not be completed.', 403);
    if (pair.status !== 'complete') return { status: 'pending' };
    const consumed = await this.store.get("DELETE FROM pairing WHERE poll_hash=? AND status='complete' RETURNING session_token", await hash(pollToken));
    if (!consumed) throw new HubError('SIGNIN_EXPIRED', 'Start sign-in again.', 401);
    const token = await open(consumed.session_token, this.env.SESSION_SECRET);
    return { status: 'complete', token };
  }
  async require(request: Request, admin = false, fresh = false) {
    const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{40,100})$/)?.[1];
    if (!token) throw new HubError('UNAUTHORIZED', 'Sign in with Discord to continue.', 401);
    const sessionHash = await hash(token), row = await this.store.get('SELECT s.*,u.name,u.avatar,u.verified_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.revoked_at IS NULL AND s.expires_at>?', sessionHash, Date.now());
    if (!row) throw new HubError('SESSION_EXPIRED', 'Sign in with Discord again.', 401);
    if (fresh || Date.now() - row.verified_at >= 60000) {
      try { await this.membership(row.user_id); row.verified_at = Date.now(); await this.store.run('UPDATE users SET verified_at=? WHERE id=?', row.verified_at, row.user_id); }
      catch (error) { if (error instanceof HubError && ['NOT_A_MEMBER', 'ROLE_REQUIRED'].includes(error.code)) await this.store.run('UPDATE sessions SET revoked_at=? WHERE user_id=?', Date.now(), row.user_id); throw error; }
    }
    const isAdmin = this.env.ADMIN_DISCORD_IDS?.split(',').map(v => v.trim()).includes(row.user_id) || false;
    if (admin && !isAdmin) throw new HubError('FORBIDDEN', 'Owner access is required.', 403);
    return { id: row.user_id as string, name: row.name as string, avatar: row.avatar as string | null, admin: isAdmin, mode: 'discord' as const, verifiedAt: row.verified_at as number, sessionHash, authenticatedAt: row.created_at as number };
  }
}
