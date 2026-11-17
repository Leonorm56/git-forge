// smart.ts — git smart HTTP: info/refs advertisement, upload-pack (protocol v2) and
// receive-pack (v0). Pack parsing/building and the object walk live in git.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildPack, delim, flush, parsePack, pkt, sideband, walk, ZERO } from './git.ts';
import type { Repo } from './store.ts';

const AGENT = 'git/2.43.0';

const contentType = (service: string, kind: 'advertisement' | 'result') =>
  `application/x-${service}-${kind}`;

const wantsV2 = (req: IncomingMessage): boolean =>
  (req.headers['git-protocol'] ?? '').toString().includes('version=2');

const headTarget = (repo: Repo): string => `refs/heads/${repo.defaultBranch}`;
const headTip = (repo: Repo): string | null => repo.refs.get(headTarget(repo)) ?? null;

/** Advertise refs (v0) with the service preamble, or the v2 capability list. */
export function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string): boolean {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('unknown service');
    return true;
  }
  if (service === 'git-upload-pack' && wantsV2(req)) {
    const body = Buffer.concat([
      pkt('version 2\n'),
      pkt(`agent=${AGENT}\n`),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow\n'),
      pkt('object-format=sha1\n'),
      flush(),
    ]);
    res.writeHead(200, {
      'content-type': contentType(service, 'advertisement'),
      'cache-control': 'no-cache',
    });
    res.end(body);
    return true;
  }
  const body = advertiseV0(repo, service);
  res.writeHead(200, {
    'content-type': contentType(service, 'advertisement'),
    'cache-control': 'no-cache',
  });
  res.end(body);
  return true;
}

function advertiseV0(repo: Repo, service: string): Buffer {
  const caps = service === 'git-upload-pack'
    ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress agent=${AGENT} symref=HEAD:${headTarget(repo)}`
    : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const out: Buffer[] = [pkt(`# service=${service}\n`), flush()];
  const entries: [string, string][] = [];
  const head = headTip(repo);
  if (head) entries.push(['HEAD', head]);
  for (const [name, sha] of repo.refList()) entries.push([name, sha]);
  if (entries.length === 0) {
    out.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    entries.forEach(([name, sha], index) => {
      out.push(pkt(`${sha} ${name}${index === 0 ? `\0${caps}` : ''}\n`));
    });
  }
  out.push(flush());
  return Buffer.concat(out);
}

// ── request decoding ─────────────────────────────────────────────────────────

interface SmartRequest {
  sections: string[][];
}

const decodeRequest = (body: Buffer): SmartRequest => {
  const sections: string[][] = [[]];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      // flush-packet: the request is over
      break;
    }
    if (length === 1) {
      sections.push([]);
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) break;
    const text = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    sections[sections.length - 1].push(text);
    offset += length;
  }
  return { sections };
};

const allLines = (request: SmartRequest): string[] => request.sections.flat();

/** Peel an annotated tag down to the object it finally names. */
const peel = (repo: Repo, sha: string): string => {
  let current = sha;
  for (let guard = 0; guard < 16; guard += 1) {
    const obj = repo.readObject(current);
    if (!obj || obj.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (!match) return current;
    current = match[1];
  }
  return current;
};

// ── upload-pack ───────────────────────────────────────────────────────────────

export function handleUploadPack(body: Buffer, res: ServerResponse, repo: Repo): void {
  const request = decodeRequest(body);
  const lines = allLines(request);
  const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length).trim() ?? '';

  if (command === 'ls-refs') {
    const wantsPeel = lines.includes('peel');
    const wantsSymrefs = lines.includes('symrefs');
    const wantsUnborn = lines.includes('unborn');
    const prefixes = lines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
    const keep = (name: string) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    const out: Buffer[] = [];
    const headName = headTarget(repo);
    const head = headTip(repo);
    if (keep('HEAD')) {
      if (head) {
        out.push(pkt(`${head} HEAD${wantsSymrefs ? ` symref-target:${headName}` : ''}\n`));
      } else if (wantsUnborn && repo.refList().length === 0) {
        out.push(pkt(`unborn HEAD${wantsSymrefs ? ` symref-target:${headName}` : ''}\n`));
      }
    }
    for (const [name, sha] of repo.refList()) {
      if (!keep(name)) continue;
      let line = `${sha} ${name}`;
      if (wantsPeel && name.startsWith('refs/tags/')) {
        const obj = repo.readObject(sha);
        if (obj?.type === 'tag') line += ` peeled:${peel(repo, sha)}`;
      }
      out.push(pkt(`${line}\n`));
    }
    out.push(flush());
    res.writeHead(200, { 'content-type': contentType('git-upload-pack', 'result'), 'cache-control': 'no-cache' });
    res.end(Buffer.concat(out));
    return;
  }

  if (command !== 'fetch') {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('unsupported command');
    return;
  }

  const wants = [...new Set(lines.filter((l) => l.startsWith('want ')).map((l) => l.slice(5).trim()))];
  const haves = lines.filter((l) => l.startsWith('have ')).map((l) => l.slice(5).trim());
  const boundaries = lines.filter((l) => l.startsWith('shallow ')).map((l) => l.slice(8).trim());
  const deepenLine = lines.find((l) => l.startsWith('deepen '));
  const depth = deepenLine ? Number(deepenLine.slice('deepen '.length).trim()) || undefined : undefined;

  const result = walk(repo, wants, { haves, depth, shallowBoundaries: boundaries });
  const pack = buildPack(result.entries);

  const out: Buffer[] = [pkt('acknowledgments\n'), pkt('NAK\n'), delim()];
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    out.push(pkt('shallow-info\n'));
    for (const sha of result.shallow) out.push(pkt(`shallow ${sha}\n`));
    for (const sha of result.unshallow) out.push(pkt(`unshallow ${sha}\n`));
    out.push(delim());
  }
  out.push(pkt('packfile\n'));
  out.push(sideband([pack]));
  res.writeHead(200, { 'content-type': contentType('git-upload-pack', 'result'), 'cache-control': 'no-cache' });
  res.end(Buffer.concat(out));
}

// ── receive-pack (v0) ─────────────────────────────────────────────────────────

interface PushCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

export function handleReceivePack(body: Buffer, res: ServerResponse, repo: Repo): void {
  const commands: PushCommand[] = [];
  let capabilities = '';
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    const text = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const nul = text.indexOf('\0');
    if (nul >= 0) capabilities = text.slice(nul + 1).trim();
    const fields = (nul === -1 ? text : text.slice(0, nul)).trim().split(' ');
    if (fields.length === 3) commands.push({ oldSha: fields[0], newSha: fields[1], ref: fields[2] });
  }

  // With no side-band the upload arrives as raw pack bytes; with side-band-64k the client does
  // NOT frame the pack it uploads (framing is only for the server's reply).
  const packBytes = body.subarray(offset);
  const report: string[] = [];
  let unpacked = true;
  if (packBytes.length >= 4 && packBytes.subarray(0, 4).toString('ascii') === 'PACK') {
    try {
      const entries = parsePack(repo, packBytes);
      for (const entry of entries) repo.writeObject(entry.type, entry.data);
    } catch (err) {
      unpacked = false;
      report.push(`unpack ${err instanceof Error ? err.message : 'error'}\n`);
    }
  }
  if (unpacked) report.push('unpack ok\n');

  for (const command of commands) {
    const { oldSha, newSha, ref } = command;
    if (!ref.startsWith('refs/')) {
      report.push(`ng ${ref} invalid ref name\n`);
      continue;
    }
    const current = repo.refs.get(ref);
    if (newSha === ZERO) {
      if (current !== undefined && oldSha !== current) {
        report.push(`ng ${ref} stale info\n`);
        continue;
      }
      repo.refs.delete(ref);
      report.push(`ok ${ref}\n`);
      continue;
    }
    if (!repo.readObject(newSha)) {
      report.push(`ng ${ref} missing object ${newSha}\n`);
      continue;
    }
    if (current === undefined) {
      if (oldSha !== ZERO) {
        report.push(`ng ${ref} stale info\n`);
        continue;
      }
    } else {
      if (current !== oldSha) {
        report.push(`ng ${ref} stale info\n`);
        continue;
      }
      if (current !== newSha) {
        const newObj = repo.readObject(newSha);
        const fastForward = newObj?.type === 'commit' && repo.ancestorOf(current, newSha);
        if (!fastForward) {
          report.push(`ng ${ref} non-fast-forward\n`);
          continue;
        }
      }
    }
    repo.refs.set(ref, newSha);
    report.push(`ok ${ref}\n`);
  }
  repo.pushedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const framed = Buffer.concat([...report.map((line) => pkt(line)), flush()]);
  const sidebanded = capabilities.split(' ').includes('side-band-64k');
  res.writeHead(200, { 'content-type': contentType('git-receive-pack', 'result'), 'cache-control': 'no-cache' });
  res.end(sidebanded ? sideband([framed]) : framed);
}
