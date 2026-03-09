import fs from 'fs';
import path from 'path';
import { spawn } from 'node:child_process';

import {
  ASSISTANT_NAME,
  DEFAULT_PERSONA,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  messageHasTrigger,
  getPersonaFromMessage,
} from './config.js';
import { Persona } from './types.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { startApiProxy } from './api-proxy.js';
import { readEnvFile } from './env.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { preprocessImageTags } from './vision-preprocessor.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { isStockDailyRerunCommand } from './commands/stock-daily.js';
import {
  isAssetTrigger,
  isEndTrigger,
  hasActiveSession,
  startSession,
  addImage,
  getSessionImageCount,
  processAssetUpdate,
} from './asset-update-handler.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

const stockDailyRunByChat = new Map<string, { startedAt: number }>();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

const IMAGE_TAG_RE = /\[Image:\s*([^\]]+)\]/;

/**
 * Handle asset-update messages on the host side (no container needed).
 * Returns true if the messages were consumed and should NOT go to a container.
 */
async function handleAssetMessages(
  chatJid: string,
  messages: NewMessage[],
  channel: Channel,
  group: RegisteredGroup,
): Promise<boolean> {
  const groupDir = resolveGroupFolderPath(group.folder);
  const hasAssetTrigger = messages.some((m) => isAssetTrigger(m.content));
  const hasEnd = messages.some((m) => isEndTrigger(m.content));
  const imageMessages = messages.filter((m) => IMAGE_TAG_RE.test(m.content));

  // Start a new session
  if (hasAssetTrigger && !hasActiveSession(chatJid)) {
    startSession(chatJid);
    await channel.sendMessage(
      chatJid,
      '好的，请依次发送券商/基金APP截图，发送完毕后说「结束发送」',
    );

    // If images came in the same batch, add them
    for (const m of imageMessages) {
      const match = m.content.match(IMAGE_TAG_RE);
      if (match) {
        const absPath = path.resolve(groupDir, match[1].trim());
        const rel = path.relative(groupDir, absPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
        addImage(chatJid, absPath);
      }
    }

    // Advance cursor
    lastAgentTimestamp[chatJid] = messages[messages.length - 1].timestamp;
    saveState();

    // If "结束发送" also in same batch
    if (hasEnd) {
      if (getSessionImageCount(chatJid) === 0) {
        logger.info(
          { chatJid },
          'End trigger in start batch but no images, waiting 12s',
        );
        await new Promise((r) => setTimeout(r, 12_000));
      }
      if (getSessionImageCount(chatJid) > 0) {
        await channel.setTyping?.(chatJid, true);
        await channel.sendMessage(chatJid, '正在分析截图并更新飞书...');
        const result = await processAssetUpdate(chatJid);
        await channel.setTyping?.(chatJid, false);
        await channel.sendMessage(chatJid, result);
      }
    }

    return true;
  }

  // Active session: collect images and/or process end
  if (hasActiveSession(chatJid)) {
    for (const m of imageMessages) {
      const match = m.content.match(IMAGE_TAG_RE);
      if (match) {
        const absPath = path.resolve(groupDir, match[1].trim());
        const rel = path.relative(groupDir, absPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
        addImage(chatJid, absPath);
      }
    }

    // Advance cursor
    lastAgentTimestamp[chatJid] = messages[messages.length - 1].timestamp;
    saveState();

    if (hasEnd) {
      // Race-condition guard: if no images yet, wait for upload to finish
      if (getSessionImageCount(chatJid) === 0) {
        logger.info(
          { chatJid },
          'End trigger received but no images yet, waiting 12s for uploads',
        );
        await new Promise((r) => setTimeout(r, 12_000));
      }

      if (getSessionImageCount(chatJid) === 0) {
        await channel.sendMessage(
          chatJid,
          '还没有收到截图，请先发送截图再说「结束发送」',
        );
      } else {
        await channel.setTyping?.(chatJid, true);
        await channel.sendMessage(chatJid, '正在分析截图并更新飞书...');
        const result = await processAssetUpdate(chatJid);
        await channel.setTyping?.(chatJid, false);
        await channel.sendMessage(chatJid, result);
      }
    } else if (imageMessages.length > 0) {
      await channel.sendMessage(
        chatJid,
        `收到 ${imageMessages.length} 张截图，继续发送或说「结束发送」`,
      );
    }

    return true;
  }

  return false;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        messageHasTrigger(m.content) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // ── Asset update interception (host-side, bypasses container) ──────
  if (isMainGroup) {
    const handled = await handleAssetMessages(
      chatJid,
      missedMessages,
      channel,
      group,
    );
    if (handled) return true;
  }

  // Main group admin command: rerun today's stock data push.
  // Keep it strict to avoid accidentally executing host scripts from normal chat.
  if (isMainGroup && missedMessages.length === 1) {
    const m = missedMessages[0];
    if (!m.is_bot_message && isStockDailyRerunCommand(m.content)) {
      const allowlistCfg = loadSenderAllowlist();
      const senderAllowed =
        m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg);
      if (!senderAllowed) {
        logger.warn(
          { chatJid, sender: m.sender },
          'Stock daily rerun command denied by sender allowlist',
        );
        return true;
      }

      const alreadyRunning = stockDailyRunByChat.has(chatJid);
      if (alreadyRunning) {
        await channel.sendMessage(chatJid, '股票数据正在重跑中，请稍后再试。');
        return true;
      }

      // Advance cursor so this command is not retried.
      const previousCursor = lastAgentTimestamp[chatJid] || '';
      lastAgentTimestamp[chatJid] = m.timestamp;
      saveState();

      try {
        await channel.setTyping?.(chatJid, true);
        await channel.sendMessage(
          chatJid,
          '收到，开始重跑今日股票数据。完成后我会回一条结果。',
        );

        const scriptPath = path.resolve(
          process.cwd(),
          'scripts/stock-daily-push.sh',
        );
        stockDailyRunByChat.set(chatJid, { startedAt: Date.now() });

        const proc = spawn('bash', [scriptPath], {
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const tail: string[] = [];
        const pushTail = (chunk: Buffer) => {
          const s = chunk.toString('utf8');
          for (const line of s.split('\n')) {
            if (!line.trim()) continue;
            tail.push(line);
            if (tail.length > 40) tail.shift();
          }
        };
        proc.stdout?.on('data', pushTail);
        proc.stderr?.on('data', pushTail);

        const timeoutMs = 30 * 60 * 1000;
        const timeout = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, timeoutMs);

        proc.on('close', async (code, signal) => {
          clearTimeout(timeout);
          stockDailyRunByChat.delete(chatJid);
          try {
            await channel.setTyping?.(chatJid, false);
            if (code === 0) {
              await channel.sendMessage(
                chatJid,
                '今日股票数据重跑完成，报告已重新生成并推送。若需要排查细节可看 logs/stock-daily.log。',
              );
            } else {
              const excerpt = tail.slice(-20).join('\n');
              await channel.sendMessage(
                chatJid,
                `今日股票数据重跑失败（exit=${code ?? 'null'} signal=${signal ?? 'null'}）。\n` +
                  (excerpt ? `最近输出：\n${excerpt}\n` : '') +
                  '可查看 logs/stock-daily.log 获取完整日志。',
              );
            }
          } catch (err) {
            logger.warn(
              { err, chatJid },
              'Failed to report stock rerun result',
            );
          }
        });

        proc.on('error', async (err) => {
          stockDailyRunByChat.delete(chatJid);
          await channel.setTyping?.(chatJid, false);
          lastAgentTimestamp[chatJid] = previousCursor;
          saveState();
          logger.error({ err, chatJid }, 'Failed to start stock daily rerun');
          await channel.sendMessage(
            chatJid,
            `启动重跑失败：${err.message}\n请查看 logs/stock-daily.log。`,
          );
        });
      } catch (err) {
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        stockDailyRunByChat.delete(chatJid);
        await channel.setTyping?.(chatJid, false);
        logger.error({ err, chatJid }, 'Stock daily rerun command failed');
        await channel.sendMessage(
          chatJid,
          '重跑命令执行失败，请查看 logs/stock-daily.log。',
        );
      }

      return true;
    }
  }

  // Determine which persona was triggered (for multi-model routing)
  let persona: Persona = DEFAULT_PERSONA;
  for (const m of missedMessages) {
    const matched = getPersonaFromMessage(m.content);
    if (matched) {
      persona = matched;
      break;
    }
  }

  let prompt = formatMessages(missedMessages);

  // Pre-analyze images on the host (direct API access, no proxy needed)
  const groupDir = resolveGroupFolderPath(group.folder);
  prompt = await preprocessImageTags(prompt, groupDir);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      persona: persona.name,
      model: persona.model,
    },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    persona,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  persona: Persona,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: persona.name,
        modelOverride: persona.model,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                messageHasTrigger(m.content) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // ── Asset update interception in message loop ─────────────
          if (isMainGroup) {
            const allPendingForAsset = getMessagesSince(
              chatJid,
              lastAgentTimestamp[chatJid] || '',
              ASSISTANT_NAME,
            );
            const msgsForCheck =
              allPendingForAsset.length > 0
                ? allPendingForAsset
                : groupMessages;
            const handled = await handleAssetMessages(
              chatJid,
              msgsForCheck,
              channel,
              group,
            );
            if (handled) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          let formatted = formatMessages(messagesToSend);

          // Pre-analyze images on the host before piping to container
          const ipcGroupDir = resolveGroupFolderPath(group.folder);
          formatted = await preprocessImageTags(formatted, ipcGroupDir);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();

  // Start LLM API proxy on the container bridge so containers can
  // reach the API through the host (bypasses VPN / firewall issues).
  const apiEnv = readEnvFile(['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL']);
  const baseUrl = apiEnv.OPENAI_BASE_URL || apiEnv.ANTHROPIC_BASE_URL;
  if (baseUrl) startApiProxy(new URL(baseUrl).origin);

  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      logger.info(
        {
          chatJid,
          sender: msg.sender_name,
          content: msg.content.slice(0, 200),
          fromMe: msg.is_from_me,
        },
        'Incoming message',
      );
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendImage: async (jid, imagePath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel?.sendImage) {
        logger.warn({ jid }, 'No channel or sendImage for JID, skip image');
        return;
      }
      await channel.sendImage(jid, imagePath, caption);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
