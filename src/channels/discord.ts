import path from 'path';

import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  MessageReaction,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { downloadImage, processImage } from '../image.js';
import { downloadPdf } from '../pdf.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// Silent-gateway-death detection. discord.js will NOT fire a disconnect event
// when the WebSocket zombies out (connection alive at TCP level, no packets
// flowing, isReady() stays true forever). We defend by watching
// shard.lastPingTimestamp — discord.js updates this on every heartbeat ACK
// (~every 41s), so a gap longer than a few heartbeats means the socket is
// zombied even if isReady() still claims true.
const HEARTBEAT_STALENESS_THRESHOLD_MS = 3 * 60 * 1000; // 3 min ≈ 4+ missed heartbeats
const HEALTH_TICK_INTERVAL_MS = 60 * 1000; // log + check once per minute

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  // The bot identity label this instance serves. `null` is the default
  // identity (DISCORD_BOT_TOKEN) which handles any `dc:*` JID not claimed
  // by a named identity. A non-null value (e.g. "milton") narrows ownership
  // to JIDs whose registered group declares the same `botTokenRef`.
  private tokenRef: string | null;
  // For the default instance only: JIDs belonging to named instances. Used
  // to subtract them from wildcard ownership so each Discord channel is
  // routed to exactly one DiscordChannel.
  private excludedJids: Set<string>;

  // Silent-death detection state. `messagesSinceTick` is observability-only
  // (so Kyle can see whether user traffic is reaching the bot); the real
  // liveness signal is the shard heartbeat timestamp, queried on each tick.
  private messagesSinceTick = 0;
  private healthTickTimer: NodeJS.Timeout | null = null;
  private reconnecting = false;
  private connectedAt = 0;
  // Tracks pending 👀 reactions by message ID so removeAcknowledgement can
  // remove them directly without relying on the reaction cache.
  private pendingReactions = new Map<string, MessageReaction>();

  constructor(
    botToken: string,
    opts: DiscordChannelOpts,
    tokenRef: string | null = null,
    excludedJids: Set<string> = new Set(),
  ) {
    this.botToken = botToken;
    this.opts = opts;
    this.tokenRef = tokenRef;
    this.excludedJids = excludedJids;
  }

  // Returns ms since last heartbeat ACK, pulled from discord.js' shard state.
  // Returns Infinity if no shard is present, or 0 if a shard exists but the
  // first heartbeat hasn't landed yet (grace period during startup).
  private getHeartbeatStalenessMs(): number {
    if (!this.client) return Infinity;
    const shard = this.client.ws.shards.first();
    if (!shard) return Infinity;
    // discord.js sets lastPingTimestamp on heartbeat ACK. Field is public
    // on the WebSocketShard; typed as any to avoid depending on internal
    // shape that may shift between minor versions.
    const lastPingAt: number | undefined = (
      shard as unknown as {
        lastPingTimestamp?: number;
      }
    ).lastPingTimestamp;
    if (!lastPingAt || lastPingAt === 0) {
      // No heartbeat ACK yet. Grace period = HEALTH_TICK_INTERVAL_MS since
      // connect so a fresh bot doesn't immediately look stale.
      const sinceConnect = Date.now() - this.connectedAt;
      return sinceConnect < 2 * HEALTH_TICK_INTERVAL_MS ? 0 : sinceConnect;
    }
    return Date.now() - lastPingAt;
  }

  private startHealthTick(): void {
    if (this.healthTickTimer) return;
    this.healthTickTimer = setInterval(() => {
      const stalenessMs = this.getHeartbeatStalenessMs();
      const heartbeatAgeSec =
        stalenessMs === Infinity ? -1 : Math.round(stalenessMs / 1000);
      const messages = this.messagesSinceTick;
      this.messagesSinceTick = 0;
      const isReady = this.client?.isReady() ?? false;
      const wsPing = this.client?.ws?.ping ?? null;

      logger.info(
        {
          isReady,
          heartbeatAgeSec,
          messagesLast60s: messages,
          wsPingMs: wsPing,
          reconnecting: this.reconnecting,
        },
        'Discord health tick',
      );

      if (!isReady || this.reconnecting) return;

      if (stalenessMs > HEARTBEAT_STALENESS_THRESHOLD_MS) {
        logger.warn(
          { heartbeatAgeSec },
          'Discord heartbeat silent beyond threshold — forcing reconnect',
        );
        // Fire and forget — reconnect() awaits internally
        this.reconnect(`no heartbeat for ${heartbeatAgeSec}s`).catch((err) => {
          logger.error({ err }, 'Discord reconnect threw');
        });
      }
    }, HEALTH_TICK_INTERVAL_MS);
  }

  private stopHealthTick(): void {
    if (this.healthTickTimer) {
      clearInterval(this.healthTickTimer);
      this.healthTickTimer = null;
    }
  }

  private async reconnect(reason: string): Promise<void> {
    if (this.reconnecting) {
      logger.info(
        { reason },
        'Discord reconnect already in progress, skipping',
      );
      return;
    }
    this.reconnecting = true;
    logger.warn({ reason }, 'Discord reconnecting...');

    // Destroy the dead client before starting fresh attempts
    const disposeClient = (): void => {
      const oldClient = this.client;
      this.client = null;
      if (oldClient) {
        try {
          oldClient.destroy();
        } catch {
          // Ignore errors during destroy
        }
      }
    };
    disposeClient();

    // Retry with exponential backoff. Laptop-wake scenarios commonly have
    // transient DNS/network failures as WiFi re-associates; giving up on
    // the first failed attempt (previous behavior) leaves the process
    // unable to recover. We keep trying for up to ~10 minutes total.
    const backoffMs = [
      2000, 5000, 10000, 20000, 30000, 60000, 60000, 120000, 120000, 120000,
    ];
    try {
      for (let attempt = 0; attempt < backoffMs.length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
        try {
          await this.connect();
          logger.info(
            { attempts: attempt + 1 },
            'Discord reconnected successfully',
          );
          return;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const nextDelaySec =
            attempt + 1 < backoffMs.length
              ? Math.round(backoffMs[attempt + 1] / 1000)
              : null;
          logger.warn(
            { attempt: attempt + 1, err: errMsg, nextDelaySec },
            'Discord reconnect attempt failed — will retry',
          );
          // Clean up the half-built client before the next iteration
          disposeClient();
        }
      }
      logger.error(
        { totalAttempts: backoffMs.length },
        'Discord reconnect exhausted retries — health tick will re-trigger',
      );
    } finally {
      this.reconnecting = false;
    }
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Observability counter — any inbound human message proves the
      // gateway is delivering MESSAGE_CREATE dispatches to us. The real
      // liveness check still runs on heartbeat freshness.
      this.messagesSinceTick++;
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Resolve the registered group up front so image attachments can be
      // downloaded and processed into the group's local attachments folder.
      // Non-registered groups still get text placeholders for chat-metadata
      // discovery, but we don't waste a network round trip downloading their
      // media.
      // Also: when several bot identities are in the same channel (Andy +
      // Milton both invited to #milton), only the instance whose tokenRef
      // matches the group's botTokenRef should treat the group as registered.
      // The "other" bots see the channel as unregistered, which means no
      // attachment downloads, no message delivery — only chat-metadata
      // discovery (which is idempotent on (jid)).
      const groupRecord = this.opts.registeredGroups()[chatJid];
      const groupRef = groupRecord?.botTokenRef ?? null;
      const registeredGroup =
        groupRecord && groupRef === this.tokenRef ? groupRecord : undefined;

      // Handle attachments — images for registered groups go through
      // processImage() (download + sharp resize + write to attachments/)
      // and become `[Image: attachments/...]` placeholders that the agent
      // runner reads back as multimodal content blocks. Everything else
      // becomes a plain text placeholder so the agent at least knows
      // something was sent.
      if (message.attachments.size > 0) {
        const attachmentDescriptions: string[] = [];
        for (const att of message.attachments.values()) {
          const contentType = att.contentType || '';
          if (contentType.startsWith('image/') && registeredGroup) {
            let placeholder = `[Image: ${att.name || 'image'}]`;
            const buffer = await downloadImage(att.url);
            if (!buffer) {
              logger.warn(
                { chatJid, attachment: att.name },
                'Image - download failed',
              );
            } else {
              try {
                const groupDir = path.join(GROUPS_DIR, registeredGroup.folder);
                const processed = await processImage(buffer, groupDir);
                if (processed) {
                  placeholder = `[Image: ${processed.relativePath}]`;
                  logger.info(
                    {
                      chatJid,
                      attachment: att.name,
                      relativePath: processed.relativePath,
                    },
                    'Processed image attachment',
                  );
                } else {
                  logger.warn(
                    { chatJid, attachment: att.name },
                    'Image - processing failed',
                  );
                }
              } catch (err) {
                logger.warn(
                  { err, chatJid, attachment: att.name },
                  'Image - processing failed',
                );
              }
            }
            attachmentDescriptions.push(placeholder);
          } else if (contentType.startsWith('image/')) {
            attachmentDescriptions.push(`[Image: ${att.name || 'image'}]`);
          } else if (contentType === 'application/pdf' && registeredGroup) {
            let placeholder = `[PDF: ${att.name || 'document.pdf'}]`;
            try {
              const groupDir = path.join(GROUPS_DIR, registeredGroup.folder);
              const processed = await downloadPdf(att.url, groupDir, att.name);
              if (processed) {
                placeholder = `[PDF: ${processed.relativePath}]`;
                logger.info(
                  {
                    chatJid,
                    attachment: att.name,
                    relativePath: processed.relativePath,
                  },
                  'Downloaded PDF attachment',
                );
              } else {
                logger.warn(
                  { chatJid, attachment: att.name },
                  'Failed to download PDF attachment',
                );
              }
            } catch (err) {
              logger.warn(
                { err, chatJid, attachment: att.name },
                'Failed to download PDF attachment',
              );
            }
            attachmentDescriptions.push(placeholder);
          } else if (contentType.startsWith('video/')) {
            attachmentDescriptions.push(`[Video: ${att.name || 'video'}]`);
          } else if (contentType.startsWith('audio/')) {
            attachmentDescriptions.push(`[Audio: ${att.name || 'audio'}]`);
          } else {
            attachmentDescriptions.push(`[File: ${att.name || 'file'}]`);
          }
        }
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups (lookup hoisted above)
      if (!registeredGroup) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    // Shard lifecycle events — discord.js handles most reconnects automatically,
    // but we hook these to log visibility and handle non-resumable close codes.
    this.client.on(Events.ShardReconnecting, (shardId) => {
      logger.info({ shardId }, 'Discord shard reconnecting...');
    });

    this.client.on(Events.ShardResume, (shardId, replayedEvents) => {
      logger.info({ shardId, replayedEvents }, 'Discord shard resumed');
    });

    this.client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
      logger.warn(
        { shardId, code: closeEvent.code },
        'Discord shard disconnected',
      );
      // Close codes that discord.js will NOT automatically recover from
      const nonResumableCodes = [4004, 4010, 4011, 4012, 4013, 4014];
      if (nonResumableCodes.includes(closeEvent.code)) {
        logger.error(
          { code: closeEvent.code },
          'Discord non-resumable disconnect — triggering reconnect',
        );
        this.reconnect(`close code ${closeEvent.code}`);
      }
    });

    // Session invalidated — discord.js will not auto-reconnect, must re-login
    this.client.on(Events.Invalidated, () => {
      logger.error('Discord session invalidated — triggering reconnect');
      this.reconnect('session invalidated');
    });

    return new Promise<void>((resolve, reject) => {
      // Guard against login hanging forever — if we never reach ClientReady
      // within the timeout, reject so the caller can retry instead of
      // deadlocking the entire process. This is what bit us today: a post-
      // sleep DNS failure made login() never resolve or reject on its own.
      const LOGIN_TIMEOUT_MS = 60_000;
      let settled = false;

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(`Discord login timed out after ${LOGIN_TIMEOUT_MS}ms`),
        );
      }, LOGIN_TIMEOUT_MS);

      this.client!.once(Events.ClientReady, (readyClient) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);

        // Record connect time so the health tick grace period is accurate
        // (shard.lastPingTimestamp is 0 until the first heartbeat ACK lands
        // ~41s into the session).
        this.connectedAt = Date.now();
        this.startHealthTick();

        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken).catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(err);
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    if (this.client === null || !this.client.isReady()) return false;
    // isReady() stays true during silent WebSocket death — don't trust it
    // alone. Require recent shard heartbeat activity too.
    return this.getHeartbeatStalenessMs() < HEARTBEAT_STALENESS_THRESHOLD_MS;
  }

  ownsJid(jid: string): boolean {
    if (!jid.startsWith('dc:')) return false;
    if (this.tokenRef === null) {
      // Default instance: claim everything not assigned to a named instance.
      return !this.excludedJids.has(jid);
    }
    // Named instance: claim only groups whose botTokenRef matches mine.
    const group = this.opts.registeredGroups()[jid];
    return group?.botTokenRef === this.tokenRef;
  }

  async disconnect(): Promise<void> {
    this.stopHealthTick();
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }

  async acknowledgeMessage(jid: string, msgId: string): Promise<void> {
    if (!this.client) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const msg = await (channel as TextChannel).messages.fetch(msgId);
      const reaction = await msg.react('👀');
      this.pendingReactions.set(msgId, reaction);
    } catch (err) {
      logger.debug(
        { jid, msgId, err },
        'Failed to add acknowledgement reaction',
      );
    }
  }

  async removeAcknowledgement(jid: string, msgId: string): Promise<void> {
    if (!this.client?.user) return;
    try {
      const reaction = this.pendingReactions.get(msgId);
      if (reaction) {
        await reaction.users.remove(this.client.user.id);
        this.pendingReactions.delete(msgId);
      }
    } catch (err) {
      logger.debug(
        { jid, msgId, err },
        'Failed to remove acknowledgement reaction',
      );
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  // Collect every bot token label referenced by registered groups, plus the
  // unnamed default. For each label we read DISCORD_BOT_TOKEN_<LABEL> from
  // env (uppercased), and for the default we read DISCORD_BOT_TOKEN.
  const groups = opts.registeredGroups();
  const namedRefs = new Set<string>();
  const namedJidsByRef: Record<string, Set<string>> = {};
  for (const [jid, group] of Object.entries(groups)) {
    if (!jid.startsWith('dc:')) continue;
    if (!group.botTokenRef) continue;
    namedRefs.add(group.botTokenRef);
    if (!namedJidsByRef[group.botTokenRef]) {
      namedJidsByRef[group.botTokenRef] = new Set();
    }
    namedJidsByRef[group.botTokenRef].add(jid);
  }

  const wantedKeys = ['DISCORD_BOT_TOKEN'];
  for (const ref of namedRefs) {
    wantedKeys.push(`DISCORD_BOT_TOKEN_${ref.toUpperCase()}`);
  }
  const envVars = readEnvFile(wantedKeys);
  const readToken = (key: string): string =>
    process.env[key] || envVars[key] || '';

  const channels: Channel[] = [];
  const allNamedJids = new Set<string>();
  for (const ref of namedRefs) {
    const key = `DISCORD_BOT_TOKEN_${ref.toUpperCase()}`;
    const token = readToken(key);
    if (!token) {
      logger.warn(
        { ref, envVar: key },
        'Discord: bot token for ref not set — group(s) using this ref will be unreachable',
      );
      continue;
    }
    for (const jid of namedJidsByRef[ref]) allNamedJids.add(jid);
    channels.push(new DiscordChannel(token, opts, ref));
  }

  // Default bot. Required for chat-metadata discovery (the /chatid flow on
  // first install) and for any group without an explicit botTokenRef.
  const defaultToken = readToken('DISCORD_BOT_TOKEN');
  if (defaultToken) {
    channels.push(new DiscordChannel(defaultToken, opts, null, allNamedJids));
  } else if (channels.length === 0) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  } else {
    logger.warn(
      'Discord: DISCORD_BOT_TOKEN not set — only named-identity bots will run; channel-id discovery for new groups is unavailable until the default token is configured',
    );
  }

  return channels;
});
