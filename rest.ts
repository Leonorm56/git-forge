// rest.ts — GitHub REST v3 surface under /api/v3.
// Every reply is application/json with a non-empty X-GitHub-Request-Id (handled by the router).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { OWNER, OWNER_ID, allRepos, ensureRepo, deleteRepo, getRepo, newId, type Repo } from './store.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  if (body === undefined) { res.writeHead(status, headers); res.end(); return; }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(text);
};
export const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
const parseJson = (buf: Buffer): any => {
  if (buf.length === 0) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new HttpError(400, 'Problems parsing JSON'); }
};
const qn = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? '';

const getOwner = (repo: Repo | null) =>
  repo && repo.fullName.split('/')[0];

const repoOr404 = (name: string, owner: string): Repo => {
  const repo = getRepo(name);
  if (!repo || getOwner(repo).toLowerCase() !== owner.toLowerCase()) throw new HttpError(404, 'Not Found');
  return repo;
};

const pageOf = <T>(items: T[], page: number, perPage: number): { page: T[]; link?: string } => {
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const hasNext = start + perPage < items.length;
  return { page: slice, link: hasNext ? `<https://github.example/api/v3/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next"` : undefined };
};

export async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, bodyBuf: Buffer): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const rest = path.slice('/api/v3'.length);

  if (method === 'GET' && (rest === '' || rest === '/')) {
    json(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && rest === '/meta') {
    json(res, 200, { installed_version: '3.9.0-forge', verifiable_password_authentication: false });
    return true;
  }
  if (method === 'GET' && rest === '/rate_limit') {
    json(res, 200, { resources: { core: { limit: 5000, remaining: 5000, reset: 0 } }, rate: { limit: 5000, remaining: 5000, reset: 0 } });
    return true;
  }
  if (method === 'GET' && rest === '/user') {
    json(res, 200, { login: OWNER, id: OWNER_ID, node_id: `U_${OWNER}`, type: 'User', name: 'Shop' });
    return true;
  }

  // ── repositories ────────────────────────────────────────────
  if (method === 'GET' && rest === '/user/repos') {
    const perPage = Math.max(1, Math.min(100, Number(qn(url.searchParams.get('per_page') ?? '30')) || 30));
    const page = Math.max(1, Number(qn(url.searchParams.get('page') ?? '1')) || 1);
    const all = [...allRepos().values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const { page: slice, link } = pageOf(all, page, perPage);
    json(res, 200, slice.map((r) => r.repoJson()), link ? { link } : {});
    return true;
  }
  if (method === 'POST' && rest === '/user/repos') {
    const body = parseJson(bodyBuf);
    if (!body.name || typeof body.name !== 'string') throw new HttpError(422, 'name is required');
    const repo = ensureRepo(body.name);
    if (body.description !== undefined) repo.description = String(body.description ?? '');
    if (body.private !== undefined) repo.private_ = Boolean(body.private);
    json(res, 201, repo.repoJson());
    return true;
  }
  const repoMatch = rest.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (repoMatch) {
    const [, owner, name, sub = '/'] = repoMatch;
    if (sub === '/' || sub === '') {
      if (method === 'GET') { json(res, 200, repoOr404(name, owner).repoJson()); return true; }
      if (method === 'PATCH') {
        const repo = repoOr404(name, owner);
        const body = parseJson(bodyBuf);
        if (body.description !== undefined) repo.description = String(body.description ?? '');
        json(res, 200, repo.repoJson());
        return true;
      }
      if (method === 'DELETE') {
        repoOr404(name, owner);
        deleteRepo(name);
        json(res, 204, undefined);
        return true;
      }
    }
    const repo = repoOr404(name, owner);

    // ── contents ───────────────────────────────────────────────
    const contentsMatch = sub.match(/^\/contents\/(.+)$/);
    if (contentsMatch) {
      const path = contentsMatch[1];
      const branch = 'main';
      const files = repo.filesAt(repo.refs.get(`refs/heads/${branch}`) ?? null);
      const existing = files.get(path) ?? null;
      if (method === 'PUT') {
        const body = parseJson(bodyBuf);
        const message = typeof body.message === 'string' && body.message ? body.message : 'Update file';
        const content = body.content !== undefined ? Buffer.from(String(body.content), 'base64').toString('utf8') : null;
        if (body.sha !== undefined && existing && body.sha !== existing.sha) throw new HttpError(409, 'sha does not match the current file');
        if (body.sha !== undefined && !existing) throw new HttpError(409, 'sha does not match the current file');
        const wasUpdate = Boolean(existing);
        const newCommit = repo.commitFile(branch, path, content ?? '', message);
        json(res, wasUpdate ? 200 : 201, {
          content: {
            name: path.split('/').pop(),
            path,
            sha: repo.filesAt(newCommit).get(path)!.sha,
            size: (content ?? '').length,
            url: `https://github.example/api/v3/repos/${repo.fullName}/contents/${path}`,
            html_url: `https://github.example/${repo.fullName}/blob/${branch}/${path}`,
          },
          commit: { sha: newCommit, message, url: `https://github.example/api/v3/repos/${repo.fullName}/git/commits/${newCommit}` },
        });
        return true;
      }
      if (method === 'DELETE') {
        const body = parseJson(bodyBuf);
        const message = typeof body.message === 'string' && body.message ? body.message : 'Delete file';
        if (!existing) throw new HttpError(404, 'Not Found');
        const newCommit = repo.commitFile(branch, path, null, message);
        json(res, 200, { commit: { sha: newCommit, message } });
        return true;
      }
      if (method === 'GET') {
        if (!existing) throw new HttpError(404, 'Not Found');
        const blob = repo.readObject(existing.sha)!;
        json(res, 200, {
          type: 'file',
          name: path.split('/').pop(),
          path,
          sha: existing.sha,
          encoding: 'base64',
          content: blob.data.toString('base64'),
          size: blob.data.length,
          url: `https://github.example/api/v3/repos/${repo.fullName}/contents/${path}`,
          html_url: `https://github.example/${repo.fullName}/blob/${branch}/${path}`,
        });
        return true;
      }
    }

    // ── labels ─────────────────────────────────────────────────
    if (method === 'POST' && sub === '/labels') {
      const body = parseJson(bodyBuf);
      if (!body.name || typeof body.name !== 'string') throw new HttpError(422, 'name is required');
      if (repo.labels.some((l) => l.name.toLowerCase() === body.name.toLowerCase())) throw new HttpError(422, 'already_exists');
      const label = { name: body.name, color: String(body.color ?? 'ededed'), description: String(body.description ?? '') };
      repo.labels.push(label);
      json(res, 201, { ...label, id: newId(), node_id: `L_${label.name}` });
      return true;
    }
    if (method === 'GET' && sub === '/labels') {
      json(res, 200, repo.labels.map((l) => ({ ...l, id: newId(), node_id: `L_${l.name}` })));
      return true;
    }

    // ── issues ─────────────────────────────────────────────────
    if (method === 'POST' && sub === '/issues') {
      const body = parseJson(bodyBuf);
      if (!body.title || typeof body.title !== 'string') throw new HttpError(422, 'title is required');
      const wanted: string[] = Array.isArray(body.labels) ? body.labels.map(String) : [];
      for (const label of wanted) {
        if (!repo.labels.some((l) => l.name === label)) {
          throw new HttpError(422, 'Validation Failed', { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid', message: `label '${label}' does not exist` }] });
        }
      }
      const issue = {
        id: newId(), number: ++repo.issueSeq, title: body.title, body: String(body.body ?? ''),
        state: 'open' as const, labels: wanted, user: OWNER, created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      };
      repo.issues.push(issue);
      json(res, 201, repo.issueJson(issue));
      return true;
    }
    const issueMatch = sub.match(/^\/issues\/(\d+)$/);
    if (issueMatch) {
      const number = Number(issueMatch[1]);
      const issue = repo.issues.find((i) => i.number === number);
      if (method === 'GET') {
        if (!issue) throw new HttpError(404, 'Not Found');
        json(res, 200, repo.issueJson(issue));
        return true;
      }
      if (method === 'PATCH' && issue) {
        const body = parseJson(bodyBuf);
        if (body.state === 'closed') issue.state = 'closed';
        if (body.state === 'open') issue.state = 'open';
        if (body.title !== undefined) issue.title = String(body.title);
        if (body.body !== undefined) issue.body = String(body.body);
        issue.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        json(res, 200, repo.issueJson(issue));
        return true;
      }
    }
    const issueComments = sub.match(/^\/issues\/(\d+)\/comments$/);
    if (issueComments && method === 'POST') {
      const number = Number(issueComments[1]);
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) throw new HttpError(404, 'Not Found');
      const body = parseJson(bodyBuf);
      json(res, 201, { id: newId(), node_id: `IC_${newId()}`, issue_url: `https://github.example/api/v3/repos/${repo.fullName}/issues/${number}`, body: String(body.body ?? ''), user: { login: OWNER, id: OWNER_ID }, created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
      return true;
    }

    // ── pull requests ──────────────────────────────────────────
    if (method === 'POST' && sub === '/pulls') {
      const body = parseJson(bodyBuf);
      if (!body.title || !body.head || !body.base) throw new HttpError(422, 'title, head and base are required');
      if (!repo.refs.has(`refs/heads/${body.head}`)) throw new HttpError(422, `head branch '${body.head}' does not exist`);
      const pr = {
        id: newId(), number: ++repo.prSeq, title: String(body.title), body: String(body.body ?? ''),
        state: 'open' as const, merged: false, head: String(body.head), base: String(body.base),
        user: OWNER, created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        merge_commit_sha: null,
      };
      repo.prs.push(pr);
      json(res, 201, repo.prJson(pr));
      return true;
    }
    const prMatch = sub.match(/^\/pulls\/(\d+)(\/merge)?$/);
    if (prMatch) {
      const number = Number(prMatch[1]);
      const isMerge = Boolean(prMatch[2]);
      const pr = repo.prs.find((p) => p.number === number);
      if (!pr) throw new HttpError(404, 'Not Found');
      if (isMerge && method === 'PUT') {
        const sha = squashMerge(repo, pr);
        if (sha === null) { json(res, 405, { message: 'Merge conflict' }); return true; }
        json(res, 200, { sha, message: 'Pull Request successfully merged', merged: true });
        return true;
      }
      if (method === 'GET' && !isMerge) { json(res, 200, repo.prJson(pr)); return true; }
    }
    const prFiles = sub.match(/^\/pulls\/(\d+)\/files$/);
    if (prFiles && method === 'GET') {
      const number = Number(prFiles[1]);
      const pr = repo.prs.find((p) => p.number === number);
      if (!pr) throw new HttpError(404, 'Not Found');
      const base = repo.refs.get(`refs/heads/${pr.base}`) ?? null;
      const head = repo.refs.get(`refs/heads/${pr.head}`) ?? null;
      const baseFiles = repo.filesAt(base);
      const headFiles = repo.filesAt(head);
      const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
      const files = [];
      for (const p of paths) {
        const before = baseFiles.get(p), after = headFiles.get(p);
        if (before?.sha === after?.sha) continue;
        files.push({ filename: p, status: !before ? 'added' : !after ? 'removed' : 'modified', additions: 1, deletions: 1, changes: 2, blob_url: `https://github.example/${repo.fullName}/blob/${pr.head}/${p}` });
      }
      json(res, 200, files);
      return true;
    }
    if (method === 'GET' && sub === '/pulls') {
      const state = qn(url.searchParams.get('state') ?? 'open');
      const list = repo.prs.filter((p) => (state === 'all' ? true : p.state === state));
      json(res, 200, list.map((p) => repo.prJson(p)));
      return true;
    }
  }
  return false;
}

/** squash-merge `pr` into its base branch; returns the new commit sha, or null on conflict. */
export function squashMerge(repo: Repo, pr: { number: number; title: string; head: string; base: string }): string | null {
  const headSha = repo.refs.get(`refs/heads/${pr.head}`);
  const baseSha = repo.refs.get(`refs/heads/${pr.base}`) ?? null;
  if (!headSha) return null;
  const mergeBase = findMergeBase(repo, headSha, baseSha) ?? baseSha;
  const baseFiles = repo.filesAt(baseSha);
  const headFiles = repo.filesAt(headSha);
  const mbFiles = repo.filesAt(mergeBase);
  const result = new Map(baseFiles);
  const paths = new Set([...result.keys(), ...headFiles.keys(), ...mbFiles.keys()]);
  for (const p of paths) {
    const mb = mbFiles.get(p);
    const head = headFiles.get(p);
    const base = baseFiles.get(p);
    const headChanged = (head?.sha ?? null) !== (mb?.sha ?? null);
    const baseChanged = (base?.sha ?? null) !== (mb?.sha ?? null);
    if (headChanged && baseChanged && head?.sha !== base?.sha) return null; // both rewrote it
    if (headChanged) {
      if (head) result.set(p, head);
      else result.delete(p);
    }
  }
  const root = repo.writeWorkTree(result);
  const sha = repo.commitTo(root, baseSha ? [baseSha] : [], `${pr.title} (#${pr.number})`);
  repo.refs.set(`refs/heads/${pr.base}`, sha);
  const stored = repo.prs.find((x) => x.number === pr.number);
  if (stored) { stored.state = 'closed'; stored.merged = true; stored.merge_commit_sha = sha; stored.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
  repo.pushedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return sha;
}

function findMergeBase(repo: Repo, a: string, b: string | null): string | null {
  if (!b) return a;
  // all ancestors of b, nearest first
  const dist = new Map<string, number>();
  const seen = new Set<string>();
  const queue: { sha: string; d: number }[] = [{ sha: b, d: 0 }];
  while (queue.length) {
    const { sha, d } = queue.shift()!;
    if (dist.has(sha) && dist.get(sha)! <= d) continue;
    dist.set(sha, d);
    const o = repo.readObject(sha);
    if (o?.type === 'commit') for (const p of repo.parseCommit(o.data).parents) if (!seen.has(p)) { seen.add(p); queue.push({ sha: p, d: d + 1 }); }
  }
  // BFS from a; first hit in dist wins
  const seenA = new Set<string>();
  const qA = [a];
  while (qA.length) {
    const cur = qA.shift()!;
    if (dist.has(cur)) return cur;
    if (seenA.has(cur)) continue;
    seenA.add(cur);
    const o = repo.readObject(cur);
    if (o?.type === 'commit') for (const p of repo.parseCommit(o.data).parents) qA.push(p);
  }
  return null;
}
