/**
 * Error handling utilities
 */

import chalk from 'chalk';

/**
 * Custom API error class
 */
export class APIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public responseData?: unknown
  ) {
    super(message);
    this.name = 'APIError';
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Create APIError from axios error
   */
  static fromAxiosError(error: any): APIError {
    const status = error.response?.status;
    const data = error.response?.data;

    let errorMessage = 'Unknown API error';

    if (data) {
      if (typeof data === 'object' && data !== null) {
        // Extract error message from various possible fields
        errorMessage =
          (data as any).message ||
          (data as any).error ||
          (data as any).msg ||
          JSON.stringify(data);
      } else if (typeof data === 'string') {
        errorMessage = data.slice(0, 200); // Limit length
      }
    } else if (error.message) {
      errorMessage = error.message;
    }

    return new APIError(
      `API Error (${status || 'unknown'}): ${errorMessage}`,
      status,
      data
    );
  }
}

/**
 * Output error message in JSON or human-readable format
 */
export function outputError(error: Error | APIError, jsonMode: boolean): void {
  if (jsonMode) {
    const errorObj: any = {
      error: error.message,
      code: error.name,
    };

    if (error instanceof APIError && error.responseData) {
      errorObj.details = error.responseData;
    }

    console.error(JSON.stringify(errorObj, null, 2));
  } else {
    console.error(chalk.red(`Error: ${error.message}`));

    if (error instanceof APIError && error.responseData) {
      console.error(chalk.gray('Details:'), error.responseData);
    }
  }
}

/**
 * Exit codes matching Python version
 */
export const ExitCode = {
  SUCCESS: 0,
  ERROR: 1,
  USAGE_ERROR: 2,
} as const;
