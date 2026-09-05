import chalk from 'chalk';
import { runLoginFlow } from '../../auth/login.js';
import {
  displayPath,
  credentialsPath,
  configPath,
  hasCredentials,
  maskSecret,
  resolveCredentials,
  writeSharedCredentials,
} from '../../config/index.js';
import { DeckOpsError } from '../../errors/index.js';
import { readProductConfig, writeProductOption } from '../../config/product.js';

/** `deckops formats` — the support matrix, honest about what fails. */
export function runFormats(options: { json?: boolean }): void {
  const rows = [
    { input: '.pdf', parse: '✅ local', markdown: '✅ local', notes: 'no OCR; --page-furniture --overlaid-text' },
    { input: '.pptx', parse: '✅ local', markdown: '✅ local', notes: 'Chart/SmartArt may degrade; --split-pages' },
    { input: '.docx', parse: '✅ local', markdown: '✅ local', notes: '--tracked-changes final|original|all' },
    { input: '.key', parse: '☁ cloud', markdown: '☁ cloud', notes: 'local IWA parsing unsupported' },
    { input: 'http(s) URL', parse: '✅ source / ☁ runtime', markdown: '✅', notes: '--mode source|runtime' },
    { input: '.doc .ppt .xls(x) .pages .numbers', parse: '❌ unsupported', markdown: '❌', notes: 'clear error + hint' },
  ];
  if (options.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  for (const row of rows) {
    process.stdout.write(
      `${row.input.padEnd(36)} parse ${row.parse.padEnd(18)} markdown ${row.markdown.padEnd(4)} ${chalk.dim(row.notes)}\n`
    );
  }
}

export async function runAuthLogin(options: { apiBase?: string }): Promise<void> {
  const credentials = await resolveCredentials(options.apiBase ? { apiBase: options.apiBase } : {});
  const result = await runLoginFlow({
    apiBase: credentials.apiBase,
    onUrl: (url) => process.stderr.write(`Open this URL to log in:\n  ${url}\n`),
  });
  const file = await writeSharedCredentials({
    token: result.token,
    ...(result.spaceId ? { spaceId: result.spaceId } : {}),
  });
  process.stdout.write(`Logged in. Credentials saved to ${displayPath(file)} (shared across DeckFlow CLIs).\n`);
}

export async function runAuthStatus(options: { apiBase?: string; json?: boolean }): Promise<void> {
  const credentials = await resolveCredentials(options.apiBase ? { apiBase: options.apiBase } : {});
  if (!hasCredentials(credentials)) {
    process.stdout.write('Not logged in — running as guest.\n');
    return;
  }
  const user = await whoami(credentials.apiBase, credentials.token, credentials.apiKey);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...user, apiBase: credentials.apiBase }, null, 2)}\n`);
    return;
  }
  if (!user) {
    throw DeckOpsError.auth('Stored credential was rejected by the backend.', {
      hint: 'Run `deckops auth login`, or check `deckops config list` for where it came from.',
    });
  }
  process.stdout.write(`Logged in as ${user.name ?? user.id} ${chalk.dim(`(${credentials.apiBase})`)}\n`);
}

export async function runAuthLogout(): Promise<void> {
  const file = await writeSharedCredentials({ token: null, spaceId: null });
  process.stdout.write(`Token removed from ${displayPath(file)}.\n`);
}

export async function runConfigList(options: { json?: boolean }): Promise<void> {
  const credentials = await resolveCredentials();
  const entry = (value: string | undefined, source: string | undefined, secret = false) => ({
    value: value ? (secret ? maskSecret(value) : value) : '(unset)',
    source: source ?? '—',
  });
  const data = {
    defaults: readProductConfig(),
    credentials: {
      'api-key': entry(credentials.apiKey, credentials.sources.apiKey, true),
      'token': entry(credentials.token, credentials.sources.token, true),
      'space-id': entry(credentials.spaceId, credentials.sources.spaceId),
      'api-base': entry(credentials.apiBase, credentials.sources.apiBase),
    },
    files: {
      'shared credentials': displayPath(credentialsPath()),
      'deckops defaults': displayPath(configPath()),
    },
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  process.stdout.write('Credentials\n');
  for (const [key, { value, source }] of Object.entries(data.credentials)) {
    process.stdout.write(`  ${key.padEnd(10)} ${value.padEnd(28)} ${chalk.dim(`(${source})`)}\n`);
  }
  process.stdout.write('\nFiles\n');
  for (const [label, file] of Object.entries(data.files)) {
    process.stdout.write(`  ${label.padEnd(22)} ${file}\n`);
  }
  process.stdout.write(`\nProduct defaults\n  ${JSON.stringify(data.defaults)}\n`);
}

const CONFIG_KEYS = new Set(['api-key', 'token', 'space-id', 'api-base', 'engine', 'allow-upload', 'fail-on-degraded', 'timeout', 'preflight']);

export async function runConfigSet(key: string, value: string): Promise<void> {
  if (!CONFIG_KEYS.has(key)) {
    throw DeckOpsError.usage(`Unknown config key "${key}". Known: ${[...CONFIG_KEYS].join(', ')}.`);
  }
  if (['engine', 'allow-upload', 'fail-on-degraded', 'timeout', 'preflight'].includes(key)) {
    const file = writeProductOption(key, value);
    process.stdout.write(`${key} saved to ${displayPath(file)}.\n`);
    return;
  }
  const field = key === 'api-key' ? 'apiKey' : key === 'space-id' ? 'spaceId' : key === 'api-base' ? 'apiBase' : 'token';
  const file = await writeSharedCredentials({ [field]: value });
  process.stdout.write(`${key} saved to ${displayPath(file)}.\n`);
}

async function whoami(
  apiBase: string,
  token: string | undefined,
  apiKey: string | undefined
): Promise<{ id: string; name?: string } | undefined> {
  try {
    const response = await fetch(`${apiBase.replace(/\/$/, '')}/user`, {
      headers: {
        ...(token ? { 'X-Auth-Token': token } : {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as { id: string; name?: string };
  } catch {
    return undefined;
  }
}
