/**
 * Login flow utilities (browser + local callback server)
 */

import http from 'http';
import chalk from 'chalk';
import ora from 'ora';

const LOGIN_TIMEOUT = 300000; // 5 minutes

function isChinesePreferredLanguage(acceptLanguageHeader: string | string[] | undefined): boolean {
  const raw = Array.isArray(acceptLanguageHeader) ? acceptLanguageHeader.join(',') : (acceptLanguageHeader ?? '');
  return raw.toLowerCase().includes('zh');
}

function isChineseCliLocale(): boolean {
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  return locale.toLowerCase().includes('zh');
}

async function openBrowser(url: string): Promise<void> {
  const { default: open } = await import('open');
  await open(url);
}

function startCallbackServer(
  port: number
): Promise<{ token: string; spaceId?: string; server: http.Server }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout;

    const settleResolve = (value: { token: string; spaceId?: string; server: http.Server }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(value);
    };

    const settleReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      reject(error);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://localhost:${port}`);
      const token = url.searchParams.get('token');
      const spaceId = url.searchParams.get('spaceId') || url.searchParams.get('space_id') || undefined;
      const isZh = isChinesePreferredLanguage(req.headers['accept-language']);
      const pageTitle = isZh ? '登录成功' : 'Login Successful';
      const pageHeading = isZh ? '登录成功！' : 'Login Successful!';
      const pageDescription = isZh
        ? '你可以关闭此窗口并返回终端。'
        : 'You can close this window and return to your terminal.';

      if (token) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <title>${pageTitle}</title>
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
                <h1>${pageHeading}</h1>
                <p>${pageDescription}</p>
              </div>
            </body>
          </html>
        `);

        settleResolve({ token, spaceId: spaceId || undefined, server });
      } else {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing token parameter');
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        settleReject(new Error(`Port ${port} is already in use. Please close other applications and try again.`));
      } else {
        settleReject(err);
      }
    });

    server.listen(port, () => {
      // Server started successfully
    });

    timeoutHandle = setTimeout(() => {
      server.close();
      settleReject(new Error('Login timeout. Please try again.'));
    }, LOGIN_TIMEOUT);
  });
}

function startRedirectServer(
  port: number
): Promise<{ params: Record<string, string>; server: http.Server }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout;

    const settleResolve = (value: { params: Record<string, string>; server: http.Server }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(value);
    };

    const settleReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      reject(error);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://localhost:${port}`);
      const params: Record<string, string> = {};
      url.searchParams.forEach((v, k) => {
        params[k] = v;
      });
      const isZh = isChinesePreferredLanguage(req.headers['accept-language']);
      const pageTitle = isZh ? '完成' : 'Done';
      const pageHeading = isZh ? '完成' : 'Done';
      const pageDescription = isZh
        ? '你可以关闭此窗口并返回终端。'
        : 'You can close this window and return to your terminal.';

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <title>${pageTitle}</title>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%);
              }
              .container {
                background: white;
                padding: 3rem;
                border-radius: 1rem;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                text-align: center;
                max-width: 420px;
              }
              h1 {
                color: #111827;
                margin: 0 0 1rem 0;
              }
              p {
                color: #6b7280;
                margin: 0;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>${pageHeading}</h1>
              <p>${pageDescription}</p>
            </div>
          </body>
        </html>
      `);

      settleResolve({ params, server });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        settleReject(new Error(`Port ${port} is already in use. Please close other applications and try again.`));
      } else {
        settleReject(err);
      }
    });

    server.listen(port, () => {
      // Server started successfully
    });

    timeoutHandle = setTimeout(() => {
      server.close();
      settleReject(new Error('Operation timeout. Please try again.'));
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

export function buildCheckoutUrl(options: {
  apiBase: string;
  redirectUrl: string;
  token: string;
  spaceId?: string;
}): string {
  const base = normalizeLoginBase(options.apiBase);
  const u = new URL(`${base}/cli/checkout`);
  u.searchParams.set('redirect_url', options.redirectUrl);
  u.searchParams.set('token', options.token);
  if (options.spaceId) {
    u.searchParams.set('spaceId', options.spaceId);
  }
  return u.toString();
}

export async function runLoginFlow(options: {
  apiBase: string;
  port: number;
  jsonOutput: boolean;
  reason?: 'explicit' | 'unauthorized';
}): Promise<{ token: string; spaceId?: string }> {
  const isZh = isChineseCliLocale();
  const callbackUrl = `http://localhost:${options.port}`;
  const loginUrl = buildLoginUrl(options.apiBase, callbackUrl);

  if (!options.jsonOutput) {
    if (options.reason === 'unauthorized') {
      console.log(chalk.yellow(isZh ? '\n认证已失效，需要重新登录。\n' : '\nAuthentication expired. Please log in again.\n'));
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
      console.log(chalk.yellow(isZh ? '\n无法自动打开浏览器。' : '\nUnable to open browser automatically.'));
      console.log(`${isZh ? '请手动打开此链接：' : 'Please open this link manually:'}\n${chalk.cyan(loginUrl)}\n`);
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

export async function runCheckoutFlow(options: {
  apiBase: string;
  port: number;
  jsonOutput: boolean;
  token: string;
  spaceId?: string;
}): Promise<void> {
  const isZh = isChineseCliLocale();
  const redirectUrl = `http://localhost:${options.port}`;
  const checkoutUrl = buildCheckoutUrl({
    apiBase: options.apiBase,
    redirectUrl,
    token: options.token,
    spaceId: options.spaceId,
  });

  if (!options.jsonOutput) {
    console.log(chalk.yellow(isZh ? '\n余额不足，需要购买后继续。\n' : '\nInsufficient balance. Please complete payment to continue.\n'));
    console.log(`Opening browser to: ${chalk.underline(checkoutUrl)}`);
    console.log(chalk.dim(`Waiting for checkout completion on port ${options.port}...\n`));
  }

  const serverPromise = startRedirectServer(options.port);

  try {
    await openBrowser(checkoutUrl);
  } catch {
    if (!options.jsonOutput) {
      console.log(chalk.yellow(isZh ? '\n无法自动打开浏览器。' : '\nUnable to open browser automatically.'));
      console.log(`${isZh ? '请手动打开此链接：' : 'Please open this link manually:'}\n${chalk.cyan(checkoutUrl)}\n`);
    }
  }

  let spinner: any;
  if (!options.jsonOutput) {
    spinner = ora('Waiting for checkout...').start();
  }

  const { server } = await serverPromise;
  server.close();

  if (spinner) {
    spinner.succeed('Checkout completed!');
  }
}

