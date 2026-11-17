import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { HubError } from '../shared/schema';

export type Config = ReturnType<typeof readConfig>;
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || './data');
  mkdirSync(dataDir, { recursive: true });
  let secret = env.SESSION_SECRET || '';
  if (!secret) {
    if (env.NODE_ENV === 'production') throw new Error('SESSION_SECRET is required in production.');
    const file = path.join(dataDir, 'session.key');
    secret = existsSync(file) ? readFileSync(file, 'utf8').trim() : randomBytes(48).toString('base64url');
    if (!existsSync(file)) writeFileSync(file, secret, { mode: 0o600, flag: 'wx' });
  }
  if (secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  const baseUrl = env.APP_BASE_URL || 'http://127.0.0.1:8787';
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('APP_BASE_URL requires HTTPS outside localhost.');
  const clientId = env.DISCORD_CLIENT_ID || '';
  const clientSecret = env.DISCORD_CLIENT_SECRET || '';
  const botToken = env.DISCORD_BOT_TOKEN || '';
  const guildId = env.DISCORD_GUILD_ID || '';
  const redirectUri = env.DISCORD_REDIRECT_URI || `${url.origin}/api/v1/auth/discord/callback`;
  return {
    host: env.HOST || '127.0.0.1', port: Number(env.PORT || 8787), dataDir, secret, baseUrl: url.origin,
    clientId, clientSecret, botToken, guildId, redirectUri, requiredRoleId: env.DISCORD_REQUIRED_ROLE_ID || '',
    adminIds: new Set((env.ADMIN_DISCORD_IDS || '').split(',').map(v => v.trim()).filter(Boolean)),
    inviteUrl: env.DISCORD_INVITE_URL || 'https://discord.gg/DHF4akrWmr',
    discordConfigured: Boolean(clientId && clientSecret && botToken && guildId),
    storageDriver: env.STORAGE_DRIVER || 'local', githubRepository: env.GITHUB_REPOSITORY || 'ghanemmohammedpc-cmd/ANDREWSNEWHAPPINESSAREA',
    githubAppId: env.GITHUB_APP_ID || '', githubInstallationId: env.GITHUB_APP_INSTALLATION_ID || '', githubPrivateKeyPath: env.GITHUB_APP_PRIVATE_KEY_PATH || '',
    s3Endpoint: env.S3_ENDPOINT || '', s3Bucket: env.S3_BUCKET || '', s3Region: env.S3_REGION || 'auto', s3AccessKeyId: env.S3_ACCESS_KEY_ID || '', s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
  };
}
export function requireDiscordConfig(config: Config) {
  if (!config.discordConfigured) throw new HubError('DISCORD_NOT_CONFIGURED', 'The owner needs to finish the Discord connection setup.', 503);
}
