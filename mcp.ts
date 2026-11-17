// mcp.ts — the Model Context Protocol endpoint at /mcp (JSON-RPC 2.0, Streamable HTTP).

import type { ServerResponse } from 'node:http';
import { OWNER, OWNER_ID, allRepos, ensureRepo, getRepo, newId } from './store.ts';
import { squashMerge } from './rest.ts';

const rpc = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const toolResult = (id: unknown, payload: unknown, isError = false) =>
  rpc(id, { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError });

const ts = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const repoPayload = (repo: ReturnType<typeof ensureRepo>) => ({
  name: repo.name, owner: OWNER, full_name: repo.fullName,
  description: repo.description, default_branch: repo.defaultBranch,
  private: false, url: `https://github.example/${repo.fullName}`,
});
const issuePayload = (repo: ReturnType<typeof ensureRepo>, issue: any) => ({
  id: issue.id, number: issue.number, title: issue.title, body: issue.body,
  state: issue.state, labels: issue.labels,
  user: { login: issue.user }, created_at: issue.created_at,
  html_url: `https://github.example/${repo.fullName}/issues/${issue.number}`,
});
const prPayload = (repo: ReturnType<typeof ensureRepo>, pr: any) => ({
  id: pr.id, number: pr.number, title: pr.title, body: pr.body,
  state: pr.state, head: { ref: pr.head }, base: { ref: pr.base },
  merged: pr.merged, merge_commit_sha: pr.merge_commit_sha,
  html_url: `https://github.example/${repo.fullName}/pull/${pr.number}`,
});
const parseFullName = (args: any) => {
  if (args?.full_name) {
    const [owner, repo] = String(args.full_name).split('/');
    return { owner, repo };
  }
  return { owner: args?.owner, repo: args?.repo ?? args?.name };
};

const TOOLS = [
  { name: 'create_repo', description: 'Create a repository owned by the token’s account.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The repository name' }, full_name: { type: 'string', description: 'owner/name' } }, required: ['name'], additionalProperties: true } },
  { name: 'get_repo', description: 'Read one repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, name: { type: 'string' }, full_name: { type: 'string' } }, additionalProperties: true } },
  { name: 'create_issue', description: 'Open an issue on a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, name: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['title'], additionalProperties: true } },
  { name: 'list_issues', description: 'List the issues of a repository, optionally filtered by state.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, name: { type: 'string' }, full_name: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, additionalProperties: true } },
  { name: 'create_pull_request', description: 'Open a pull request from a pushed branch into a base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, name: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'head', 'base'], additionalProperties: true } },
  { name: 'merge_pull_request', description: 'Squash-merge a pull request into its base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, name: { type: 'string' }, full_name: { type: 'string' }, pull_number: { type: 'integer' }, number: { type: 'integer' } }, required: ['pull_number'], additionalProperties: true } },
];

export function handleMcpMessage(msg: any): any | null {
  // notifications (no id) → caller answers 202 with no body
  if (msg && msg.id === undefined && typeof msg?.method === 'string') return null;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, -32700, 'Parse error');
  const id = msg.id ?? null;
  const method = msg.method;

  if (method === 'initialize') {
    const requested = msg.params?.protocolVersion ?? '2026-07-28';
    return rpc(id, {
      protocolVersion: requested === '2026-07-28' ? '2026-07-28' : '2025-11-25',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'github', version: '1.0.0' },
    });
  }
  if (method === 'server/discover') {
    return rpc(id, { supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'] });
  }
  if (method === 'ping') return rpc(id, {});
  if (method === 'resources/list') return rpc(id, { resources: [] });
  if (method === 'prompts/list') return rpc(id, { prompts: [] });
  if (method === 'tools/list') {
    return rpc(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const params = msg.params ?? {};
    const requestedName: string | undefined = params.name;
    const tool = TOOLS.find((t) => requestedName && requestedName.toLowerCase().endsWith(t.name.toLowerCase()));
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${requestedName ?? '(none)'}`);
    const args = params.arguments ?? {};
    try {
      switch (tool.name) {
        case 'create_repo': {
          const name = args.name ?? (args.full_name ? String(args.full_name).split('/')[1] : undefined);
          if (!name) return toolResult(id, { message: 'name is required' }, true);
          const repo = ensureRepo(String(name));
          repoPayload(repo); // touch for node linking
          return toolResult(id, repoPayload(repo));
        }
        case 'get_repo': {
          const { owner, repo } = parseFullName(args);
          const name = repo ?? args.name;
          if (!name) return toolResult(id, { message: 'repo is required' }, true);
          const r = getRepo(String(name));
          if (!r) return toolResult(id, { message: 'Not Found' }, true);
          return toolResult(id, repoPayload(r));
        }
        case 'create_issue': {
          const { owner, repo } = parseFullName(args);
          const name = repo ?? args.name;
          if (!name) return toolResult(id, { message: 'repo is required' }, true);
          const title = args.title;
          if (!title) return toolResult(id, { message: 'title is required' }, true);
          const r = ensureRepo(String(name));
          const wanted = Array.isArray(args.labels) ? args.labels.map(String) : [];
          // mirror REST semantics: unknown labels refuse the creation
          for (const label of wanted) {
            if (!r.labels.some((l) => l.name === label)) return toolResult(id, { message: `label '${label}' does not exist` }, true);
          }
          const issue = {
            id: newId(), number: ++r.issueSeq, title: String(title), body: String(args.body ?? ''),
            state: 'open' as const, labels: wanted, user: OWNER, created_at: ts(), updated_at: ts(),
          };
          r.issues.push(issue);
          return toolResult(id, issuePayload(r, issue));
        }
        case 'list_issues': {
          const { owner, repo } = parseFullName(args);
          const name = repo ?? args.name;
          if (!name) return toolResult(id, { message: 'repo is required' }, true);
          const r = getRepo(String(name));
          if (!r) return toolResult(id, { message: 'Not Found' }, true);
          const state = args.state ?? 'open';
          const list = r.issues.filter((i) => state === 'all' ? true : i.state === state);
          return toolResult(id, { issues: list.map((i) => issuePayload(r, i)), total_count: list.length });
        }
        case 'create_pull_request': {
          const { owner, repo } = parseFullName(args);
          const name = repo ?? args.name;
          if (!name) return toolResult(id, { message: 'repo is required' }, true);
          const { title, head, base, body } = args;
          if (!title || !head || !base) return toolResult(id, { message: 'title, head and base are required' }, true);
          const r = ensureRepo(String(name));
          if (!r.refs.has(`refs/heads/${head}`)) return toolResult(id, { message: `head branch '${head}' does not exist` }, true);
          const pr = {
            id: newId(), number: ++r.prSeq, title: String(title), body: String(body ?? ''),
            state: 'open' as const, merged: false, head: String(head), base: String(base),
            user: OWNER, created_at: ts(), updated_at: ts(), merge_commit_sha: null as string | null,
          };
          r.prs.push(pr);
          return toolResult(id, prPayload(r, pr));
        }
        case 'merge_pull_request': {
          const { owner, repo } = parseFullName(args);
          const name = repo ?? args.name;
          if (!name) return toolResult(id, { message: 'repo is required' }, true);
          const n = args.pull_number ?? args.number;
          if (typeof n !== 'number') return toolResult(id, { message: 'pull_number is required' }, true);
          const r = getRepo(String(name));
          if (!r) return toolResult(id, { message: 'Not Found' }, true);
          const pr = r.prs.find((p) => p.number === n);
          if (!pr) return toolResult(id, { message: 'Not Found' }, true);
          const sha = squashMerge(r, pr);
          if (sha === null) return toolResult(id, { message: 'Merge conflict', merged: false }, true);
          return toolResult(id, { merged: true, sha, message: 'Pull Request successfully merged' });
        }
        default:
          return rpcError(id, -32602, `Unknown tool: ${tool.name}`);
      }
    } catch (err) {
      return toolResult(id, { message: err instanceof Error ? err.message : String(err) }, true);
    }
  }
  return rpcError(id, -32601, `Method not found: ${method ?? '(none)'}`);
}

/** 202 with an empty body for notifications; otherwise the JSON-RPC response. */
export function handleMcpRequest(raw: string): { status: number; body?: unknown } {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (Array.isArray(msg)) {
    const answers = msg.map(handleMcpMessage).filter((m) => m !== null);
    return { status: answers.length ? 200 : 202, body: answers.length ? answers : undefined };
  }
  const answer = handleMcpMessage(msg);
  if (answer === null) return { status: 202 };
  return { status: 200, body: answer };
}
