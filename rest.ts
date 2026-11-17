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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
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
const qn = (value: string | null | undefined) => value ?? '';

const repoOr404 = (name: string, owner: string): Repo => {
  const repo = getRepo(name);
  if (!repo || repo.fullName.split('/')[0].toLowerCase() !== owner.toLowerCase()) throw new HttpError(404, 'Not Found');
  return repo;
};

const apiOrigin = (req: IncomingMessage): string => {
  const host = (req.headers.host ?? 'entry').toString();
  return `http://${host}`;
};

/** GitHub's contents URL for a file on a branch. */
const contentUrl = (repo: Repo, path: string) => `https://github.example/${repo.fullName}/blob/${repo.defaultBranch}/${path}`;

export async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, bodyBuf: Buffer): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const rest = path.slice('/api/v3'.length);
  const origin = apiOrigin(req);

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
    const all = [...allRepos().values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const start = (page - 1) * perPage;
    const slice = all.slice(start, start + perPage);
    const headers: Record<string, string> = {};
    if (start + perPage < all.length) {
      headers.link = `<${origin}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next"`;
    }
    json(res, 200, slice.map((r) => r.repoJson()), headers);
    return true;
  }
  if (method === 'POST' && rest === '/user/repos') {
    const body = parseJson(bodyBuf);
    if (!body.name || typeof body.name !== 'string') throw new HttpError(422, 'name is required');
    if (getRepo(body.name)) {
      throw new HttpError(422, 'Repository creation failed.', {
        message: 'Repository creation failed.',
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      });
    }
    const repo = ensureRepo(body.name);
    if (body.description !== undefined) repo.description = String(body.description ?? '');
    if (body.private !== undefined) repo.private_ = Boolean(body.private);
    if (typeof body.default_branch === 'string' && body.default_branch) repo.defaultBranch = body.default_branch;
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
        if (body.private !== undefined) repo.private_ = Boolean(body.private);
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
    const originUrl = (p: string) => `https://github.example/api/v3/repos/${repo.fullName}/${p}`;

    // ── git refs ───────────────────────────────────────────────
    if (sub === '/git/refs' && method === 'POST') {
      const body = parseJson(bodyBuf);
      if (!body.ref || !body.sha) throw new HttpError(422, 'ref and sha are required');
      const ref = String(body.ref);
      const sha = String(body.sha).toLowerCase();
      if (!repo.readObject(sha)) throw new HttpError(422, `Object does not exist: ${sha}`);
      if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      json(res, 201, { ref, node_id: `REF_${ref}`, url: originUrl(`git/${ref}`), object: { sha, type: 'commit', url: originUrl(`git/commits/${sha}`) } });
      return true;
    }
    const oneRef = sub.match(/^\/git\/refs?\/(.+)$/);
    if (oneRef && method === 'GET') {
      const ref = oneRef[1];
      const sha = repo.refs.get(ref);
      if (!sha) throw new HttpError(404, 'Not Found');
      json(res, 200, { ref, node_id: `REF_${ref}`, object: { sha, type: 'commit', url: originUrl(`git/commits/${sha}`) } });
      return true;
    }

    // ── branches ───────────────────────────────────────────────
    if (sub === '/branches' && method === 'GET') {
      const list = [...repo.refs.entries()]
        .filter(([r]) => r.startsWith('refs/heads/'))
        .map(([r, sha]) => ({ name: r.slice('refs/heads/'.length), commit: { sha, url: originUrl(`commits/${sha}`) }, protected: false }));
      json(res, 200, list);
      return true;
    }
    const oneBranch = sub.match(/^\/branches\/(.+)$/);
    if (oneBranch && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${oneBranch[1]}`);
      if (!sha) throw new HttpError(404, 'Branch not found');
      json(res, 200, { name: oneBranch[1], commit: { sha, url: originUrl(`commits/${sha}`) }, protected: false });
      return true;
    }

    // ── commits ────────────────────────────────────────────────
    if (sub === '/commits' && method === 'GET') {
      const wanted = qn(url.searchParams.get('sha')) || repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${wanted}`) ?? repo.refs.get(wanted) ?? (repo.readObject(wanted) ? wanted : null);
      if (!tip) throw new HttpError(404, 'Not Found');
      const list = repo.commitsFrom(tip).map((sha) => {
        const info = repo.parseCommit(repo.readObject(sha)!.data);
        return {
          sha,
          node_id: `C_${sha}`,
          commit: {
            message: info.message,
            author: { name: 'Shop', email: 'shop@localhost', date: repo.commitDate(sha) },
            committer: { name: 'Shop', email: 'shop@localhost', date: repo.commitDate(sha) },
          },
          parents: info.parents.map((p) => ({ sha: p })),
        };
      });
      json(res, 200, list);
      return true;
    }
    const oneCommit = sub.match(/^\/commits\/([0-9a-f]{40})$/i);
    if (oneCommit && method === 'GET') {
      const sha = oneCommit[1].toLowerCase();
      const obj = repo.readObject(sha);
      if (!obj || obj.type !== 'commit') throw new HttpError(404, 'Not Found');
      const info = repo.parseCommit(obj.data);
      json(res, 200, { sha, commit: { message: info.message, author: { name: 'Shop', email: 'shop@localhost', date: repo.commitDate(sha) } }, parents: info.parents.map((p) => ({ sha: p })) });
      return true;
    }

    // ── contents ───────────────────────────────────────────────
    const contentsMatch = sub.match(/^\/contents(?:\/(.*))?$/);
    if (contentsMatch) {
      const refName = qn(url.searchParams.get('ref')) || qn(url.searchParams.get('branch')) || '';
      let branch = refName || repo.defaultBranch;
      // PUT/DELETE take the branch in the body (GitHub's contents route); GET takes ?ref=
      const writeBody = method === 'PUT' || method === 'DELETE' ? parseJson(bodyBuf) : null;
      if (writeBody) {
        const wanted = typeof writeBody.branch === 'string' ? writeBody.branch : '';
        branch = wanted || repo.defaultBranch;
      }
      const head = repo.refs.get(`refs/heads/${branch}`) ?? null;
      const files = repo.filesAt(head);
      const rawPath = contentsMatch[1] ? decodeURIComponent(contentsMatch[1]) : '';
      const filePath = rawPath.replace(/\/+$/, '');

      if (method === 'GET' && filePath === '') {
        json(res, 200, [...files.entries()].map(([p, f]) => ({
          type: 'file', name: p.split('/').pop(), path: p, sha: f.sha,
          size: repo.readObject(f.sha)?.data.length ?? 0,
          url: originUrl(`contents/${p}`), html_url: contentUrl(repo, p),
        })));
        return true;
      }
      const existing = files.get(filePath) ?? null;

      if (method === 'GET') {
        if (existing) {
          const blob = repo.readObject(existing.sha)!;
          json(res, 200, {
            type: 'file',
            name: filePath.split('/').pop(),
            path: filePath,
            sha: existing.sha,
            encoding: 'base64',
            content: blob.data.toString('base64'),
            size: blob.data.length,
            url: originUrl(`contents/${filePath}`),
            html_url: contentUrl(repo, filePath),
          });
          return true;
        }
        // a directory: every file under this prefix, one level deep
        const prefix = `${filePath}/`;
        const nested = [...files.entries()].filter(([p]) => p.startsWith(prefix));
        if (nested.length === 0) throw new HttpError(404, 'Not Found');
        json(res, 200, nested.map(([p, f]) => ({
          type: 'file', name: p.slice(prefix.length), path: p, sha: f.sha,
          size: repo.readObject(f.sha)?.data.length ?? 0,
          url: originUrl(`contents/${p}`), html_url: contentUrl(repo, p),
        })));
        return true;
      }

      if (method === 'PUT') {
        const body = writeBody ?? {};
        const message = typeof body.message === 'string' && body.message ? body.message : 'Update file';
        if (typeof body.content !== 'string') throw new HttpError(422, 'content is required');
        const content = Buffer.from(body.content, 'base64').toString('utf8');
        if (body.sha !== undefined && !existing) throw new HttpError(409, 'sha does not match the current file');
        if (body.sha !== undefined && existing && String(body.sha).toLowerCase() !== existing.sha) throw new HttpError(409, 'sha does not match the current file');
        const wasUpdate = Boolean(existing);
        const newCommit = repo.commitFile(branch, filePath, content, message);
        const sha = repo.filesAt(newCommit).get(filePath)!.sha;
        json(res, wasUpdate ? 200 : 201, {
          content: {
            name: filePath.split('/').pop(),
            path: filePath,
            sha,
            size: content.length,
            encoding: 'base64',
            content: Buffer.from(content, 'utf8').toString('base64'),
            url: originUrl(`contents/${filePath}`),
            html_url: contentUrl(repo, filePath),
          },
          commit: { sha: newCommit, message, url: originUrl(`git/commits/${newCommit}`) },
        });
        return true;
      }
      if (method === 'DELETE') {
        const body = writeBody ?? {};
        const message = typeof body.message === 'string' && body.message ? body.message : 'Delete file';
        if (!existing) throw new HttpError(404, 'Not Found');
        if (body.sha !== undefined && String(body.sha).toLowerCase() !== existing.sha) throw new HttpError(409, 'sha does not match the current file');
        const newCommit = repo.commitFile(branch, filePath, null, message);
        json(res, 200, { commit: { sha: newCommit, message } });
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
          throw new HttpError(422, 'Validation Failed', {
            message: 'Validation Failed',
            errors: [{ resource: 'Issue', field: 'labels', code: 'invalid', message: `label '${label}' does not exist` }],
          });
        }
      }
      const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const issue = {
        id: newId(), number: ++repo.issueSeq, title: body.title, body: String(body.body ?? ''),
        state: 'open' as const, labels: wanted, user: OWNER, created_at: stamp, updated_at: stamp,
      };
      repo.issues.push(issue);
      json(res, 201, repo.issueJson(issue));
      return true;
    }
    if (method === 'GET' && sub === '/issues') {
      const state = qn(url.searchParams.get('state')) || 'open';
      const sort = qn(url.searchParams.get('sort')) || 'created';
      const direction = qn(url.searchParams.get('direction')) || 'desc';
      const perPage = Math.max(1, Math.min(100, Number(qn(url.searchParams.get('per_page') ?? '30')) || 30));
      const page = Math.max(1, Number(qn(url.searchParams.get('page') ?? '1')) || 1);
      const labels = qn(url.searchParams.get('labels')).split(',').filter(Boolean);
      let list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
      if (labels.length) list = list.filter((i) => labels.every((l) => i.labels.includes(l)));
      const key = sort === 'updated' ? 'updated_at' : 'created_at';
      list = [...list].sort((a, b) => {
        const cmp = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : a.number - b.number;
        return direction === 'asc' ? cmp : -cmp;
      });
      const slice = list.slice((page - 1) * perPage, page * perPage);
      json(res, 200, slice.map((i) => repo.issueJson(i)));
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
    if (issueComments) {
      const number = Number(issueComments[1]);
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) throw new HttpError(404, 'Not Found');
      if (method === 'GET') {
        json(res, 200, repo.comments.filter((c) => c.issueNumber === number).map((c) => ({
          id: c.id, node_id: `IC_${c.id}`, body: c.body,
          user: { login: c.user, id: OWNER_ID, node_id: `U_${c.user}` },
          created_at: c.created_at, updated_at: c.created_at,
          issue_url: `https://github.example/api/v3/repos/${repo.fullName}/issues/${number}`,
        })));
        return true;
      }
      if (method === 'POST') {
        const body = parseJson(bodyBuf);
        const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        const comment = { id: newId(), issueNumber: number, body: String(body.body ?? ''), user: OWNER, created_at: stamp };
        repo.comments.push(comment);
        issue.updated_at = stamp;
        json(res, 201, {
          id: comment.id, node_id: `IC_${comment.id}`, body: comment.body,
          user: { login: OWNER, id: OWNER_ID }, created_at: stamp, updated_at: stamp,
          issue_url: `https://github.example/api/v3/repos/${repo.fullName}/issues/${number}`,
        });
        return true;
      }
    }

    // ── pull requests ──────────────────────────────────────────
    if (method === 'POST' && sub === '/pulls') {
      const body = parseJson(bodyBuf);
      if (!body.title || !body.head || !body.base) throw new HttpError(422, 'title, head and base are required');
      if (!repo.refs.has(`refs/heads/${body.head}`)) throw new HttpError(422, `head branch '${body.head}' does not exist`);
      const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const pr = {
        id: newId(), number: ++repo.prSeq, title: String(body.title), body: String(body.body ?? ''),
        state: 'open' as const, merged: false, head: String(body.head), base: String(body.base),
        user: OWNER, created_at: stamp, updated_at: stamp,
        merge_commit_sha: null as string | null,
      };
      repo.prs.push(pr);
      json(res, 201, repo.prJson(pr));
      return true;
    }
    if (method === 'GET' && sub === '/pulls') {
      const state = qn(url.searchParams.get('state')) || 'open';
      const perPage = Math.max(1, Math.min(100, Number(qn(url.searchParams.get('per_page') ?? '30')) || 30));
      const page = Math.max(1, Number(qn(url.searchParams.get('page') ?? '1')) || 1);
      const list = repo.prs
        .filter((p) => (state === 'all' ? true : state === 'closed' ? p.state === 'closed' : p.state === 'open' && !p.merged))
        .sort((a, b) => b.number - a.number)
        .slice((page - 1) * perPage, page * perPage);
      json(res, 200, list.map((p) => repo.prJson(p)));
      return true;
    }
    const prMatch = sub.match(/^\/pulls\/(\d+)(\/merge)?$/);
    if (prMatch) {
      const number = Number(prMatch[1]);
      const isMerge = Boolean(prMatch[2]);
      const pr = repo.prs.find((p) => p.number === number);
      if (!pr) throw new HttpError(404, 'Not Found');
      if (isMerge && method === 'PUT') {
        if (pr.merged) { json(res, 405, { message: 'Pull Request is not mergeable' }); return true; }
        const sha = squashMerge(repo, pr);
        if (sha === null) { json(res, 405, { message: 'Pull Request is not mergeable' }); return true; }
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
      json(res, 200, diffFiles(repo, pr));
      return true;
    }
  }
  return false;
}

/** The files a pull request changes: one row per differing path between base and head. */
export function diffFiles(repo: Repo, pr: { head: string; base: string }) {
  const baseRef = repo.refs.get(`refs/heads/${pr.base}`) ?? null;
  const headRef = repo.refs.get(`refs/heads/${pr.head}`) ?? null;
  const baseFiles = repo.filesAt(baseRef);
  const headFiles = repo.filesAt(headRef);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const rows: { filename: string; status: string; additions: number; deletions: number; changes: number; blob_url: string }[] = [];
  for (const p of [...paths].sort()) {
    const before = baseFiles.get(p);
    const after = headFiles.get(p);
    if (before?.sha === after?.sha) continue;
    const beforeText = before ? repo.readObject(before.sha)?.data.toString('utf8') ?? '' : '';
    const afterText = after ? repo.readObject(after.sha)?.data.toString('utf8') ?? '' : '';
    const beforeLines = beforeText === '' ? [] : beforeText.split('\n');
    const afterLines = afterText === '' ? [] : afterText.split('\n');
    const common = Math.min(beforeLines.length, afterLines.length);
    let same = 0;
    for (let i = 0; i < common; i += 1) if (beforeLines[i] === afterLines[i]) same += 1;
    const additions = Math.max(0, afterLines.length - same);
    const deletions = Math.max(0, beforeLines.length - same);
    rows.push({
      filename: p,
      status: !before ? 'added' : !after ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `https://github.example/${repo.fullName}/blob/${pr.head}/${p}`,
    });
  }
  return rows;
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
  if (stored) {
    stored.state = 'closed';
    stored.merged = true;
    stored.merge_commit_sha = sha;
    stored.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  repo.pushedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return sha;
}

export function findMergeBase(repo: Repo, a: string, b: string | null): string | null {
  if (!b) return a;
  const dist = new Map<string, number>();
  const queue: { sha: string; d: number }[] = [{ sha: b, d: 0 }];
  while (queue.length) {
    const { sha, d } = queue.shift()!;
    if (dist.has(sha) && dist.get(sha)! <= d) continue;
    dist.set(sha, d);
    const o = repo.readObject(sha);
    if (o?.type === 'commit') for (const p of repo.parseCommit(o.data).parents) queue.push({ sha: p, d: d + 1 });
  }
  const seen = new Set<string>();
  const qA = [a];
  while (qA.length) {
    const cur = qA.shift()!;
    if (dist.has(cur)) return cur;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const o = repo.readObject(cur);
    if (o?.type === 'commit') for (const p of repo.parseCommit(o.data).parents) qA.push(p);
  }
  return null;
}
