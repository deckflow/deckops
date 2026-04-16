/**
 * Login flow utilities (browser + local callback server)
 */

import http from 'http';
import chalk from 'chalk';
import ora from 'ora';

const LOGIN_TIMEOUT = 300000; // 5 minutes

async function openBrowser(url: string): Promise<void> {
  const { default: open } = await import('open');
  await open(url);
}

function startCallbackServer(
  port: number
): Promise<{ token: string; spaceId?: string; server: http.Server }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://localhost:${port}`);
      const token = url.searchParams.get('token');
      const spaceId = url.searchParams.get('spaceId') || url.searchParams.get('space_id') || undefined;

      if (token) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <title>Login Successful</title>
              <style>
                body {
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  height: 100vh;
                  margin: 0;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                }
                .container {
                  background: white;
                  padding: 3rem;
                  border-radius: 1rem;
                  box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                  text-align: center;
                  max-width: 400px;
                }
                .success-icon {
                  font-size: 4rem;
                  margin-bottom: 1rem;
                }
                h1 {
                  color: #333;
                  margin: 0 0 1rem 0;
                }
                p {
                  color: #666;
                  margin: 0;
                }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="success-icon">✓</div>
                <h1>Login Successful!</h1>
                <p>You can close this window and return to your terminal.</p>
              </div>
            </body>
          </html>
        `);

        resolve({ token, spaceId: spaceId || undefined, server });
      } else {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing token parameter');
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Please close other applications and try again.`));
      } else {
        reject(err);
      }
    });

    server.listen(port, () => {
      // Server started successfully
    });

    setTimeout(() => {
      server.close();
      reject(new Error('Login timeout. Please try again.'));
    }, LOGIN_TIMEOUT);
  });
}

function normalizeLoginBase(apiBase: string): string {
  const u = new URL(apiBase);
  // 登录页面不走 API 版本前缀（例如 /v1），但 apiBase 可能包含它
  u.pathname = u.pathname.replace(/\/v1\/?$/, '/');
  // 统一去掉末尾的 /，避免出现双斜杠
  return `${u.origin}${u.pathname}`.replace(/\/$/, '');
}

export function buildLoginUrl(apiBase: string, callbackUrl: string): string {
  const loginBase = normalizeLoginBase(apiBase);
  return `${loginBase}/cli/auth?redirect_url=${encodeURIComponent(callbackUrl)}`;
}

export async function runLoginFlow(options: {
  apiBase: string;
  port: number;
  jsonOutput: boolean;
  reason?: 'explicit' | 'unauthorized';
}): Promise<{ token: string; spaceId?: string }> {
  const callbackUrl = `http://localhost:${options.port}`;
  const loginUrl = buildLoginUrl(options.apiBase, callbackUrl);

  if (!options.jsonOutput) {
    if (options.reason === 'unauthorized') {
      console.log(chalk.yellow('\n认证已失效，需要重新登录。\n'));
    } else {
      console.log(chalk.cyan('\n🔐 Deckflow Login\n'));
    }
    console.log(`Opening browser to: ${chalk.underline(loginUrl)}`);
    console.log(chalk.dim(`Waiting for authentication on port ${options.port}...\n`));
  }

  const serverPromise = startCallbackServer(options.port);

  try {
    await openBrowser(loginUrl);
  } catch {
    if (!options.jsonOutput) {
      console.log(chalk.yellow('\n无法自动打开浏览器。'));
      console.log(`请手动打开此链接：\n${chalk.cyan(loginUrl)}\n`);
    }
  }

  let spinner: any;
  if (!options.jsonOutput) {
    spinner = ora('Waiting for login...').start();
  }

  const { token, spaceId, server } = await serverPromise;
  server.close();

  if (spinner) {
    spinner.succeed('Login successful!');
  }

  return { token, spaceId };
}

