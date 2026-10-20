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
import { matrix } from '../../ops/plan.js';

/** Probe runs locally on whatever DeckProbe recognizes; these are the document families it targets. */
const PROBE_INPUTS = ['pdf', 'pptx', 'docx', 'xlsx', 'key', 'ppt', 'doc', 'pages', 'numbers'];

/** `deckops formats` — verb × target × input, read from the route table rather than written by hand. */
export function runFormats(options: { json?: boolean }): void {
  const rows = [
    { verb: 'probe', to: 'report', from: PROBE_INPUTS, runs: 'local' },
    ...matrix().map((row) => ({ verb: row.verb, to: row.to, from: row.from as string[], runs: 'cloud' })),
  ];
  if (options.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  for (const row of rows) {
    const inputs = row.from.map((family) => (family === 'url' ? 'URL' : `.${family}`)).join(' ');
    process.stdout.write(`${row.verb.padEnd(8)} ${row.to.padEnd(9)} ${row.runs.padEnd(6)} ${chalk.dim(inputs)}\n`);
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

const CONFIG_KEYS = new Set(['api-key', 'token', 'space-id', 'api-base', 'timeout']);

export async function runConfigSet(key: string, value: string): Promise<void> {
  if (!CONFIG_KEYS.has(key)) {
    throw DeckOpsError.usage(`Unknown config key "${key}". Known: ${[...CONFIG_KEYS].join(', ')}.`);
  }
  if (key === 'timeout') {
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
