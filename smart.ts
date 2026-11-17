// smart.ts — git smart HTTP endpoints: info/refs, git-upload-pack, git-receive-pack.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { pkt, flush, parsePack, buildPack, reachable, sideband } from './git.ts';
import { OWNER, type Repo } from './store.ts';

const ZERO = '0'.repeat(40);

export function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string) {
  if (service === 'git-upload-pack') {
    if (wantsV2(req)) {
      const body = Buffer.concat([
        Buffer.from('version 2\n', 'utf8'),
        pkt('agent=git/2.43.0\n'),
        pkt('ls-refs\n'),
        pkt('fetch\n'),
        pkt('object-format=sha1\n'),
        pkt('ofs-delta\n'),
        pkt('sideband-all\n'),
        flush(),
      ]);
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-advertisement',
        'cache-control': 'no-cache',
        'x-github-request-id': 'smart-1',
      });
      res.end(body);
      return true;
    }
    // v0 fallback: advertise refs
    const body = advertiseRefs(repo, '# service=git-upload-pack\n', 'upload-pack');
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache', 'x-github-request-id': 'smart-1' });
    res.end(body);
    return true;
  }
  if (service === 'git-receive-pack') {
    const body = advertiseRefs(repo, '# service=git-receive-pack\n', 'receive-pack');
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement', 'cache-control': 'no-cache', 'x-github-request-id': 'smart-1' });
    res.end(body);
    return true;
  }
  res.writeHead(400, { 'content-type': 'text/plain' });
  res.end('unknown service');
  return true;
}

const wantsV2 = (req: IncomingMessage) => (req.headers['git-protocol'] ?? '').toString().includes('version=2');

function advertiseRefs(repo: Repo, preamble: string, kind: 'upload-pack' | 'receive-pack'): Buffer {
  const caps = kind === 'upload-pack'
    ? 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta agent=git/2.43.0'
    : 'report-status side-band-64k ofs-delta delete-refs agent=git/2.43.0';
  const refs = repo.refList();
  const out: Buffer[] = [pkt(preamble)];
  if (refs.length === 0) {
    out.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`)); // an empty repository advertises capabilities only
  } else {
    let first = true;
    for (const [name, sha] of refs) {
      out.push(pkt(`${sha} ${name}${first ? `\0${caps}` : ''}\n`));
      first = false;
    }
  }
  out.push(flush());
  return Buffer.concat(out);
}

// ── upload-pack (protocol v2) ─────────────────────────────────
export function handleUploadPack(body: Buffer, res: ServerResponse, repo: Repo) {
  const wants: string[] = [];
  let deepen = 0;
  let command = '';
  const lines = splitPktLines(body);
  let sawFlush = false;
  for (const line of lines) {
    if (line === null) { sawFlush = true; continue; }
    const text = line.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('command=')) command = text.slice('command='.length).trim();
    else if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('deepen ')) deepen = Number(text.slice(7)) || 0;
  }
  if (command === 'ls-refs') {
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': 'smart-1' });
    const refs = repo.refList();
    const out: Buffer[] = [];
    if (refs.length === 0) {
      // an empty repository: nothing to list
    } else {
      for (const [name, sha] of refs) out.push(pkt(`${sha} ${name}\n`));
    }
    out.push(flush());
    res.end(Buffer.concat(out));
    return;
  }
  if (command !== 'fetch') {
    res.writeHead(400, { 'content-type': 'text/plain', 'x-github-request-id': 'smart-1' });
    res.end('expected command=fetch or command=ls-refs');
    return;
  }
  const depth = deepen > 0 ? deepen : undefined;
  const wantShas = wants.length ? wants : repo.refList().map(([, sha]) => sha);
  const entries = reachable(repo, wantShas, depth);
  const pack = buildPack(entries);
  const wantsSideband = lines.some((l) => l !== null && l.toString('utf8').trim() === 'sideband-all');
  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'x-github-request-id': 'smart-1',
    'cache-control': 'no-cache',
  });
  if (wantsSideband) res.end(Buffer.concat([pkt('packfile\n'), sideband([pack])]));
  else res.end(Buffer.concat([pkt('packfile\n'), pack]));
}

function splitPktLines(body: Buffer): (Buffer | null)[] {
  const out: (Buffer | null)[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const len = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (len === 0) { out.push(null); offset += 4; continue; }
    if (Number.isNaN(len) || len < 4) break;
    out.push(body.subarray(offset + 4, offset + len));
    offset += len;
  }
  return out;
}

// ── receive-pack (v0) ─────────────────────────────────────────
export function handleReceivePack(body: Buffer, res: ServerResponse, repo: Repo) {
  // commands: pkt-line "<old> <new> <ref>\0<caps>" (first line) / "<old> <new> <ref>" ... flush, then PACK data
  let offset = 0;
  const commands: { oldSha: string; newSha: string; ref: string; caps?: string }[] = [];
  while (offset + 4 <= body.length) {
    const len = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (len === 0) { offset += 4; break; }
    const line = body.subarray(offset + 4, offset + len).toString('utf8');
    offset += len;
    const nul = line.indexOf('\0');
    const caps = nul === -1 ? undefined : line.slice(nul + 1);
    const parts = (nul === -1 ? line : line.slice(0, nul)).trim().split(' ');
    if (parts.length === 3) commands.push({ oldSha: parts[0], newSha: parts[1], ref: parts[2], caps });
  }
  const wantsSideband = commands.some((c) => c.caps?.includes('side-band-64k'));
  let report: string[] = [];
  try {
    let packBytes = body.subarray(offset);
    if (wantsSideband && packBytes.length) {
      // with side-band-64k the pack itself arrives as band-1 frames
      const deframed: Buffer[] = [];
      let o = 0;
      while (o + 4 <= packBytes.length) {
        const len = parseInt(packBytes.subarray(o, o + 4).toString('ascii'), 16);
        if (len === 0) { o += 4; continue; }
        const band = packBytes[o + 4];
        const payload = packBytes.subarray(o + 5, o + len);
        if (band === 1) deframed.push(payload);
        o += len;
      }
      packBytes = Buffer.concat(deframed);
    }
    let entries: { type: string; data: Buffer }[] = [];
    if (packBytes.length > 0 && packBytes.subarray(0, 4).toString('ascii') === 'PACK') {
      entries = parsePack(repo, packBytes);
      for (const e of entries) repo.writeObject(e.type, e.data);
    }
    const results: { ref: string; ok: boolean; reason?: string }[] = [];
    for (const cmd of commands) {
      const { oldSha, newSha, ref } = cmd;
      if (!ref.startsWith('refs/')) { results.push({ ref, ok: false, reason: 'invalid ref name' }); continue; }
      if (newSha === ZERO) { repo.refs.delete(ref); results.push({ ref, ok: true }); continue; }
      const existing = repo.refs.get(ref);
      if (existing && existing !== oldSha) { results.push({ ref, ok: false, reason: 'stale info' }); continue; }
      if (existing && oldSha !== ZERO && !repo.ancestorOf(oldSha, newSha) && oldSha !== newSha) {
        results.push({ ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (!existing && oldSha !== ZERO && oldSha !== '') { results.push({ ref, ok: false, reason: 'stale info' }); continue; }
      repo.refs.set(ref, newSha);
      results.push({ ref, ok: true });
    }
    repo.pushedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    report = ['unpack ok\n', ...results.map((r) => (r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`))];
  } catch (err) {
    report = [`unpack ${err instanceof Error ? err.message : 'failed'}\n`];
  }
  const payload = Buffer.concat(report.map(pkt));
  res.writeHead(200, {
    'content-type': wantsSideband ? 'application/x-git-receive-pack-result' : 'application/x-git-receive-pack-result',
    'x-github-request-id': 'smart-1',
  });
  if (wantsSideband) res.end(sideband([payload]));
  else res.end(Buffer.concat([payload, flush()]));
}
