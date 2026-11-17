import { config as loadEnv } from 'dotenv';
import { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder, type Interaction } from 'discord.js';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { readConfig, type Config } from './config';
import { Discord } from './auth';

loadEnv({ quiet: true });

export async function registerBot(config: Config) {
  if (!config.botToken || !config.clientId || !config.guildId) throw new Error('Configure DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID and DISCORD_GUILD_ID first.');
  const rest = new REST({ version: '10' }).setToken(config.botToken);
  await rest.post(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: new SlashCommandBuilder().setName('verify').setDescription('Check Team Razka membership | التحقق من العضوية').toJSON() });
}
export function verificationHandler(config: Config, membership: (userId: string) => Promise<{ roles: string[] }>) {
  return async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'verify') return;
    const arabic = interaction.locale.startsWith('ar');
    const message = (en: string, ar: string) => arabic ? ar : en;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (interaction.guildId !== config.guildId) {
        await interaction.editReply(message('Verification is available in the Team Razka server.', 'التحقق متاح داخل سيرفر Team Razka فقط.'));
        return;
      }
      const member = await membership(interaction.user.id);
      if (config.requiredRoleId && !member.roles.includes(config.requiredRoleId)) {
        await interaction.editReply(message('You are a member, but you do not have the required library role. Contact the server staff.', 'عضويتك موجودة، لكن ما عندك الرتبة المطلوبة لدخول المكتبة. تواصل مع الإدارة.'));
        return;
      }
      await interaction.editReply(message('Your Team Razka membership is confirmed. Sign in to Team Razka Program with this Discord account. The app checks membership again when you sign in.', 'تم تأكيد عضويتك. سجّل دخولك في Team Razka Program بنفس حساب ديسكورد. التطبيق يتحقق من عضويتك مرة ثانية عند تسجيل الدخول.'));
    } catch {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message('Membership could not be checked right now. Please try again shortly.', 'تعذّر التحقق الآن. جرّب مرة ثانية بعد قليل.')).catch(() => {});
      }
    }
  };
}
export async function startBot(config: Config) {
  if (!config.botToken || !config.guildId) throw new Error('Configure the bot token and Team Razka server ID first.');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const discord = new Discord(config);
  client.on(Events.InteractionCreate, verificationHandler(config, id => discord.membership('', id)));
  client.on(Events.Error, () => { console.error('Discord connection error. The bot will attempt to reconnect.'); });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const ready = once(client, Events.ClientReady, { signal: controller.signal });
    await Promise.all([ready, client.login(config.botToken)]);
    if (!client.isReady()) throw new Error('The bot did not finish connecting.');
    if (!client.guilds.cache.has(config.guildId)) throw new Error('The bot is not installed in the configured server.');
  } catch {
    await client.destroy();
    throw new Error('The bot could not connect. Check its token and server access.');
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  return client;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = readConfig();
  startBot(config).then(client => {
    console.log(`Online: ${client.user?.username}. Server: ${client.guilds.cache.get(config.guildId)?.name}.`);
    const stop = () => { void client.destroy().finally(() => process.exit(0)); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(() => { console.error('The bot could not start. Check its token and server access.'); process.exitCode = 1; });
}
