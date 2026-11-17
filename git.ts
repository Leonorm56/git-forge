// git.ts — smart HTTP: upload-pack (protocol v2) and receive-pack (v0).
// Pack parsing and building live here too, so refs and objects stay consistent with the store.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Repo } from './store.ts';

export const ZERO = '0'.repeat(40);

export const pkt = (s: string | Buffer): Buffer => {
  const body = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8');
  const len = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(len, 'ascii'), body]);
};
export const flush = (): Buffer => Buffer.from('0000', 'ascii');
export const delim = (): Buffer => Buffer.from('0001', 'ascii');

// ── pack parsing ──────────────────────────────────────────────
interface PackEntry { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }

/** Inflate one zlib stream and report how many input bytes it consumed. */
function inflateAt(pack: Buffer, offset: number): { data: Buffer; used: number } {
  const info = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const used = info.engine?.bytesWritten;
  if (!Number.isFinite(used) || used <= 0) throw new Error('could not measure a zlib stream');
  return { data: info.buffer, used };
}

export function parsePack(repo: Repo, pack: Buffer): PackEntry[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  const count = pack.readUInt32BE(8);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  let offset = 12;
  const raw: { type: number; data: Buffer; offset: number; deltaBaseAt?: number; baseSha?: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let b = pack[offset];
    const type = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    offset += 1;
    while (b & 0x80) {
      b = pack[offset++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    if (type === 6) {
      let c = pack[offset++];
      let rel = c & 0x7f;
      while (c & 0x80) {
        c = pack[offset++];
        rel = ((rel + 1) << 7) | (c & 0x7f);
      }
      const { data, used } = inflateAt(pack, offset);
      raw.push({ type: 6, data, offset: start, deltaBaseAt: start - rel });
      offset += used;
      continue;
    }
    if (type === 7) {
      const baseSha = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data, used } = inflateAt(pack, offset);
      raw.push({ type: 7, data, offset: start, baseSha });
      offset += used;
      continue;
    }
    const { data, used } = inflateAt(pack, offset);
    raw.push({ type, data, offset: start });
    offset += used;
  }

  const typeName = (t: number): PackEntry['type'] =>
    t === 1 ? 'commit' : t === 2 ? 'tree' : t === 3 ? 'blob' : t === 4 ? 'tag' : 'blob';
  const shaOf = (type: string, data: Buffer) =>
    createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');

  const resolved = new Map<string, { type: PackEntry['type']; data: Buffer }>();
  const byOffset = new Map<number, { type: PackEntry['type']; data: Buffer }>();
  const entries: PackEntry[] = [];
  for (const r of raw) {
    let payload: Buffer;
    let kind: PackEntry['type'];
    if (r.type === 6) {
      const base = r.deltaBaseAt !== undefined ? byOffset.get(r.deltaBaseAt) : undefined;
      if (!base) throw new Error('ofs_delta base missing');
      payload = applyDelta(base.data, r.data);
      kind = base.type;
    } else if (r.type === 7) {
      const known = r.baseSha !== undefined ? resolved.get(r.baseSha) : undefined;
      const stored = r.baseSha !== undefined ? repo.readObject(r.baseSha) : null;
      const base = known ?? (stored ? { type: stored.type as PackEntry['type'], data: stored.data } : null);
      if (!base) throw new Error('ref_delta base missing');
      payload = applyDelta(base.data, r.data);
      kind = base.type;
    } else {
      payload = r.data;
      kind = typeName(r.type);
    }
    const object = { type: kind, data: payload };
    resolved.set(shaOf(kind, payload), object);
    byOffset.set(r.offset, object);
    entries.push({ type: kind, data: payload });
  }
  return entries;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = () => {
    let size = 0, shift = 0, b = 0;
    do { b = delta[i++]; size |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    return size;
  };
  readVarint(); // base size (unverified)
  const resultSize = readVarint();
  const out: Buffer[] = [];
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let cpOff = 0, cpSize = 0;
      if (op & 0x01) cpOff |= delta[i++];
      if (op & 0x02) cpOff |= delta[i++] << 8;
      if (op & 0x04) cpOff |= delta[i++] << 16;
      if (op & 0x08) cpOff |= delta[i++] << 24;
      if (op & 0x10) cpSize |= delta[i++];
      if (op & 0x20) cpSize |= delta[i++] << 8;
      if (op & 0x40) cpSize |= delta[i++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
    } else if (op !== 0) {
      out.push(delta.subarray(i, i + op));
      i += op;
    } else {
      throw new Error('invalid delta opcode');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

// ── pack building ─────────────────────────────────────────────
export function buildPack(entries: { type: string; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const parts: Buffer[] = [header];
  for (const e of entries) {
    parts.push(encodeTypeAndSize(typeNum(e.type), e.data.length));
    parts.push(deflateSync(e.data, { level: 1 }));
  }
  const pack = Buffer.concat(parts);
  return Buffer.concat([pack, createHash('sha1').update(pack).digest()]);
}
const typeNum = (t: string) => (t === 'commit' ? 1 : t === 'tree' ? 2 : t === 'blob' ? 3 : 4);
function encodeTypeAndSize(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) { bytes.push(b | 0x80); b = size & 0x7f; size >>= 7; }
  bytes.push(b);
  return Buffer.from(bytes);
}

// ── reachable object walk ─────────────────────────────────────
export interface WalkResult {
  entries: { type: string; data: Buffer }[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Every object reachable from `tips`, minus everything reachable from `haves`.
 * `depth` limits commit generations; `shallowBoundaries` are commits whose parents the client
 * does not have (they end the walk). The returned shallow/unshallow lines move the boundary.
 */
export function walk(
  repo: Repo,
  tips: string[],
  options: { haves?: string[]; depth?: number; shallowBoundaries?: string[] } = {},
): WalkResult {
  const boundaries = new Set(options.shallowBoundaries ?? []);
  const depth = options.depth;

  // A shallow boundary names a commit the client holds but whose parents it does not: the closure
  // walk must stop there, and the commit itself must never be re-sent.
  const haveSet = new Set<string>();
  const visitHave = (sha: string) => {
    if (haveSet.has(sha)) return;
    const obj = repo.readObject(sha);
    if (!obj) return;
    haveSet.add(sha);
    if (obj.type === 'commit') {
      if (boundaries.has(sha)) return;
      const commit = repo.parseCommit(obj.data);
      visitHave(commit.tree);
      for (const p of commit.parents) visitHave(p);
    } else if (obj.type === 'tree') {
      for (const e of repo.readTree(sha)) visitHave(e.sha);
    } else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) visitHave(target);
    }
  };
  for (const h of options.haves ?? []) visitHave(h);

  const included = new Map<string, { type: string; data: Buffer }>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const visitedCommits = new Set<string>();
  const held = (sha: string) => haveSet.has(sha) || boundaries.has(sha);

  const addObject = (sha: string) => {
    if (included.has(sha) || held(sha)) return;
    const obj = repo.readObject(sha);
    if (!obj) return;
    included.set(sha, { type: obj.type, data: obj.data });
  };
  const addClosure = (sha: string) => {
    if (included.has(sha) || held(sha)) return;
    const obj = repo.readObject(sha);
    if (!obj) return;
    included.set(sha, { type: obj.type, data: obj.data });
    if (obj.type === 'tree') for (const entry of repo.readTree(sha)) addClosure(entry.sha);
    else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) addClosure(target);
    }
  };
  const visitWant = (sha: string) => {
    const obj = repo.readObject(sha);
    if (!obj) return;
    if (obj.type === 'tag') {
      addObject(sha);
      const target = parseTagTarget(obj.data);
      if (target) visitWant(target);
      return;
    }
    if (obj.type === 'commit') {
      visitCommit(sha, 0);
      return;
    }
    addClosure(sha);
  };
  const visitCommit = (sha: string, level: number) => {
    if (visitedCommits.has(sha)) return;
    const obj = repo.readObject(sha);
    if (!obj || obj.type !== 'commit') return;
    visitedCommits.add(sha);
    const commit = repo.parseCommit(obj.data);
    const boundary = boundaries.has(sha);
    // a non-boundary have is held in full: the client has its tree and every ancestor
    if (haveSet.has(sha) && !boundary) return;
    const atLimit = depth !== undefined && level + 1 >= depth;
    if (!boundary) {
      addObject(sha);
      addClosure(commit.tree);
    }
    const parents = commit.parents;
    if (atLimit) {
      if (parents.length > 0) shallow.push(sha);
      return;
    }
    // this boundary commit now gets its parents: it is no longer shallow
    if (boundary) unshallow.push(sha);
    for (const p of parents) visitCommit(p, level + 1);
  };
  for (const tip of tips) visitWant(tip);
  return {
    entries: [...included.values()],
    shallow: [...new Set(shallow)],
    unshallow: [...new Set(unshallow)],
  };
}

function parseTagTarget(data: Buffer): string | null {
  const match = /^object ([0-9a-f]{40})$/m.exec(data.toString('utf8'));
  return match ? match[1] : null;
}

/** Wrap raw payload chunks in side-band-64k band 1 frames, one flush at the end. */
export function sideband(chunks: Buffer[]): Buffer {
  const out: Buffer[] = [];
  const MAX = 65515;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += MAX) {
      const piece = chunk.subarray(i, Math.min(i + MAX, chunk.length));
      out.push(pkt(Buffer.concat([Buffer.from([1]), piece])));
    }
  }
  out.push(flush());
  return Buffer.concat(out);
}
