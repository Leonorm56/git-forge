// graphql.ts — the GraphQL v4 surface at /api/graphql.
//
// Two parts: a small document parser (operations, variables, aliases, arguments, fragments,
// inline fragments) and a resolver table over the forge's store. There is no schema engine:
// each type names its fields, and projection follows the caller's selection set, so an
// unknown field is reported as a GraphQL error instead of being silently dropped.

import {
  OWNER,
  allRepos,
  getRepo,
  newId,
  type Issue,
  type IssueComment,
  type Pr,
  type Repo,
} from './store.ts';
import { diffFiles, findMergeBase, squashMerge } from './rest.ts';

// ── document AST ──────────────────────────────────────────────────────────────

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'enum'; name: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldSelection {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selections: Selection[];
}
interface InlineFragment {
  kind: 'inline';
  typeCondition?: string;
  selections: Selection[];
}
interface FragmentSpread {
  kind: 'spread';
  name: string;
}
type Selection = FieldSelection | InlineFragment | FragmentSpread;

interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name?: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
}

class GraphQLError extends Error {}

// ── tokenizer ────────────────────────────────────────────────────────────────

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct';
  value: string;
  line: number;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const isNameStart = (c: string) => /[A-Za-z_]/.test(c);
  const isName = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (c === '.') {
      if (source.startsWith('...', i)) { tokens.push({ kind: 'punct', value: '...', line }); i += 3; continue; }
      throw new GraphQLError(`unexpected "." at line ${line}`);
    }
    if ('{}()[]:!$@|=&'.includes(c)) { tokens.push({ kind: 'punct', value: c, line }); i += 1; continue; }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GraphQLError(`unterminated block string at line ${line}`);
        const text = source.slice(i + 3, end);
        line += (text.match(/\n/g) ?? []).length;
        tokens.push({ kind: 'string', value: text, line });
        i = end + 3;
        continue;
      }
      let out = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const next = source[i + 1];
          if (next === 'n') out += '\n';
          else if (next === 't') out += '\t';
          else if (next === 'r') out += '\r';
          else if (next === 'u') { out += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16)); i += 4; }
          else out += next;
          i += 2;
          continue;
        }
        if (source[i] === '\n') line += 1;
        out += source[i];
        i += 1;
      }
      if (i >= source.length) throw new GraphQLError(`unterminated string at line ${line}`);
      i += 1;
      tokens.push({ kind: 'string', value: out, line });
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i + 1;
      let kind: 'int' | 'float' = 'int';
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) {
        if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') kind = 'float';
        j += 1;
      }
      tokens.push({ kind, value: source.slice(i, j), line });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < source.length && isName(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j), line });
      i = j;
      continue;
    }
    throw new GraphQLError(`unexpected character ${JSON.stringify(c)} at line ${line}`);
  }
  return tokens;
}

// ── parser ───────────────────────────────────────────────────────────────────

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly fragments = new Map<string, { typeCondition: string; selections: Selection[] }>();

  constructor(tokens: Token[]) { this.tokens = tokens; }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }
  private atName(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'name' && token.value === value;
  }
  private take(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new GraphQLError('unexpected end of document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    if (!this.atPunct(value)) {
      const token = this.peek();
      throw new GraphQLError(`expected ${JSON.stringify(value)} but found ${token ? JSON.stringify(token.value) : 'the end of the document'} at line ${token?.line ?? 0}`);
    }
    this.pos += 1;
  }
  private expectName(): string {
    const token = this.take();
    if (token.kind !== 'name') throw new GraphQLError(`expected a name, found ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      if (this.atPunct('{')) {
        operations.push({ kind: 'query', selections: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | undefined;
        if (this.peek()?.kind === 'name') name = this.expectName();
        if (this.atPunct('(')) this.skipVariableDefinitions();
        this.skipDirectives();
        operations.push({ kind: keyword, name, selections: this.parseSelectionSet() });
        continue;
      }
      if (keyword === 'fragment') {
        const name = this.expectName();
        if (!this.atName('on')) throw new GraphQLError('a fragment needs an "on" type condition');
        this.pos += 1;
        const typeCondition = this.expectName();
        this.skipDirectives();
        this.fragments.set(name, { typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new GraphQLError(`unexpected ${JSON.stringify(keyword)} at the top level`);
    }
    return { operations, fragments: this.fragments };
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.take();
      if (token.kind === 'punct' && (token.value === '(' || token.value === '[' || token.value === '{')) depth += 1;
      else if (token.kind === 'punct' && (token.value === ')' || token.value === ']' || token.value === '}')) depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.pos += 1;
      this.expectName();
      if (this.atPunct('(')) this.skipParenthesized();
    }
  }

  private skipParenthesized(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.take();
      if (token.kind === 'punct' && (token.value === '(' || token.value === '[' || token.value === '{')) depth += 1;
      else if (token.kind === 'punct' && (token.value === ')' || token.value === ']' || token.value === '}')) depth -= 1;
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.atPunct('}')) {
      if (this.atPunct('...')) {
        this.pos += 1;
        if (this.atName('on')) {
          this.pos += 1;
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else if (this.atPunct('{') || this.atPunct('@')) {
          this.skipDirectives();
          selections.push({ kind: 'inline', selections: this.parseSelectionSet() });
        } else {
          const name = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      selections.push(this.parseField());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldSelection {
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.atPunct(':')) {
      this.pos += 1;
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.atPunct('(')) {
      this.pos += 1;
      while (!this.atPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selections = this.atPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (token === undefined) throw new GraphQLError('expected a value');
    if (token.kind === 'punct') {
      if (token.value === '$') {
        this.pos += 1;
        return { kind: 'var', name: this.expectName() };
      }
      if (token.value === '[') {
        this.pos += 1;
        const values: ValueNode[] = [];
        while (!this.atPunct(']')) values.push(this.parseValue());
        this.expectPunct(']');
        return { kind: 'list', values };
      }
      if (token.value === '{') {
        this.pos += 1;
        const fields: Record<string, ValueNode> = {};
        while (!this.atPunct('}')) {
          const name = this.expectName();
          this.expectPunct(':');
          fields[name] = this.parseValue();
        }
        this.expectPunct('}');
        return { kind: 'object', fields };
      }
      throw new GraphQLError(`unexpected ${JSON.stringify(token.value)} where a value was expected`);
    }
    this.pos += 1;
    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === 'int') return { kind: 'literal', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'literal', value: Number(token.value) };
    if (token.value === 'true') return { kind: 'literal', value: true };
    if (token.value === 'false') return { kind: 'literal', value: false };
    if (token.value === 'null') return { kind: 'literal', value: null };
    return { kind: 'enum', name: token.value };
  }
}

function evaluate(node: ValueNode | undefined, variables: Record<string, any>): any {
  if (node === undefined) return undefined;
  switch (node.kind) {
    case 'var': return variables[node.name];
    case 'literal': return node.value;
    case 'enum': return node.name;
    case 'list': return node.values.map((value) => evaluate(value, variables));
    case 'object': {
      const out: Record<string, any> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evaluate(value, variables);
      return out;
    }
  }
}

// ── values: a node is an object of a named type the projection knows ─────────

class GqlNode {
  readonly type: string;
  readonly value: any;
  constructor(type: string, value: any) { this.type = type; this.value = value; }
}
const gqlNode = (type: string, value: any) => new GqlNode(type, value);

type Resolver = (source: any, args: Record<string, any>) => unknown;

// ── helpers over the store ───────────────────────────────────────────────────

const issueGlobalId = (issue: Issue): string => `I_${issue.id}`;
const pullGlobalId = (pr: Pr): string => `PULL_${pr.id}`;
const commentGlobalId = (comment: IssueComment): string => `IC_${comment.id}`;

const issueState = (issue: Issue): 'OPEN' | 'CLOSED' => (issue.state === 'closed' ? 'CLOSED' : 'OPEN');
const pullState = (pr: Pr): 'OPEN' | 'CLOSED' | 'MERGED' =>
  pr.merged ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN';

const encodeCursor = (offset: number): string => Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
const decodeCursor = (cursor: unknown): number | null => {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
};

const findRepoByNodeId = (id: string): Repo | null => {
  for (const repo of allRepos().values()) if (repo.nodeId === id) return repo;
  return null;
};

const findIssueByGlobalId = (id: string): { repo: Repo; issue: Issue } | null => {
  for (const repo of allRepos().values()) {
    const issue = repo.issues.find((candidate) => issueGlobalId(candidate) === id);
    if (issue) return { repo, issue };
  }
  return null;
};

const findPullByGlobalId = (id: string): { repo: Repo; pr: Pr } | null => {
  for (const repo of allRepos().values()) {
    const pr = repo.prs.find((candidate) => pullGlobalId(candidate) === id);
    if (pr) return { repo, pr };
  }
  return null;
};

/** Whether a pull request's head and base can be squash-merged without a conflict. */
function mergeability(repo: Repo, pr: Pr): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pr.merged) return 'UNKNOWN';
  const head = repo.refs.get(`refs/heads/${pr.head}`);
  const base = repo.refs.get(`refs/heads/${pr.base}`);
  if (!head || !base) return 'UNKNOWN';
  const mergeBase = findMergeBase(repo, head, base);
  if (!mergeBase) return 'UNKNOWN';
  const headFiles = repo.filesAt(head);
  const baseFiles = repo.filesAt(base);
  const mbFiles = repo.filesAt(mergeBase);
  for (const path of new Set([...headFiles.keys(), ...baseFiles.keys(), ...mbFiles.keys()])) {
    const mb = mbFiles.get(path)?.sha ?? null;
    const headSha = headFiles.get(path)?.sha ?? null;
    const baseSha = baseFiles.get(path)?.sha ?? null;
    const headChanged = headSha !== mb;
    const baseChanged = baseSha !== mb;
    if (headChanged && baseChanged && headSha !== baseSha) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

// ── connection helpers ───────────────────────────────────────────────────────

interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

function paginate<T>(items: T[], args: Record<string, any>, defaultFirst = 100): Page<T> {
  const firstRaw = args.first;
  const first = typeof firstRaw === 'number' && firstRaw > 0 ? Math.min(firstRaw, 1000) : defaultFirst;
  const after = decodeCursor(args.after);
  const start = after === null ? 0 : Math.min(after, items.length);
  const nodes = items.slice(start, start + first);
  const hasNextPage = start + first < items.length;
  return {
    nodes,
    hasNextPage,
    endCursor: nodes.length === 0 ? null : encodeCursor(start + nodes.length),
    startCursor: nodes.length === 0 ? null : encodeCursor(start),
  };
}

const pageInfo = (page: Page<unknown>) =>
  gqlNode('PageInfo', {
    hasNextPage: page.hasNextPage,
    hasPreviousPage: page.startCursor !== null && page.startCursor !== encodeCursor(0),
    endCursor: page.endCursor,
    startCursor: page.startCursor,
  });

// ── resolvers ────────────────────────────────────────────────────────────────

const schema = {
  Query: new Map<string, Resolver>([
    ['viewer', () => gqlNode('User', { login: OWNER })],
    ['repository', (_src, args) => {
      if (String(args.owner ?? '').toLowerCase() !== OWNER.toLowerCase()) return null;
      const repo = getRepo(String(args.name ?? ''));
      return repo ? gqlNode('Repository', repo) : null;
    }],
    ['node', (_src, args) => {
      const id = String(args.id ?? '');
      const repo = findRepoByNodeId(id);
      if (repo) return gqlNode('Repository', repo);
      const issue = findIssueByGlobalId(id);
      if (issue) return gqlNode('Issue', issue.issue);
      const pull = findPullByGlobalId(id);
      if (pull) return gqlNode('PullRequest', pull.pr);
      return null;
    }],
    ['__type', (_src, args) => typeIntrospection(String(args.name ?? ''))],
    ['__typename', () => 'Query'],
  ]),
  Mutation: new Map<string, Resolver>([
    ['createIssue', (_src, args) => {
      const input = (args.input ?? {}) as Record<string, any>;
      const repo = findRepoByNodeId(String(input.repositoryId ?? ''));
      if (!repo) throw new GraphQLError('Could not resolve to a Repository with that global id');
      const title = String(input.title ?? '');
      if (title === '') throw new GraphQLError('A title is required to create an issue');
      const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const issue: Issue = {
        id: newId(), number: ++repo.issueSeq, title, body: String(input.body ?? ''),
        state: 'open', labels: [], user: OWNER, created_at: stamp, updated_at: stamp,
      };
      repo.issues.push(issue);
      return gqlNode('CreateIssuePayload', { issue: gqlNode('Issue', issue) });
    }],
    ['closeIssue', (_src, args) => {
      const input = (args.input ?? {}) as Record<string, any>;
      const found = findIssueByGlobalId(String(input.issueId ?? ''));
      if (!found) throw new GraphQLError('Could not resolve to an Issue with that global id');
      found.issue.state = 'closed';
      found.issue.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      return gqlNode('CloseIssuePayload', { issue: gqlNode('Issue', found.issue) });
    }],
    ['createPullRequest', (_src, args) => {
      const input = (args.input ?? {}) as Record<string, any>;
      const repo = findRepoByNodeId(String(input.repositoryId ?? ''));
      if (!repo) throw new GraphQLError('Could not resolve to a Repository with that global id');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (!repo.refs.has(`refs/heads/${head}`)) throw new GraphQLError(`Head branch "${head}" does not exist`);
      const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const pr: Pr = {
        id: newId(), number: ++repo.prSeq, title: String(input.title ?? ''), body: String(input.body ?? ''),
        state: 'open', merged: false, head, base, user: OWNER,
        created_at: stamp, updated_at: stamp, merge_commit_sha: null,
      };
      repo.prs.push(pr);
      return gqlNode('CreatePullRequestPayload', { pullRequest: gqlNode('PullRequest', pr) });
    }],
    ['mergePullRequest', (_src, args) => {
      const input = (args.input ?? {}) as Record<string, any>;
      const found = findPullByGlobalId(String(input.pullRequestId ?? ''));
      if (!found) throw new GraphQLError('Could not resolve to a PullRequest with that global id');
      const sha = squashMerge(found.repo, found.pr);
      if (sha === null) throw new GraphQLError('Pull request is not mergeable');
      return gqlNode('MergePullRequestPayload', { pullRequest: gqlNode('PullRequest', found.pr) });
    }],
    ['addComment', (_src, args) => {
      const input = (args.input ?? {}) as Record<string, any>;
      const found = findIssueByGlobalId(String(input.subjectId ?? ''));
      if (!found) throw new GraphQLError('Could not resolve to an Issue with that global id');
      const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const comment: IssueComment = {
        id: newId(), issueNumber: found.issue.number, body: String(input.body ?? ''),
        user: OWNER, created_at: stamp,
      };
      found.repo.comments.push(comment);
      found.issue.updated_at = stamp;
      return gqlNode('AddCommentPayload', {
        commentEdge: gqlNode('IssueCommentEdge', { node: gqlNode('IssueComment', comment) }),
      });
    }],
  ]),
  User: new Map<string, Resolver>([
    ['login', (src) => src.login],
    ['id', (src) => `U_${src.login}`],
    ['name', (src) => src.name ?? src.login],
    ['databaseId', () => 101],
    ['__typename', () => 'User'],
  ]),
  Repository: new Map<string, Resolver>([
    ['id', (repo: Repo) => repo.nodeId],
    ['databaseId', (repo: Repo) => repo.dbId],
    ['name', (repo: Repo) => repo.name],
    ['nameWithOwner', (repo: Repo) => repo.fullName],
    ['description', (repo: Repo) => repo.description || null],
    ['isPrivate', (repo: Repo) => repo.private_],
    ['viewerPermission', () => 'ADMIN'],
    ['hasIssuesEnabled', () => true],
    ['hasPullRequestsEnabled', () => true],
    ['defaultBranchRef', (repo: Repo) =>
      repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? gqlNode('Ref', { name: repo.defaultBranch }) : null],
    ['owner', () => gqlNode('User', { login: OWNER })],
    ['url', (repo: Repo) => `https://github.example/${repo.fullName}`],
    ['issue', (repo: Repo, args) => {
      const issue = repo.issues.find((candidate) => candidate.number === Number(args.number));
      return issue ? gqlNode('Issue', issue) : null;
    }],
    ['issues', (repo: Repo, args) => {
      const wanted = Array.isArray(args.states) && args.states.length > 0 ? args.states.map(String) : null;
      let list = repo.issues.filter((issue) => wanted === null || wanted.includes(issueState(issue)));
      const order = (args.orderBy ?? {}) as Record<string, any>;
      const field = String(order.field ?? 'CREATED_AT');
      const direction = String(order.direction ?? 'DESC').toUpperCase();
      const key = field === 'UPDATED_AT' ? 'updated_at' : field === 'COMMENTS' ? 'created_at' : 'created_at';
      list = [...list].sort((a, b) => {
        const av = a[key];
        const bv = b[key];
        const cmp = av < bv ? -1 : av > bv ? 1 : a.number - b.number;
        return direction === 'ASC' ? cmp : -cmp;
      });
      const page = paginate(list, args);
      return gqlNode('IssueConnection', { page, nodes: page.nodes.map((issue) => gqlNode('Issue', issue)) });
    }],
    ['pullRequest', (repo: Repo, args) => {
      const pr = repo.prs.find((candidate) => candidate.number === Number(args.number));
      return pr ? gqlNode('PullRequest', pr) : null;
    }],
    ['pullRequests', (repo: Repo, args) => {
      const wanted = Array.isArray(args.states) && args.states.length > 0
        ? args.states.map(String)
        : ['OPEN'];
      const list = repo.prs
        .filter((pr) => wanted.includes(pullState(pr)))
        .sort((a, b) => b.number - a.number);
      const page = paginate(list, args);
      return gqlNode('PullRequestConnection', { page, nodes: page.nodes.map((pr) => gqlNode('PullRequest', pr)) });
    }],
    ['__typename', () => 'Repository'],
  ]),
  Issue: new Map<string, Resolver>([
    ['id', (issue: Issue) => issueGlobalId(issue)],
    ['number', (issue: Issue) => issue.number],
    ['title', (issue: Issue) => issue.title],
    ['body', (issue: Issue) => issue.body],
    ['state', (issue: Issue) => issueState(issue)],
    ['stateReason', (issue: Issue) => (issue.state === 'closed' ? 'COMPLETED' : null)],
    ['createdAt', (issue: Issue) => issue.created_at],
    ['updatedAt', (issue: Issue) => issue.updated_at],
    ['url', (issue: Issue) => `https://github.example/${OWNER}/issues/${issue.number}`],
    ['__typename', () => 'Issue'],
  ]),
  PullRequest: new Map<string, Resolver>([
    ['id', (pr: Pr) => pullGlobalId(pr)],
    ['number', (pr: Pr) => pr.number],
    ['title', (pr: Pr) => pr.title],
    ['body', (pr: Pr) => pr.body],
    ['state', (pr: Pr) => pullState(pr)],
    ['merged', (pr: Pr) => pr.merged],
    ['mergedAt', (pr: Pr) => (pr.merged ? pr.updated_at : null)],
    ['headRefName', (pr: Pr) => pr.head],
    ['baseRefName', (pr: Pr) => pr.base],
    ['mergeable', (pr: Pr) => {
      // the owning repo is needed for the conflict probe; it is attached when the node is built
      const repo = repoOwningPull(pr);
      return repo ? mergeability(repo, pr) : 'UNKNOWN';
    }],
    ['files', (pr: Pr, args) => {
      const repo = repoOwningPull(pr);
      const rows = repo ? diffFiles(repo, pr) : [];
      const page = paginate(rows, args);
      return gqlNode('PullRequestChangedFileConnection', {
        page,
        nodes: page.nodes.map((row) => gqlNode('PullRequestChangedFile', row)),
      });
    }],
    ['__typename', () => 'PullRequest'],
  ]),
  PullRequestChangedFile: new Map<string, Resolver>([
    ['path', (row: { filename: string }) => row.filename],
    ['additions', (row: { additions: number }) => row.additions],
    ['deletions', (row: { deletions: number }) => row.deletions],
    ['changeType', (row: { status: string }) => (row.status === 'added' ? 'ADDED' : row.status === 'removed' ? 'DELETED' : 'MODIFIED')],
    ['__typename', () => 'PullRequestChangedFile'],
  ]),
  IssueComment: new Map<string, Resolver>([
    ['id', (comment: IssueComment) => commentGlobalId(comment)],
    ['body', (comment: IssueComment) => comment.body],
    ['createdAt', (comment: IssueComment) => comment.created_at],
    ['__typename', () => 'IssueComment'],
  ]),
  IssueConnection: new Map<string, Resolver>([
    ['nodes', (conn) => conn.nodes],
    ['totalCount', (conn) => conn.nodes.length],
    ['pageInfo', (conn) => pageInfo(conn.page)],
    ['__typename', () => 'IssueConnection'],
  ]),
  PullRequestConnection: new Map<string, Resolver>([
    ['nodes', (conn) => conn.nodes],
    ['totalCount', (conn) => conn.nodes.length],
    ['pageInfo', (conn) => pageInfo(conn.page)],
    ['__typename', () => 'PullRequestConnection'],
  ]),
  PullRequestChangedFileConnection: new Map<string, Resolver>([
    ['nodes', (conn) => conn.nodes],
    ['totalCount', (conn) => conn.nodes.length],
    ['pageInfo', (conn) => pageInfo(conn.page)],
    ['__typename', () => 'PullRequestChangedFileConnection'],
  ]),
  IssueCommentEdge: new Map<string, Resolver>([
    ['node', (edge) => edge.node],
    ['__typename', () => 'IssueCommentEdge'],
  ]),
  AddCommentPayload: new Map<string, Resolver>([
    ['commentEdge', (payload) => payload.commentEdge],
    ['__typename', () => 'AddCommentPayload'],
  ]),
  CreateIssuePayload: new Map<string, Resolver>([
    ['issue', (payload) => payload.issue],
    ['__typename', () => 'CreateIssuePayload'],
  ]),
  CloseIssuePayload: new Map<string, Resolver>([
    ['issue', (payload) => payload.issue],
    ['__typename', () => 'CloseIssuePayload'],
  ]),
  CreatePullRequestPayload: new Map<string, Resolver>([
    ['pullRequest', (payload) => payload.pullRequest],
    ['__typename', () => 'CreatePullRequestPayload'],
  ]),
  MergePullRequestPayload: new Map<string, Resolver>([
    ['pullRequest', (payload) => payload.pullRequest],
    ['__typename', () => 'MergePullRequestPayload'],
  ]),
  Ref: new Map<string, Resolver>([
    ['name', (ref) => ref.name],
    ['__typename', () => 'Ref'],
  ]),
  PageInfo: new Map<string, Resolver>([
    ['hasNextPage', (info) => info.hasNextPage],
    ['hasPreviousPage', (info) => info.hasPreviousPage],
    ['endCursor', (info) => info.endCursor],
    ['startCursor', (info) => info.startCursor],
    ['__typename', () => 'PageInfo'],
  ]),
  __Type: new Map<string, Resolver>([
    ['name', (type) => type.name],
    ['kind', (type) => type.kind],
    ['fields', (type) => type.fields.map((name: string) => gqlNode('__Field', { name }))],
    ['enumValues', (type) => type.enumValues.map((name: string) => gqlNode('__EnumValue', { name }))],
    ['__typename', () => '__Type'],
  ]),
  __Field: new Map<string, Resolver>([
    ['name', (field) => field.name],
    ['__typename', () => '__Field'],
  ]),
  __EnumValue: new Map<string, Resolver>([
    ['name', (value) => value.name],
    ['__typename', () => '__EnumValue'],
  ]),
} as Record<string, Map<string, Resolver>>;

function repoOwningPull(pr: Pr): Repo | null {
  for (const repo of allRepos().values()) if (repo.prs.includes(pr)) return repo;
  return null;
}

// ── introspection ────────────────────────────────────────────────────────────

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'stateReason', 'createdAt', 'updatedAt', 'url', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName', 'mergeable', 'files', 'commits'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'viewerPermission',
    'hasIssuesEnabled', 'hasPullRequestsEnabled', 'defaultBranchRef', 'owner', 'url',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'object',
  ],
  SearchType: [],
  User: ['id', 'login', 'name', 'databaseId'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function typeIntrospection(name: string): GqlNode | null {
  if (!(name in TYPE_FIELDS) && !(name in ENUM_VALUES)) return null;
  return gqlNode('__Type', {
    name,
    kind: name in ENUM_VALUES && TYPE_FIELDS[name] === undefined ? 'ENUM' : 'OBJECT',
    fields: TYPE_FIELDS[name] ?? [],
    enumValues: ENUM_VALUES[name] ?? [],
  });
}

// ── projection ───────────────────────────────────────────────────────────────

function project(value: unknown, selections: Selection[], variables: Record<string, any>, fragments: Document['fragments']): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => project(item, selections, variables, fragments));
  if (!(value instanceof GqlNode)) return value;
  const out: Record<string, unknown> = {};
  applySelections(value, selections, variables, fragments, out);
  return out;
}

function applySelections(
  node: GqlNode,
  selections: Selection[],
  variables: Record<string, any>,
  fragments: Document['fragments'],
  out: Record<string, unknown>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const table = schema[node.type];
      const resolver = table?.get(selection.name);
      if (!resolver) {
        throw new GraphQLError(`Cannot query field "${selection.name}" on type "${node.type}".`);
      }
      const args: Record<string, any> = {};
      for (const [key, value] of Object.entries(selection.args)) args[key] = evaluate(value, variables);
      const resolved = resolver(node.value, args);
      out[selection.alias ?? selection.name] = project(resolved, selection.selections, variables, fragments);
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== node.type && selection.typeCondition !== 'Node') continue;
      applySelections(node, selection.selections, variables, fragments, out);
      continue;
    }
    const fragment = fragments.get(selection.name);
    if (!fragment) throw new GraphQLError(`Unknown fragment "${selection.name}".`);
    if (fragment.typeCondition !== node.type && fragment.typeCondition !== 'Node') continue;
    applySelections(node, fragment.selections, variables, fragments, out);
  }
}

// ── entry point ──────────────────────────────────────────────────────────────

export interface GraphqlAnswer {
  data?: unknown;
  errors?: Array<{ message: string; path?: Array<string | number> }>;
}

export function handleGraphql(
  query: string,
  variables?: Record<string, unknown> | null,
  operationName?: string,
): GraphqlAnswer {
  try {
    const document = new Parser(tokenize(query)).parseDocument();
    let operation: Operation | undefined;
    if (operationName !== undefined && operationName !== '') {
      operation = document.operations.find((candidate) => candidate.name === operationName);
      if (!operation) throw new GraphQLError(`Unknown operation named "${operationName}".`);
    } else {
      operation = document.operations[0];
    }
    if (!operation) throw new GraphQLError('The document holds no operation.');
    const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    const root = new GqlNode(rootType, null);
    const out: Record<string, unknown> = {};
    applySelections(root, operation.selections, (variables ?? {}) as Record<string, any>, document.fragments, out);
    return { data: out };
  } catch (err) {
    if (err instanceof GraphQLError) return { data: null, errors: [{ message: err.message }] };
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
