/**
 * CLI context management
 */

import { Config } from './core/config.js';
import { createDeck, APIError, type DeckClient, type DeckTask, type TaskListResponse } from '@deckops/sdk';
import { runCheckoutFlow, runLoginFlow } from './core/auth.js';
import { formatResponseBody, outputError, ExitCode } from './utils/errors.js';
import {
  formatTaskOutputWriteResult,
  writeTaskOutput,
  type TaskOutputWriteResult,
} from './utils/output.js';
import ora from 'ora';

type SpinnerLike = {
  text: string;
  isSpinning?: boolean;
  start: () => void;
  stop: () => void;
  succeed: (text?: string) => void;
  fail: (text?: string) => void;
};

type LegacyClient = {
  addTask: (
    spaceId: string,
    fileIds: string[],
    taskType: string,
    name?: string,
    params?: Record<string, unknown>
  ) => Promise<DeckTask>;
  listTasks: (
    spaceId: string,
    taskType?: string,
    startIndex?: number,
    maxResults?: number
  ) => Promise<TaskListResponse>;
  getTask: (taskId: string, useEventStream?: boolean) => Promise<DeckTask>;
  deleteTask: (taskId: string) => Promise<void>;
  downTask: (taskId: string) => Promise<unknown>;
  waitForTask: (
    taskId: string,
    timeout?: number,
    useEventStream?: boolean,
    progressCallback?: (task: DeckTask) => void
  ) => Promise<DeckTask>;
  setToken: (token: string) => void;
  setSpaceId: (spaceId: string | undefined) => void;
};

type LegacyUploader = {
  uploadFile: (
    spaceId: string,
    filePath: string,
    progressCallback?: (percentage: number) => void
  ) => Promise<string>;
};

/**
 * Global context for CLI commands
 */
export class Context {
  public config: Config;
  public jsonOutput: boolean;
  private _deck?: DeckClient;
  private _apiClient?: LegacyClient;
  private _uploader?: LegacyUploader;
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
  async getClient(): Promise<LegacyClient> {
    // Token is the only hard requirement for authentication.
    // Some deployments may not return/provide spaceId during login.
    if (!this.config.token) {
      await this.ensureLoggedIn(3737, 'explicit');
    }

    if (!this.config.token) {
      this.error('Login did not provide a token. Please run `deckflow login` again.', 'NOT_CONFIGURED');
    }

    if (!this._apiClient) {
      this._deck = createDeck({
        root: this.config.apiBase,
        token: this.config.token!,
        spaceId: this.config.spaceId,
        onUnauthorized: async () => {
          const token = await this.ensureLoggedIn();
          return { token, spaceId: this.config.spaceId };
        },
        onPaymentRequired: async () => {
          await this.ensureCheckout();
        },
      });

      this._apiClient = this.createLegacyClient(this._deck);
    }

    return this._apiClient;
  }

  /**
   * Get or create file uploader
   */
  async getUploader(): Promise<LegacyUploader> {
    await this.getClient();

    if (!this._uploader) {
      this._uploader = {
        uploadFile: async (spaceId, filePath, progressCallback) => {
          if (!this._deck) {
            throw new Error('Deck SDK client is not initialized');
          }
          const result = await this._deck.files.upload(filePath, {
            spaceId,
            onProgress: progressCallback,
          });
          return result.id;
        },
      };
    }

    return this._uploader;
  }

  private createLegacyClient(deck: DeckClient): LegacyClient {
    return {
      addTask: async (spaceId, fileIds, taskType, name, params) =>
        deck.tasks.create({
          spaceId,
          fileIds,
          type: taskType as never,
          name,
          params: (params ?? {}) as never,
        }),
      listTasks: async (spaceId, taskType, startIndex = 0, maxResults = 50) =>
        deck.tasks.list({
          spaceId,
          type: taskType as never,
          startIndex,
          maxResults,
        }),
      getTask: async (taskId, useEventStream = false) =>
        deck.tasks.get(taskId, {
          useEventStream,
        }),
      deleteTask: async (taskId) => deck.tasks.delete(taskId),
      downTask: async (taskId) => deck.tasks.down(taskId),
      waitForTask: async (taskId, timeout = 300, useEventStream = true, progressCallback) =>
        deck.tasks.wait(taskId, {
          timeout,
          useEventStream,
          onProgress: progressCallback,
        }),
      setToken: (token) => deck.setToken(token),
      setSpaceId: (spaceId) => deck.setSpaceId(spaceId),
    };
  }

  async writeTaskOutput(task: DeckTask, outPath: string): Promise<TaskOutputWriteResult> {
    const client = await this.getClient();
    const downloadResult = await client.downTask(task.id);
    return await writeTaskOutput(task, outPath, downloadResult);
  }

  async tryWriteTaskOutput(task: DeckTask, outPath: string): Promise<TaskOutputWriteResult | undefined> {
    if (task.status !== 'completed') {
      return undefined;
    }

    const spinner = this.createSpinner('Downloading result...');
    try {
      const result = await this.writeTaskOutput(task, outPath);
      this.succeedSpinner(spinner, 'Result saved');
      return result;
    } catch {
      this.stopSpinner(spinner);
      return undefined;
    }
  }

  outputTaskSaved(result: TaskOutputWriteResult): void {
    this.output(
      { output: result.path },
      () => formatTaskOutputWriteResult(result)
    );
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
        this._deck?.setToken(token);
        this._deck?.setSpaceId(this.config.spaceId);

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
  error(input: unknown, code: string = 'ERROR', exitCode: number = ExitCode.ERROR): never {
    const err: Error =
      input instanceof APIError
        ? input
        : input instanceof Error
          ? input
          : new Error(String(input));

    if (this.jsonOutput) {
      if (err instanceof APIError) {
        const payload: Record<string, unknown> = {
          error: err.message,
          code,
        };
        if (err.requestId) {
          payload.requestId = err.requestId;
        }
        if (err.responseData !== undefined) {
          payload.body = err.responseData;
          payload.bodyText = formatResponseBody(err.responseData);
        }
        console.error(JSON.stringify(payload));
      } else {
        console.error(JSON.stringify({ error: err.message, code }));
      }
    } else {
      outputError(err, false);
    }

    process.exit(exitCode);
  }
}
