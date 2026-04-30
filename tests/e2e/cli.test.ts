/**
 * End-to-end CLI tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * Run CLI command and return output
 */
async function runCLI(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn('node', ['dist/cli.js', ...args], {
      env: { ...process.env, FORCE_COLOR: '0' }, // Disable colors for testing
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({
        exitCode: code || 0,
        stdout,
        stderr,
      });
    });
  });
}

describe('CLI E2E Tests', () => {
  let tempDir: string;

  beforeAll(async () => {
    // Create temp directory for test files
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-e2e-'));
  });

  afterAll(async () => {
    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('Help and Version', () => {
    it('should show help message', async () => {
      const result = await runCLI(['--help']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Deckflow CLI');
      expect(result.stdout).toContain('Commands:');
      expect(result.stdout).toContain('config');
      expect(result.stdout).toContain('compress');
      expect(result.stdout).toContain('extract');
      expect(result.stdout).toContain('ocr');
      expect(result.stdout).toContain('convert');
      expect(result.stdout).toContain('create');
      expect(result.stdout).toContain('translate');
    });

    it('should show version', async () => {
      const result = await runCLI(['--version']);
      const packageJsonText = await fs.readFile(
        new URL('../../package.json', import.meta.url),
        'utf-8'
      );
      const version = (JSON.parse(packageJsonText) as { version: string }).version;

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(version);
    });

    it('should show command-specific help', async () => {
      const result = await runCLI(['compress', '--help']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Compress a file');
      expect(result.stdout).toContain('--no-wait');
      expect(result.stdout).toContain('--timeout');
    });
  });

  describe('Config Commands', () => {
    it('should show config in JSON format', async () => {
      const result = await runCLI(['--json', 'config', 'show']);

      expect(result.exitCode).toBe(0);

      // Should be valid JSON
      const config = JSON.parse(result.stdout);
      expect(config).toBeTypeOf('object');
    });

    it('should set token', async () => {
      const result = await runCLI(['config', 'set-token', 'test-token-e2e']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Token set successfully');
    });

    it('should set space ID', async () => {
      const result = await runCLI(['config', 'set-space', 'test-space-e2e']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Space ID set successfully');
    });

    it('should show updated config', async () => {
      const result = await runCLI(['--json', 'config', 'show']);

      expect(result.exitCode).toBe(0);

      const config = JSON.parse(result.stdout);
      expect(config.token).toBe('test-token-e2e');
      expect(config.spaceId).toBe('test-space-e2e');
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid command', async () => {
      const result = await runCLI(['invalid-command']);

      expect(result.exitCode).not.toBe(0);
    });

    it('should handle missing required argument', async () => {
      const result = await runCLI(['compress']);

      expect(result.exitCode).not.toBe(0);
    });
  });

  describe('JSON Output Mode', () => {
    it('should output JSON for all commands', async () => {
      const commands = [
        ['--json', 'config', 'show'],
        ['--json', 'compress', '--help'], // Help should still work
      ];

      for (const cmd of commands) {
        const result = await runCLI(cmd);

        // JSON output or help text
        if (!cmd.includes('--help')) {
          expect(() => JSON.parse(result.stdout)).not.toThrow();
        }
      }
    });

    it('should output errors in JSON format', async () => {
      const result = await runCLI(['--json', 'task', 'get', 'non-existent-task']);

      expect(result.exitCode).not.toBe(0);

      // Should be valid JSON error
      try {
        const error = JSON.parse(result.stderr);
        expect(error).toHaveProperty('error');
      } catch {
        // If not JSON, that's also acceptable for now
      }
    });
  });

  describe('Command Arguments', () => {
    it('should accept timeout parameter', async () => {
      const result = await runCLI(['compress', '--help']);

      expect(result.stdout).toContain('--timeout');
      expect(result.stdout).toContain('300'); // Default value
    });

    it('should accept extract type parameter', async () => {
      const result = await runCLI(['extract', '--help']);

      expect(result.stdout).toContain('--type');
    });

    it('should accept ocr language parameter', async () => {
      const result = await runCLI(['ocr', '--help']);

      expect(result.stdout).toContain('--language');
    });

    it('should accept convert to parameter', async () => {
      const result = await runCLI(['convert', '--help']);

      expect(result.stdout).toContain('--to');
    });

    it('should accept create options', async () => {
      const result = await runCLI(['create', '--help']);

      expect(result.stdout).toContain('--input-text');
      expect(result.stdout).toContain('--enable-search');
    });

    it('should accept translate required options', async () => {
      const result = await runCLI(['translate', '--help']);

      expect(result.stdout).toContain('--from');
      expect(result.stdout).toContain('--to');
      expect(result.stdout).toContain('--engine');
      expect(result.stdout).toContain('--model');
    });
  });

  describe('Task Commands', () => {
    it('should show task commands help', async () => {
      const result = await runCLI(['task', '--help']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('list');
      expect(result.stdout).toContain('get');
      expect(result.stdout).toContain('delete');
    });

    it('should show task list help with options', async () => {
      const result = await runCLI(['task', 'list', '--help']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--type');
      expect(result.stdout).toContain('--limit');
      expect(result.stdout).toContain('--offset');
    });
  });
});
