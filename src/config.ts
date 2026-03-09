import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { Persona } from './types.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'PERSONAS',
  'MODEL_NAME',
  'TRIGGER_ANYWHERE',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.resolve(
  PROJECT_ROOT,
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Persona system ---
// Format: PERSONAS=Andy:compass-max,Mark:QwQ-32B,Code:codecompass
const defaultModel = process.env.MODEL_NAME || envConfig.MODEL_NAME || 'gpt-4o';

function parsePersonas(raw: string | undefined): Persona[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const colonIdx = entry.indexOf(':');
      if (colonIdx === -1) return null;
      const name = entry.slice(0, colonIdx).trim();
      const model = entry.slice(colonIdx + 1).trim();
      if (!name || !model) return null;
      return {
        name,
        trigger: new RegExp(`^@${escapeRegex(name)}\\b`, 'i'),
        model,
      };
    })
    .filter((p): p is Persona => p !== null);
}

const personasRaw = process.env.PERSONAS || envConfig.PERSONAS;
export const PERSONAS: Persona[] = parsePersonas(personasRaw);

// Default persona used for self-chat / no-trigger-required groups
export const DEFAULT_PERSONA: Persona =
  PERSONAS.length > 0
    ? PERSONAS[0]
    : {
        name: ASSISTANT_NAME,
        trigger: new RegExp(`^@${escapeRegex(ASSISTANT_NAME)}\\b`, 'i'),
        model: defaultModel,
      };

// Trigger pattern matches ANY persona name (or just ASSISTANT_NAME if no personas configured)
const allNames =
  PERSONAS.length > 0
    ? PERSONAS.map((p) => escapeRegex(p.name))
    : [escapeRegex(ASSISTANT_NAME)];
export const TRIGGER_PATTERN = new RegExp(`^@(${allNames.join('|')})\\b`, 'i');

/** When true, group messages trigger if they contain @Name anywhere (e.g. "十分钟后提醒我@Andy"). */
export const TRIGGER_ANYWHERE =
  (process.env.TRIGGER_ANYWHERE || envConfig.TRIGGER_ANYWHERE) === 'true';

/** Pattern that matches @Name anywhere in the message (used when TRIGGER_ANYWHERE is true). */
const TRIGGER_PATTERN_ANYWHERE = new RegExp(
  `@(${allNames.join('|')})\\b`,
  'gi',
);

/** Returns true if message contains a trigger (at start or anywhere if TRIGGER_ANYWHERE). */
export function messageHasTrigger(text: string): boolean {
  const t = text.trim();
  if (TRIGGER_PATTERN.test(t)) return true;
  if (TRIGGER_ANYWHERE && TRIGGER_PATTERN_ANYWHERE.test(t)) return true;
  return false;
}

/** Given a message, return the matched persona (or null). Prefers match at start, then first @Name anywhere. */
export function getPersonaFromMessage(text: string): Persona | null {
  const t = text.trim();
  const atStart = t.match(TRIGGER_PATTERN);
  if (atStart) {
    const name = atStart[1].toLowerCase();
    return PERSONAS.find((p) => p.name.toLowerCase() === name) || null;
  }
  if (TRIGGER_ANYWHERE) {
    const anywhere = t.match(TRIGGER_PATTERN_ANYWHERE);
    if (anywhere) {
      const name = anywhere[0].slice(1).toLowerCase();
      return PERSONAS.find((p) => p.name.toLowerCase() === name) || null;
    }
  }
  return null;
}

// Timezone for scheduled tasks, cron, and log timestamps. Default: Beijing.
export const TIMEZONE = process.env.TZ || 'Asia/Shanghai';
