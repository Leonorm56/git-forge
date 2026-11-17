// store.ts — the forge's state: git objects, refs, issues, pull requests, labels.
// Everything is in memory; nothing leaves the process except the responses themselves.

import { createHash } from 'node:crypto';

export const OWNER = process.env.FORGE_OWNER ?? 'shop';
export const OWNER_ID = 101;

const sha1hex = (type: string, data: Buffer): string =>
  createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');

export interface RepoFile { mode: string; sha: string }
export interface CommitInfo { tree: string; parents: string[]; message: string }
export interface Issue {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: string[]; user: string; created_at: string; updated_at: string;
}
export interface Pr {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean; head: string; base: string;
  user: string; created_at: string; updated_at: string; merge_commit_sha: string | null;
}

let nextId = 1000;
export const newId = () => nextId++;
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export class Repo {
  readonly name: string;
  description = '';
  defaultBranch = 'main';
  readonly objects = new Map<string, { type: string; data: Buffer }>();
  readonly refs = new Map<string, string>();
  readonly issues: Issue[] = [];
  readonly prs: Pr[] = [];
  readonly labels: { name: string; color: string; description: string }[] = [];
  issueSeq = 0;
  prSeq = 0;
  createdAt = now();
  updatedAt = this.createdAt;
  pushedAt = this.createdAt;
  nodeId: string;
  private issueIds = new Set<number>();

  constructor(name: string) {
    this.name = name;
    this.nodeId = `R_${name}_${(++nextId).toString(36)}`;
  }

  get fullName() { return `${OWNER}/${this.name}`; }

  // ── object store ─────────────────────────────────────────────
  writeObject(type: string, data: Buffer): string {
    const sha = sha1hex(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }
  readObject(sha: string) { return this.objects.get(sha) ?? null; }
  hasObject(sha: string) { return this.objects.has(sha); }

  putBlob(content: Buffer | string): string {
    return this.writeObject('blob', Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  }

  readTree(sha: string): { mode: string; name: string; sha: string }[] {
    const obj = this.readObject(sha);
    if (!obj || obj.type !== 'tree') return [];
    const entries: { mode: string; name: string; sha: string }[] = [];
    let i = 0;
    const buf = obj.data;
    while (i < buf.length) {
      let sp = i; while (buf[sp] !== 0x20) sp++;
      const mode = buf.subarray(i, sp).toString('ascii');
      let nul = sp + 1;
      while (buf[nul] !== 0x00) nul++;
      const name = buf.subarray(sp + 1, nul).toString('utf8');
      const sha = buf.subarray(nul + 1, nul + 21).toString('hex');
      entries.push({ mode, name, sha });
      i = nul + 21;
    }
    return entries;
  }
  writeTree(entries: { mode: string; name: string; sha: string }[]): string {
    const sorted = [...entries].sort((a, b) => {
      const an = a.mode === '40000' || a.mode === '040000' ? `${a.name}/` : a.name;
      const bn = b.mode === '40000' || b.mode === '040000' ? `${b.name}/` : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const chunks: Buffer[] = [];
    for (const e of sorted) {
      chunks.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      chunks.push(Buffer.from(e.sha, 'hex'));
    }
    return this.writeObject('tree', Buffer.concat(chunks));
  }
  parseCommit(data: Buffer): CommitInfo {
    const text = data.toString('utf8');
    const sep = text.indexOf('\n\n');
    const head = sep === -1 ? text : text.slice(0, sep);
    const message = sep === -1 ? '' : text.slice(sep + 2);
    let tree = ''; const parents: string[] = [];
    for (const line of head.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5);
      else if (line.startsWith('parent ')) parents.push(line.slice(7));
    }
    return { tree, parents, message };
  }
  commitTo(tree: string, parents: string[], message: string, author = `shop <shop@localhost> 1`): string {
    const c = `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${author} +0000\ncommitter ${author} +0000\n\n${message}`;
    return this.writeObject('commit', Buffer.from(c, 'utf8'));
  }

  // ── work tree views ─────────────────────────────────────────
  filesAt(commitSha: string | null): Map<string, RepoFile> {
    const out = new Map<string, RepoFile>();
    if (!commitSha) return out;
    const obj = this.readObject(commitSha);
    if (!obj) return out;
    const tree = this.parseCommit(obj.data).tree;
    const walk = (treeSha: string, prefix: string) => {
      for (const e of this.readTree(treeSha)) {
        if (e.mode === '40000' || e.mode === '040000') walk(e.sha, `${prefix}${e.name}/`);
        else out.set(`${prefix}${e.name}`, { mode: e.mode, sha: e.sha });
      }
    };
    walk(tree, '');
    return out;
  }
  fileAt(files: Map<string, RepoFile>, path: string) { return files.get(path) ?? null; }

  /** Commit a change to `branch`: create/update/delete one path. Returns the new commit sha. */
  commitFile(branch: string, path: string, content: string | null, message: string): string {
    const headSha = this.refs.get(`refs/heads/${branch}`) ?? null;
    const files = this.filesAt(headSha);
    if (content === null) files.delete(path);
    else files.set(path, { mode: '100644', sha: this.putBlob(content) });
    const rootSha = this.writeWorkTree(files);
    const sha = this.commitTo(rootSha, headSha ? [headSha] : [], message);
    this.refs.set(`refs/heads/${branch}`, sha);
    this.pushedAt = now();
    return sha;
  }

  /** Serialize a flat path → blob map into trees and return the root sha. */
  writeWorkTree(files: Map<string, RepoFile>): string {
    // collect every directory that is needed (deepest first)
    const dirs = new Set<string>(['']);
    for (const path of files.keys()) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    const ordered = [...dirs].sort((a, b) => b.length - a.length);
    const built = new Map<string, string>();
    for (const dir of ordered) {
      const prefix = dir ? `${dir}/` : '';
      const childDirs = ordered.filter((d) => built.has(d) && d !== dir && d.startsWith(prefix) && !d.slice(prefix.length).includes('/'));
      const entries: { mode: string; name: string; sha: string }[] = [];
      for (const [path, f] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (rest.includes('/')) continue;
        entries.push({ mode: f.mode, name: rest, sha: f.sha });
      }
      for (const sub of childDirs) {
        entries.push({ mode: '40000', name: sub.slice(prefix.length), sha: built.get(sub)! });
      }
      built.set(dir, this.writeTree(entries));
    }
    return built.get('')!;
  }

  // ── refs ───────────────────────────────────────────────────
  ancestorOf(maybeAncestor: string, ofCommit: string): boolean {
    const want = maybeAncestor;
    const seen = new Set<string>();
    const stack = [ofCommit];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === want) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = this.readObject(cur);
      if (obj?.type === 'commit') for (const p of this.parseCommit(obj.data).parents) stack.push(p);
    }
    return false;
  }
  refList(): [string, string][] {
    return [...this.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  // ── json views ─────────────────────────────────────────────
  repoJson() {
    return {
      id: OWNER_ID,
      node_id: this.nodeId,
      name: this.name,
      full_name: this.fullName,
      private: false,
      owner: { login: OWNER, id: OWNER_ID, node_id: `U_${OWNER}`, avatar_url: '', type: 'User' },
      html_url: `https://github.example/${this.fullName}`,
      description: this.description,
      fork: false,
      url: `https://github.example/api/v3/repos/${this.fullName}`,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
      pushed_at: this.pushedAt,
      homepage: null,
      size: 1,
      stargazers_count: 0,
      watchers_count: 0,
      language: 'TypeScript',
      default_branch: this.defaultBranch,
      open_issues_count: this.issues.filter((i) => i.state === 'open').length,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
      has_pages: false,
      archived: false,
      disabled: false,
      visibility: 'public',
      permissions: { admin: true, push: true, pull: true },
    };
  }
  issueJson(issue: Issue) {
    return {
      id: issue.id,
      node_id: `I_${issue.id}`,
      number: issue.number,
      title: issue.title,
      user: { login: issue.user, id: OWNER_ID, node_id: `U_${issue.user}` },
      labels: issue.labels.map((n) => ({ name: n, id: newId(), node_id: `L_${n}`, color: 'ededed' })),
      state: issue.state,
      body: issue.body,
      repo_url: `https://github.example/api/v3/repos/${this.fullName}/issues/${issue.number}`,
      url: `https://github.example/api/v3/repos/${this.fullName}/issues/${issue.number}`,
      html_url: `https://github.example/${this.fullName}/issues/${issue.number}`,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      comments: 0,
      closed_at: issue.state === 'closed' ? issue.updated_at : null,
    };
  }
  prJson(pr: Pr) {
    return {
      id: pr.id,
      node_id: `PULL_${pr.id}`,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      user: { login: pr.user, id: OWNER_ID, node_id: `U_${pr.user}` },
      state: pr.state,
      merged: pr.merged,
      merge_commit_sha: pr.merge_commit_sha,
      head: { ref: pr.head, sha: this.refs.get(`refs/heads/${pr.head}`) ?? null, repo: this.repoJson() },
      base: { ref: pr.base, sha: this.refs.get(`refs/heads/${pr.base}`) ?? null, repo: this.repoJson() },
      html_url: `https://github.example/${this.fullName}/pull/${pr.number}`,
      url: `https://github.example/api/v3/repos/${this.fullName}/pulls/${pr.number}`,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      merged_at: pr.merged ? pr.updated_at : null,
    };
  }
}

const repos = new Map<string, Repo>();
export const allRepos = () => repos;
export function getRepo(name: string): Repo | null { return repos.get(name.toLowerCase()) ?? null; }
export function ensureRepo(name: string): Repo {
  const key = name.toLowerCase();
  let r = repos.get(key);
  if (!r) { r = new Repo(name); repos.set(key, r); }
  return r;
}
export function deleteRepo(name: string) { repos.delete(name.toLowerCase()); }
