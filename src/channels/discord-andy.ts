/**
 * Discord channel adapter for Andy (Kyle's personal assistant).
 * Reads DISCORD_BOT_TOKEN_ANDY / DISCORD_PUBLIC_KEY_ANDY / DISCORD_APPLICATION_ID_ANDY
 * and registers channel_type 'discord-andy'.
 *
 * Pattern: one Discord bot per persona. Each persona has its own Discord app in the
 * developer portal, its own suffixed env vars, its own channel adapter file, and its
 * own messaging_groups with channel_type='discord-<persona>'. See /create-bot skill.
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

registerChannelAdapter('discord-andy', {
  factory: () => {
    const env = readEnvFile(['DISCORD_BOT_TOKEN_ANDY', 'DISCORD_PUBLIC_KEY_ANDY', 'DISCORD_APPLICATION_ID_ANDY']);
    if (!env.DISCORD_BOT_TOKEN_ANDY) return null;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN_ANDY,
      publicKey: env.DISCORD_PUBLIC_KEY_ANDY,
      applicationId: env.DISCORD_APPLICATION_ID_ANDY,
    });
    return createChatSdkBridge({
      adapter: discordAdapter,
      channelType: 'discord-andy',
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN_ANDY,
      extractReplyContext,
      supportsThreads: false, // inline replies in server channels (v1-style)
      maxTextLength: 2000, // Discord hard limit — chunk longer replies
    });
  },
});
