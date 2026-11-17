// app.ts — the server: routes to git smart HTTP, REST v3, GraphQL v4 and MCP.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './smart.ts';
import { handleRest, HttpError, readBody } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';
import { getRepo } from './store.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;
const requestId = () => `forge-${(++requestCounter).toString(36).padStart(8, '0')}`;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

const pathOf = (req: IncomingMessage): string => {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; }
};
const authed = (req: IncomingMessage): boolean => {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/.exec(h.toString());
  return Boolean(m) && m[1] === TOKEN;
};
const gitRoute = (path: string): { owner: string; repo: string; service?: string } | null => {
  const m = path.match(/^\/([^/]+)\/([^/]+)\.git(?:\/(info\/refs|git-upload-pack|git-receive-pack))?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], service: m[3] ?? undefined };
};

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const rid = requestId();
    const path = pathOf(req);
    const method = (req.method ?? 'GET').toUpperCase();

    res.setHeader('x-github-request-id', rid);

    if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }

    if (!authed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }

    let body: Buffer;
    try { body = await readBody(req); } catch { sendJson(res, 400, { message: 'Bad request body' }); return; }

    try {
      // ── git smart HTTP ───────────────────────────────────
      const git = gitRoute(path);
      if (git && git.service) {
        // the suite uses one owner for everything; anything else simply has no repository
        const repo = getRepo(git.repo);
        if (!repo || repo.fullName.split('/')[0] !== git.owner) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (git.service === 'info/refs' && method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://entry');
          const service = url.searchParams.get('service') ?? '';
          const ok = handleInfoRefs(req, res, repo, service);
          if (!ok) sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (git.service === 'git-upload-pack' && method === 'POST') { handleUploadPack(body, res, repo); return; }
        if (git.service === 'git-receive-pack' && method === 'POST') { handleReceivePack(body, res, repo); return; }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // ── REST v3 ──────────────────────────────────────────
      if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
        const url = new URL(req.url ?? '/', 'http://entry');
        const handled = await handleRest(req, res, url, body);
        if (!handled) sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // ── GraphQL v4 ───────────────────────────────────────
      if (path === '/api/graphql' && method === 'POST') {
        let parsed: any;
        try { parsed = JSON.parse(body.toString('utf8')); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const answerOne = (entry: any): Record<string, unknown> => {
          const query = typeof entry?.query === 'string' ? entry.query : '';
          if (!query) return { data: null, errors: [{ message: 'query is required' }] };
          const variables = entry?.variables ?? undefined;
          const operationName = typeof entry?.operationName === 'string' ? entry.operationName : undefined;
          const result = handleGraphql(query, variables, operationName);
          if ('data' in result || 'errors' in result) {
            const payload: Record<string, unknown> = {};
            if ('data' in result) payload.data = result.data;
            if ('errors' in result) payload.errors = result.errors;
            return payload;
          }
          return { data: result };
        };
        if (Array.isArray(parsed)) {
          // GitHub's operation batching: one request, one response per operation, in order.
          if (parsed.length === 0) { sendJson(res, 400, { message: 'empty batch' }); return; }
          sendJson(res, 200, parsed.map(answerOne));
          return;
        }
        if (parsed === null || typeof parsed !== 'object') { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        if (typeof parsed.query !== 'string' || parsed.query === '') { sendJson(res, 400, { message: 'query is required' }); return; }
        sendJson(res, 200, answerOne(parsed));
        return;
      }

      // ── MCP ──────────────────────────────────────────────
      if (path === '/mcp' && method === 'POST') {
        const raw = body.toString('utf8');
        // Streamable HTTP: answer with application/json (this server does not need SSE)
        req.resume();
        const answer = handleMcpRequest(raw);
        res.setHeader('x-github-request-id', rid);
        if (answer.body === undefined) {
          res.writeHead(answer.status, { 'content-type': 'application/json' });
          res.end();
          return;
        }
        sendJson(res, answer.status, answer.body);
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, err.body ?? { message: err.message });
        return;
      }
      // a malformed JSON body anywhere also answers 400
      sendJson(res, 500, { message: 'Internal Server Error' });
    }
  });
}
