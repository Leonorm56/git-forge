// main.ts — entry <-> env lifecycle: bind an ephemeral port, tell the env about it, wait for the
// trial to end and exit 0. The contest machinery scores the server `createApp()` builds; this
// file only wires it up.

import { createApp } from './app.ts';

const raw = process.env.MAKEFUN_ENV_URL ?? '';
const ENV_URL = raw.replace(/\/+$/, '');

if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set — nothing to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: boolean };
        if (body.done === true) return;
      }
    } catch {
      // the env may be mid-write; keep polling
    }
    await sleep(retryDelay(attempt));
  }
}

const server = createApp();

server.listen(0, async () => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    process.stderr.write('[entry] could not read the bound address\n');
    process.exit(1);
  }
  try {
    await register(address.port);
    process.stdout.write(`[entry] registered on :${address.port}\n`);
    await waitForDone();
    process.stdout.write('[entry] trial complete\n');
    server.close(() => process.exit(0));
    // never hang: give close a brief moment, then leave anyway
    setTimeout(() => process.exit(0), 1_000).unref();
  } catch (err) {
    process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
});
