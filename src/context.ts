/**
 * CLI context management
 */

import { Config } from './core/config.js';
import { APIClient } from './core/api-client.js';
import { FileUploader } from './core/file-uploader.js';
import { runLoginFlow } from './core/auth.js';
import { outputError, ExitCode } from './utils/errors.js';

/**
 * Global context for CLI commands
 */
export class Context {
  public config: Config;
  public jsonOutput: boolean;
  private _apiClient?: APIClient;
  private _uploader?: FileUploader;
  private _loginPromise?: Promise<string>;

  constructor() {
    this.config = new Config();
    this.jsonOutput = false;
  }

  /**
   * Initialize context by loading config
   */
  async init(): Promise<void> {
    await this.config.load();
  }

  /**
   * Get or create API client
   */
  getClient(): APIClient {
    if (!this.config.isConfigured()) {
      this.error(
        'Not configured. Please set token and space ID:\n' +
          '  deckflow config set-token <token>\n' +
          '  deckflow config set-space <space-id>',
        'NOT_CONFIGURED',
        ExitCode.USAGE_ERROR
      );
    }

    if (!this._apiClient) {
      this._apiClient = new APIClient(this.config.apiBase, this.config.token!, {
        onUnauthorized: async () => {
          return await this.ensureLoggedIn();
        },
      });
    }

    return this._apiClient;
  }

  /**
   * Get or create file uploader
   */
  getUploader(): FileUploader {
    const client = this.getClient();

    if (!this._uploader) {
      this._uploader = new FileUploader(client);
    }

    return this._uploader;
  }

  /**
   * Ensure user is logged in (interactive browser flow).
   * Used by `login` command and auto-triggered on 401.
   */
  async ensureLoggedIn(
    port: number = 3737,
    reason: 'explicit' | 'unauthorized' = 'unauthorized'
  ): Promise<string> {
    if (this._loginPromise) {
      return await this._loginPromise;
    }

    this._loginPromise = (async () => {
      const { token, spaceId } = await runLoginFlow({
        apiBase: this.config.apiBase,
        port,
        jsonOutput: this.jsonOutput,
        reason,
      });

      await this.config.setToken(token);
      if (spaceId) {
        await this.config.setSpaceId(spaceId);
      }

      // Reset clients so they pick up the new token
      this._apiClient = undefined;
      this._uploader = undefined;

      return token;
    })();

    try {
      return await this._loginPromise;
    } finally {
      this._loginPromise = undefined;
    }
  }

  /**
   * Output data in JSON or human-readable format
   */
  output(data: any, humanFormat?: (data: any) => string): void {
    if (this.jsonOutput) {
      console.log(JSON.stringify(data, null, 2));
    } else if (humanFormat) {
      console.log(humanFormat(data));
    } else {
      console.log(data);
    }
  }

  /**
   * Output error and exit
   */
  error(message: string, code: string = 'ERROR', exitCode: number = ExitCode.ERROR): never {
    if (this.jsonOutput) {
      console.error(
        JSON.stringify({
          error: message,
          code,
        })
      );
    } else {
      outputError(new Error(message), false);
    }

    process.exit(exitCode);
  }
}
