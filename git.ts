// git.ts — smart HTTP: upload-pack (protocol v2) and receive-pack (v0).
// Pack parsing and building live here too, so refs and objects stay consistent with the store.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Repo } from './store.ts';

export const pkt = (s: string | Buffer) => {
  const body = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8');
  const len = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(len, 'ascii'), body]);
};
export const flush = () => Buffer.from('0000', 'ascii');

// ── pack parsing ──────────────────────────────────────────────
interface PackEntry { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }

/** The number of bytes of zlib-compressed data starting at `offset`. */
function zlibStreamLength(pack: Buffer, offset: number, _sizeHint: number): number {
  const chunk = pack.subarray(offset);
  const works = (n: number) => {
    try { inflateSync(chunk.subarray(0, n)); return true; }
    catch { return false; }
  };
  let lo = 8, hi = Math.min(chunk.length, 64);
  while (!works(hi)) {
    if (hi >= chunk.length) break;
    const next = Math.min(chunk.length, hi * 2 + 32);
    lo = hi;           // hi was infeasible, so the answer is past it
    hi = next;
  }
  if (works(lo)) return lo; // inflated in the first window already
  let a = lo, b = hi;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (works(mid)) b = mid; else a = mid + 1;
  }
  return a;
}

export function parsePack(repo: Repo, pack: Buffer): PackEntry[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  const count = pack.readUInt32BE(8);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  let offset = 12;
  const raw: { type: number; size: number; data: Buffer; offset: number; baseSha?: string; deltaBaseAt?: number }[] = [];
  for (let i = 0; i < count; i++) {
    const start = offset;
    let b = pack[offset];
    const type = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    offset++;
    while (b & 0x80) {
      b = pack[offset++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    if (type === 6) {
      let rel = 0, c = pack[offset++];
      rel = c & 0x7f;
      while (c & 0x80) { c = pack[offset++]; rel = ((rel + 1) << 7) | (c & 0x7f); }
      const streamLen = zlibStreamLength(pack, offset, size);
      const data = inflateSync(pack.subarray(offset, offset + streamLen));
      raw.push({ type: 6, size, data, offset: start, deltaBaseAt: start - rel });
      offset += streamLen;
      continue;
    }
    if (type === 7) {
      const baseSha = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const streamLen = zlibStreamLength(pack, offset, size);
      const data = inflateSync(pack.subarray(offset, offset + streamLen));
      raw.push({ type: 7, size, data, offset: start, baseSha });
      offset += streamLen;
      continue;
    }
    const streamLen = zlibStreamLength(pack, offset, size);
    raw.push({ type, size, data: inflateSync(pack.subarray(offset, offset + streamLen)), offset: start });
    offset += streamLen;
  }
  const resolved = new Map<string, Buffer>();
  const shaOf = (type: string, data: Buffer) =>
    createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
  const entries: PackEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    let payload: Buffer;
    let typeName: PackEntry['type'];
    if (r.type === 6) {
      const base = raw.find((q) => q.offset === r.deltaBaseAt);
      const baseBuf = base ? resolved.get(shaOf(typeNameOf(base.type), base.data)) : null;
      if (!baseBuf) throw new Error('ofs_delta base missing');
      payload = applyDelta(baseBuf, r.data);
      typeName = typeNameOf(base.type) as PackEntry['type'];
    } else if (r.type === 7) {
      const baseBuf =
        resolved.get(r.baseSha!) ??
        repo.readObject(r.baseSha!)?.data ??
        null;
      if (!baseBuf) throw new Error('ref_delta base missing');
      payload = applyDelta(baseBuf, r.data);
      typeName = 'blob';
    } else {
      payload = r.data;
      typeName = typeNameOf(r.type);
    }
    const sha = shaOf(typeName, payload);
    resolved.set(sha, payload);
    entries.push({ type: typeName, data: payload });
  }
  return entries;
}
const typeNameOf = (t: number): PackEntry['type'] =>
  t === 1 ? 'commit' : t === 2 ? 'tree' : t === 3 ? 'blob' : 'tag';

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
    parts.push(deflateSync(e.data));
  }
  const pack = Buffer.concat(parts);
  const trailer = createHash('sha1').update(pack).digest();
  return Buffer.concat([pack, trailer]);
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
export function reachable(repo: Repo, tips: string[], depth?: number): { type: string; data: Buffer }[] {
  const out = new Map<string, { type: string; data: Buffer }>();
  const visitCommit = (sha: string, level: number) => {
    if (out.has(sha)) return;
    const obj = repo.readObject(sha);
    if (!obj || obj.type !== 'commit') return;
    out.set(sha, { type: 'commit', data: obj.data });
    const commit = repo.parseCommit(obj.data);
    for (const e of repo.readTree(commit.tree)) visitTree(e);
    if (depth === undefined || level + 1 < depth) {
      for (const p of commit.parents) visitCommit(p, level + 1);
    }
  };
  const visitTree = (entry: { mode: string; name: string; sha: string }) => {
    const obj = repo.readObject(entry.sha);
    if (!obj || out.has(entry.sha)) return;
    out.set(entry.sha, { type: obj.type, data: obj.data });
    if (obj.type === 'tree') for (const e of repo.readTree(entry.sha)) visitTree(e);
  };
  for (const t of tips) visitCommit(t, 0);
  return [...out.values()];
}

/** Wrap raw payload chunks in side-band-64k band 1 frames. */
export function sideband(chunks: Buffer[]): Buffer {
  const out: Buffer[] = [];
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    const MAX = 65516;
    for (let i = 0; i < chunk.length; i += MAX) {
      const piece = chunk.subarray(i, Math.min(i + MAX, chunk.length));
      out.push(pkt(Buffer.concat([Buffer.from([1]), piece])));
    }
  }
  return Buffer.concat([...out, flush()]);
}
