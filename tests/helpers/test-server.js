import 'dotenv/config';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const TEST_MODES = {
  REMOTE: 'remote',
  LOCAL: 'local',
};

const state = {
  process: /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */ (null),
  baseUrl: /** @type {string | null} */ (null),
  token: process.env.MCP_ALLOWED_TOKENS?.split(',')[0]?.trim()
    || 'test-suite-token',
  refCount: 0,
  starting: /** @type {Promise<void> | null} */ (null),
  mode: /** @type {'remote' | 'local'} */ (process.env.MCP_TEST_TARGET === TEST_MODES.LOCAL ? TEST_MODES.LOCAL : TEST_MODES.REMOTE),
};

function resolveRemoteBaseUrl() {
  return process.env.TEST_BASE_URL || 'https://freshsales.ssc.one';
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        return;
      }
      const text = await response.text();
      if (text.includes('error code: 1016')) {
        await delay(1000);
        continue;
      }
    } catch (error) {
      // continue retrying
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for MCP server health at ${url}`);
}

async function startLocalServer() {
  const port = parseInt(process.env.TEST_SERVER_PORT || '9878', 10);
  const baseUrl = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    HOST: '127.0.0.1',
    FRESHSALES_API_KEY: process.env.FRESHSALES_API_KEY || 'test-token',
    FRESHSALES_ALIAS: process.env.FRESHSALES_ALIAS || 'test-domain',
    MCP_ALLOWED_TOKENS: process.env.MCP_ALLOWED_TOKENS || state.token,
  };

  process.env.TEST_BASE_URL = baseUrl;
  process.env.MCP_ALLOWED_TOKENS = env.MCP_ALLOWED_TOKENS;

  const child = spawn('node', ['dist/index.js'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  child.stdout?.on('data', data => {
    console.log('[server stdout]', data.trim());
  });

  child.stderr?.on('data', data => {
    console.error('[server stderr]', data.trim());
  });

  state.process = child;
  state.baseUrl = baseUrl;

  await waitForHealth(baseUrl);

  child.on('exit', () => {
    state.process = null;
    state.baseUrl = null;
    state.starting = null;
  });
}

async function acquireRemoteServer() {
  const baseUrl = resolveRemoteBaseUrl();
  await waitForHealth(baseUrl);
  state.baseUrl = baseUrl;
  return {
    baseUrl,
    token: state.token,
  };
}

export async function acquireTestServer() {
  state.refCount += 1;

  if (state.mode === TEST_MODES.REMOTE) {
    return acquireRemoteServer();
  }

  if (state.process && state.baseUrl) {
    return { baseUrl: state.baseUrl, token: state.token };
  }

  if (!state.starting) {
    state.starting = startLocalServer();
  }
  await state.starting;

  if (!state.baseUrl) {
    throw new Error('Test server failed to start');
  }

  return { baseUrl: state.baseUrl, token: state.token };
}

export async function releaseTestServer() {
  if (state.refCount > 0) {
    state.refCount -= 1;
  }

  if (state.mode === TEST_MODES.REMOTE) {
    if (state.refCount === 0) {
      state.baseUrl = null;
    }
    return;
  }

  if (state.refCount === 0 && state.process) {
    state.process.kill('SIGINT');
    await once(state.process, 'exit');
    state.process = null;
    state.baseUrl = null;
    state.starting = null;
  }
}

process.on('exit', () => {
  if (state.process && state.mode === TEST_MODES.LOCAL) {
    state.process.kill('SIGINT');
  }
});
