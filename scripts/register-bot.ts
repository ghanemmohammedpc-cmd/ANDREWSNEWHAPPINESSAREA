import { config as loadEnv } from 'dotenv';
import { readConfig } from '../server/config';
import { registerBot } from '../server/bot';
loadEnv({ quiet: true });
try {
  const config = readConfig();
  await registerBot(config);
  console.log('Registered /verify in the configured Team Razka server.');
  console.log(`Bot invite: https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(config.clientId)}&scope=bot%20applications.commands&permissions=0&integration_type=0`);
} catch {
  console.error('Command registration failed. Check the bot token, Application ID and server ID.');
  process.exitCode = 1;
}
