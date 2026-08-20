/**
 * Configuration management for deckflow CLI.
 * Shared with deckhtml and other Deckflow tools at ~/.deckflow/credentials
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { CONFIG_KEYS, ConfigSchema, type ConfigData } from '../types/config.js';

const DEFAULT_API_BASE = 'https://app.deckflow.com/v1';

function resolveConfigDir(explicit?: string): string {
  return (
    explicit ||
    process.env.DECKFLOW_CONFIG_DIR ||
    process.env.DECKHTML_CONFIG_DIR ||
    process.env.DECKOPS_CONFIG_DIR ||
    path.join(os.homedir(), '.deckflow')
  );
}

function sanitizeConfig(raw: Record<string, unknown>): ConfigData {
  const data: ConfigData = {};
  for (const key of CONFIG_KEYS) {
    const value = raw[key];
    if (value !== undefined) {
      (data as Record<string, unknown>)[key] = value;
    }
  }
  const parsed = ConfigSchema.safeParse(data);
  return parsed.success ? parsed.data : {};
}

export class Config {
  private static readonly CONFIG_FILE = 'credentials';

  private readonly configDir: string;
  private readonly configPath: string;
  private data: ConfigData;

  /**
   * @param configDir - Custom config directory (defaults to ~/.deckflow)
   */
  constructor(configDir?: string) {
    this.configDir = resolveConfigDir(configDir);
    this.configPath = path.join(this.configDir, Config.CONFIG_FILE);
    this.data = {};
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      this.data = sanitizeConfig(parsed);
    } catch {
      this.data = {};
    }
  }

  /**
   * Re-read the shared file before writing so other tools' keys
   * (e.g. deckhtml `webhook` / `retentionHours`) are preserved.
   */
  async save(): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });

    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(this.configPath, 'utf-8');
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // File may not exist yet.
    }

    // Overlay only keys present on this.data so we do not wipe fields
    // owned by other tools when we never loaded them into memory.
    const output: ConfigData = { ...sanitizeConfig(existing) };
    for (const key of CONFIG_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(this.data, key)) {
        continue;
      }
      const value = this.data[key];
      if (value === undefined) {
        delete output[key];
      } else {
        (output as Record<string, unknown>)[key] = value;
      }
    }

    this.data = output;
    await fs.writeFile(this.configPath, `${JSON.stringify(output, null, 2)}\n`, 'utf-8');
  }

  get<K extends keyof ConfigData>(key: K, defaultValue?: ConfigData[K]): ConfigData[K] | undefined {
    return this.data[key] ?? defaultValue;
  }

  async set<K extends keyof ConfigData>(key: K, value: ConfigData[K]): Promise<void> {
    this.data[key] = value;
    await this.save();
  }

  async delete<K extends keyof ConfigData>(key: K): Promise<void> {
    // Keep the own-property so save() can distinguish "unset" from "untouched".
    this.data[key] = undefined;
    await this.save();
  }

  all(): ConfigData {
    return sanitizeConfig(this.data as Record<string, unknown>);
  }

  get token(): string | undefined {
    return this.data.token;
  }

  set token(value: string | undefined) {
    this.data.token = value;
  }

  get apiKey(): string | undefined {
    return this.data.apiKey;
  }

  set apiKey(value: string | undefined) {
    this.data.apiKey = value;
  }

  get spaceId(): string | undefined {
    return this.data.spaceId;
  }

  set spaceId(value: string) {
    this.data.spaceId = value;
  }

  get apiBase(): string {
    return this.data.apiBase || DEFAULT_API_BASE;
  }

  set apiBase(value: string) {
    this.data.apiBase = value;
  }

  get webhook(): string | undefined {
    return this.data.webhook;
  }

  get retentionHours(): number | undefined {
    return this.data.retentionHours;
  }

  async setToken(value: string): Promise<void> {
    this.data.token = value;
    await this.save();
  }

  async setApiKey(value: string): Promise<void> {
    this.data.apiKey = value;
    await this.save();
  }

  async setSpaceId(value: string): Promise<void> {
    this.data.spaceId = value;
    await this.save();
  }

  async setApiBase(value: string): Promise<void> {
    this.data.apiBase = value;
    await this.save();
  }

  isConfigured(): boolean {
    return Boolean(this.data.apiKey || this.data.token);
  }

  get configFilePath(): string {
    return this.configPath;
  }
}
