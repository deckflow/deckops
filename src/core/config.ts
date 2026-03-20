/**
 * Configuration management for deckflow CLI
 * Manages CLI configuration stored in ~/.deckflow/config.json
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ConfigSchema, type ConfigData } from '../types/config.js';

export class Config {
  private static readonly DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.deckflow');
  private static readonly CONFIG_FILE = 'config.json';

  private readonly configDir: string;
  private readonly configPath: string;
  private data: ConfigData;

  /**
   * Initialize config manager
   * @param configDir - Custom config directory (defaults to ~/.tools-ui)
   */
  constructor(configDir?: string) {
    this.configDir = configDir || Config.DEFAULT_CONFIG_DIR;
    this.configPath = path.join(this.configDir, Config.CONFIG_FILE);
    this.data = {};
  }

  /**
   * Load configuration from disk
   */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      this.data = ConfigSchema.parse(parsed);
    } catch (error) {
      // If file doesn't exist or is invalid, start with empty config
      this.data = ConfigSchema.parse({});
    }
  }

  /**
   * Save configuration to disk
   */
  async save(): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
    const validated = ConfigSchema.parse(this.data);
    await fs.writeFile(this.configPath, JSON.stringify(validated, null, 2), 'utf-8');
  }

  /**
   * Get configuration value
   */
  get<K extends keyof ConfigData>(key: K, defaultValue?: ConfigData[K]): ConfigData[K] | undefined {
    return this.data[key] ?? defaultValue;
  }

  /**
   * Set configuration value and save
   */
  async set<K extends keyof ConfigData>(key: K, value: ConfigData[K]): Promise<void> {
    this.data[key] = value;
    await this.save();
  }

  /**
   * Delete configuration key
   */
  async delete<K extends keyof ConfigData>(key: K): Promise<void> {
    delete this.data[key];
    await this.save();
  }

  /**
   * Get all configuration
   */
  all(): ConfigData {
    return { ...this.data };
  }

  // Convenience getters and setters for common config keys

  /**
   * Get authentication token
   */
  get token(): string | undefined {
    return this.data.token;
  }

  /**
   * Set authentication token
   * Note: You must call save() manually after setting properties
   */
  set token(value: string | undefined) {
    this.data.token = value;
  }

  /**
   * Get space ID (defaults to 'UMYSELF')
   */
  get spaceId(): string {
    return this.data.spaceId;
  }

  /**
   * Set space ID
   * Note: You must call save() manually after setting properties
   */
  set spaceId(value: string) {
    this.data.spaceId = value;
  }

  /**
   * Get API base URL
   */
  get apiBase(): string {
    return this.data.apiBase || 'https://app.deckflow.com/v1';
  }

  /**
   * Set API base URL
   * Note: You must call save() manually after setting properties
   */
  set apiBase(value: string) {
    this.data.apiBase = value;
  }

  /**
   * Get sign-in URI
   */
  get signURI(): string | undefined {
    return this.data.signURI;
  }

  /**
   * Set sign-in URI
   * Note: You must call save() manually after setting properties
   */
  set signURI(value: string | undefined) {
    this.data.signURI = value;
  }

  /**
   * Convenience method to set token and save
   */
  async setToken(value: string): Promise<void> {
    this.data.token = value;
    await this.save();
  }

  /**
   * Convenience method to set space ID and save
   */
  async setSpaceId(value: string): Promise<void> {
    this.data.spaceId = value;
    await this.save();
  }

  /**
   * Convenience method to set API base and save
   */
  async setApiBase(value: string): Promise<void> {
    this.data.apiBase = value;
    await this.save();
  }

  /**
   * Convenience method to set sign-in URI and save
   */
  async setSignURI(value: string): Promise<void> {
    this.data.signURI = value;
    await this.save();
  }

  /**
   * Check if minimum configuration is present
   */
  isConfigured(): boolean {
    return Boolean(this.token);
  }
}
