/**
 * CLI context management
 */

import { Config } from './core/config.js';
import { APIClient } from './core/api-client.js';
import { FileUploader } from './core/file-uploader.js';
import { runCheckoutFlow, runLoginFlow } from './core/auth.js';
import { outputError, ExitCode } from './utils/errors.js';
import ora from 'ora';

type SpinnerLike = {
  text: string;
  isSpinning?: boolean;
  start: () => void;
  stop: () => void;
  succeed: (text?: string) => void;
  fail: (text?: string) => void;
};

/**
 * Global context for CLI commands
 */
export class Context {
  public config: Config;
  public jsonOutput: boolean;
  private _apiClient?: APIClient;
  private _uploader?: FileUploader;
  private _loginPromise?: Promise<string>;
  private _checkoutPromise?: Promise<void>;
  private activeSpinners = new Set<SpinnerLike>();

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
  async getClient(): Promise<APIClient> {
    if (!this.config.token || !this.config.spaceId) {
      await this.ensureLoggedIn(3737, 'explicit');
    }

    if (!this.config.token) {
      this.error('Login did not provide a token. Please run `deckflow login` again.', 'NOT_CONFIGURED');
    }

    if (!this.config.spaceId) {
      this.error(
        'Login succeeded but spaceId is missing. Please run `deckflow login` again.',
        'NO_SPACE_ID',
        ExitCode.USAGE_ERROR
      );
    }

    if (!this._apiClient) {
      this._apiClient = new APIClient(this.config.apiBase, this.config.token!, {
        onUnauthorized: async () => {
          return await this.ensureLoggedIn();
        },
        onPaymentRequired: async () => {
          await this.ensureCheckout();
        },
        getSpaceId: () => this.config.spaceId,
      });
    }

    return this._apiClient;
  }

  /**
   * Get or create file uploader
   */
  async getUploader(): Promise<FileUploader> {
    const client = await this.getClient();

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
      const pausedSpinners = this.pauseActiveSpinners();
      try {
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

        if (this._apiClient) {
          this._apiClient.setToken(token);
          this._apiClient.setSpaceId(this.config.spaceId);
        }

        return token;
      } finally {
        this.resumeSpinners(pausedSpinners);
      }
    })();

    try {
      return await this._loginPromise;
    } finally {
      this._loginPromise = undefined;
    }
  }

  createSpinner(text: string): SpinnerLike | undefined {
    if (this.jsonOutput) {
      return undefined;
    }
    const spinner = ora(text) as SpinnerLike;
    spinner.start();
    this.activeSpinners.add(spinner);
    return spinner;
  }

  succeedSpinner(spinner: SpinnerLike | undefined, text?: string): void {
    if (!spinner) {
      return;
    }
    this.activeSpinners.delete(spinner);
    spinner.succeed(text);
  }

  failSpinner(spinner: SpinnerLike | undefined, text?: string): void {
    if (!spinner) {
      return;
    }
    this.activeSpinners.delete(spinner);
    spinner.fail(text);
  }

  stopSpinner(spinner: SpinnerLike | undefined): void {
    if (!spinner) {
      return;
    }
    this.activeSpinners.delete(spinner);
    spinner.stop();
  }

  private pauseActiveSpinners(): SpinnerLike[] {
    const paused: SpinnerLike[] = [];
    for (const spinner of this.activeSpinners) {
      if (spinner.isSpinning !== false) {
        spinner.stop();
        paused.push(spinner);
      }
    }
    return paused;
  }

  private resumeSpinners(spinners: SpinnerLike[]): void {
    for (const spinner of spinners) {
      if (spinner.isSpinning === false) {
        spinner.start();
      }
    }
  }

  /**
   * Ensure checkout is completed when backend returns 402.
   * Auto-triggered by API client.
   */
  async ensureCheckout(port: number = 3737): Promise<void> {
    if (this._checkoutPromise) {
      return await this._checkoutPromise;
    }

    this._checkoutPromise = (async () => {
      const token = this.config.token;
      if (!token) {
        // If we don't have a token, fall back to login first.
        await this.ensureLoggedIn(port, 'unauthorized');
      }

      await runCheckoutFlow({
        apiBase: this.config.apiBase,
        port,
        jsonOutput: this.jsonOutput,
        token: this.config.token!,
        spaceId: this.config.spaceId,
      });
    })();

    try {
      await this._checkoutPromise;
    } finally {
      this._checkoutPromise = undefined;
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
