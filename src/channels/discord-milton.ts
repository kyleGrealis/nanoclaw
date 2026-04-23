/**
 * Discord channel adapter for Milton (Alexa's paralegal assistant).
 * Reads DISCORD_BOT_TOKEN_MILTON / DISCORD_PUBLIC_KEY_MILTON / DISCORD_APPLICATION_ID_MILTON
 * and registers channel_type 'discord-milton'.
 *
 * Follows the one-bot-one-adapter pattern. See src/channels/discord-andy.ts and
 * the /create-bot skill for the template.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

registerChannelAdapter('discord-milton', {
  factory: () => {
    const env = readEnvFile([
      'DISCORD_BOT_TOKEN_MILTON',
      'DISCORD_PUBLIC_KEY_MILTON',
      'DISCORD_APPLICATION_ID_MILTON',
    ]);
    if (!env.DISCORD_BOT_TOKEN_MILTON) return null;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN_MILTON,
      publicKey: env.DISCORD_PUBLIC_KEY_MILTON,
      applicationId: env.DISCORD_APPLICATION_ID_MILTON,
    });
    return createChatSdkBridge({
      adapter: discordAdapter,
      channelType: 'discord-milton',
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN_MILTON,
      extractReplyContext,
      supportsThreads: false, // inline replies in server channels (v1-style)
    });
  },
});
