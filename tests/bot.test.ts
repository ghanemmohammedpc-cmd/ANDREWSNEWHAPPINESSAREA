import { describe, expect, it, vi } from 'vitest';
import type { Interaction } from 'discord.js';
import type { Config } from '../server/config';
import { verificationHandler } from '../server/bot';

const config = { guildId: '123456789012345678', requiredRoleId: '' } as Config;
function interaction(overrides: Record<string, unknown> = {}) {
  const mock = {
    isChatInputCommand: () => true,
    commandName: 'verify', guildId: config.guildId, locale: 'en-US', user: { id: '234567890123456789' },
    deferred: false, replied: false,
    deferReply: vi.fn(async () => { mock.deferred = true; }),
    editReply: vi.fn(async (_message: string) => {}),
    ...overrides,
  };
  return mock;
}
describe('Discord membership command', () => {
  it('only confirms membership after checking the invoking account', async () => {
    const check = vi.fn(async () => ({ roles: [] }));
    const item = interaction();
    await verificationHandler(config, check)(item as unknown as Interaction);
    expect(check).toHaveBeenCalledExactlyOnceWith(item.user.id);
    expect(item.deferReply).toHaveBeenCalledExactlyOnceWith({ flags: 64 });
    expect(item.editReply).toHaveBeenCalledWith(expect.stringContaining('membership is confirmed'));
  });
  it('rejects commands from other servers without querying membership', async () => {
    const check = vi.fn();
    const item = interaction({ guildId: 'another-server' });
    await verificationHandler(config, check)(item as unknown as Interaction);
    expect(check).not.toHaveBeenCalled();
    expect(item.editReply).toHaveBeenCalledWith(expect.stringContaining('available in the Team Razka server'));
  });
  it('does not confirm access when the required role is missing', async () => {
    const item = interaction();
    await verificationHandler({ ...config, requiredRoleId: 'required' }, async () => ({ roles: ['other'] }))(item as unknown as Interaction);
    expect(item.editReply).toHaveBeenCalledWith(expect.stringContaining('do not have the required'));
  });
  it('does not confirm access if Discord membership lookup fails', async () => {
    const item = interaction();
    await verificationHandler(config, async () => { throw new Error('private provider error'); })(item as unknown as Interaction);
    expect(item.editReply).toHaveBeenCalledWith('Membership could not be checked right now. Please try again shortly.');
    expect(JSON.stringify(item.editReply.mock.calls)).not.toContain('private provider error');
  });
  it('contains acknowledgement timeouts without an unhandled rejection', async () => {
    const item = interaction({ deferReply: vi.fn(async () => { throw new Error('expired'); }) });
    const check = vi.fn();
    await expect(verificationHandler(config, check)(item as unknown as Interaction)).resolves.toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });
  it('does not handle unrelated commands', async () => {
    const item = interaction({ commandName: 'other' });
    const check = vi.fn();
    await verificationHandler(config, check)(item as unknown as Interaction);
    expect(item.deferReply).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });
});
