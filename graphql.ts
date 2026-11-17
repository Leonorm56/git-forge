// graphql.ts — GraphQL v4 at /api/graphql.
// A purpose-built bridge for the documents gh and github-mcp-server send, not a general engine.

import { OWNER, OWNER_ID, allRepos, getRepo, newId, type Repo, type Issue, type Pr } from './store.ts';
import { squashMerge } from './rest.ts';

const ts = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const gqlTs = (s: string) => s; // already ISO

// ── tiny helpers ─────────────────────────────────────────────
const varOf = (variables: any, name: string) => variables?.[name];
const match = (text: string, re: RegExp) => text.match(re);

function issueObject(repo: Repo, issue: Issue) {
  return {
    __typename: 'Issue',
    id: `I_${issue.id}`,
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    author: { login: issue.user, id: OWNER_ID, nodeId: `U_${issue.user}`, __typename: 'User' },
    createdAt: gqlTs(issue.created_at),
    updatedAt: gqlTs(issue.updated_at),
    closedAt: issue.state === 'closed' ? gqlTs(issue.updated_at) : null,
    url: `https://github.example/${repo.fullName}/issues/${issue.number}`,
    repository: { name: repo.name, nameWithOwner: repo.fullName },
    labels: { nodes: issue.labels.map((n) => ({ name: n, color: 'ededed' })) },
  };
}
function prObject(repo: Repo, pr: Pr) {
  return {
    __typename: 'PullRequest',
    id: `PULL_${pr.id}`,
    databaseId: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state.toUpperCase(),
    headRefName: pr.head,
    baseRefName: pr.base,
    headRefOid: repo.refs.get(`refs/heads/${pr.head}`) ?? null,
    merged: pr.merged,
    mergeable: 'MERGEABLE',
    createdAt: gqlTs(pr.created_at),
    updatedAt: gqlTs(pr.updated_at),
    mergedAt: pr.merged ? gqlTs(pr.updated_at) : null,
    url: `https://github.example/${repo.fullName}/pull/${pr.number}`,
    files: { nodes: [] as { path: string }[] },
  };
}
function repositoryObject(repo: Repo) {
  return {
    __typename: 'Repository',
    id: repo.nodeId,
    databaseId: 4242,
    name: repo.name,
    nameWithOwner: repo.fullName,
    description: repo.description,
    url: `https://github.example/${repo.fullName}`,
    isPrivate: false,
    isFork: false,
    isArchived: false,
    isTemplate: false,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    hasWikiEnabled: false,
    hasProjectsEnabled: false,
    isInOrganization: false,
    createdAt: gqlTs(repo.createdAt),
    updatedAt: gqlTs(repo.updatedAt),
    pushedAt: gqlTs(repo.pushedAt),
    diskUsage: 1,
    stargazerCount: 0,
    owner: { login: OWNER, id: OWNER_ID, nodeId: `U_${OWNER}`, avatarUrl: '', __typename: 'User' },
    defaultBranchRef: { name: repo.defaultBranch },
    parent: null,
    issuesEnabled: true,
  };
}
/** The issue numbers list respecting orderBy CREATED_AT/DESC plus tie-break number DESC. */
function sortedIssues(repo: Repo, states: string[] | null) {
  let list = [...repo.issues];
  if (states?.length) list = list.filter((i) => states.includes(i.state.toUpperCase()));
  return list.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.number - a.number));
}

// ── introspection ─────────────────────────────────────────────
const ISSUE_FIELDS = ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository', 'labels', 'comments'];
const PR_FIELDS = ['id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid', 'merged', 'mergeable', 'createdAt', 'updatedAt', 'mergedAt', 'url', 'files', 'author', 'repository', 'baseRef', 'headRepository'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'url', 'isPrivate', 'isFork', 'isArchived', 'isTemplate', 'viewerPermission', 'hasIssuesEnabled', 'hasWikiEnabled', 'hasProjectsEnabled', 'isInOrganization', 'createdAt', 'updatedAt', 'pushedAt', 'diskUsage', 'stargazerCount', 'owner', 'defaultBranchRef', 'parent', 'issue', 'issues', 'pullRequests', 'pullRequest', 'releases', 'licenseInfo', 'primaryLanguage', 'latestRelease'];

const field = (name: string, type: string, args?: { name: string; type: string }[]) => ({
  name,
  description: null,
  args: (args ?? []).map((a) => ({ name: a.name, description: null, type: { kind: 'SCALAR', name: a.type, ofType: null }, defaultValue: null })),
  type: { kind: 'SCALAR', name: type, ofType: null },
  isDeprecated: false,
  deprecationReason: null,
});
const OBJECT = (name: string, desc: string, fields: { name: string; type: string; args?: { name: string; type: string }[] }[]) => ({
  kind: 'OBJECT', name, description: desc,
  fields: fields.map((f) => field(f.name, f.type, f.args)),
  interfaces: [],
  possibleTypes: null,
});
const introspectionType = (name: string) => {
  switch (name) {
    case 'Issue':
      return OBJECT('Issue', 'An issue on a repository', ISSUE_FIELDS.map((f) => ({ name: f, type: f === 'id' ? 'ID' : f === 'number' || f === 'databaseId' ? 'Int' : f === 'state' ? 'IssueState' : f === 'author' ? 'User' : f === 'createdAt' || f === 'updatedAt' || f === 'closedAt' ? 'DateTime' : f === 'labels' ? 'LabelConnection' : f === 'comments' ? 'CommentConnection' : 'String' })));
    case 'PullRequest':
      return OBJECT('PullRequest', 'A pull request', PR_FIELDS.map((f) => ({ name: f, type: f === 'id' ? 'ID' : f === 'number' || f === 'databaseId' ? 'Int' : f === 'state' ? 'PullRequestState' : f === 'merged' ? 'Boolean' : f === 'mergeable' ? 'MergeableState' : f === 'createdAt' || f === 'updatedAt' || f === 'mergedAt' ? 'DateTime' : f === 'files' ? 'PullRequestChangedFileConnection' : 'String' })));
    case 'Repository':
      return OBJECT('Repository', 'A GitHub repository', REPO_FIELDS.map((f) => ({
        name: f,
        type: f === 'id' ? 'ID' : f === 'databaseId' || f === 'diskUsage' || f === 'stargazerCount' ? 'Int' :
          f === 'name' ? 'String' :
          f === 'isPrivate' || f === 'isFork' || f === 'isArchived' || f === 'isTemplate' || f === 'hasIssuesEnabled' || f === 'hasWikiEnabled' || f === 'hasProjectsEnabled' || f === 'isInOrganization' ? 'Boolean' :
          f === 'issue' || f === 'pullRequest' ? (f === 'issue' ? 'Issue' : 'PullRequest') :
          f === 'issues' ? 'IssueConnection' :
          f === 'pullRequests' ? 'PullRequestConnection' :
          f === 'defaultBranchRef' ? 'Ref' :
          f === 'owner' ? 'User' :
          f === 'createdAt' || f === 'updatedAt' || f === 'pushedAt' ? 'DateTime' :
          'String',
        args: f === 'issue' ? [{ name: 'number', type: 'Int!' }] :
          f === 'pullRequest' ? [{ name: 'number', type: 'Int!' }] :
          f === 'issues' ? [{ name: 'first', type: 'Int' }, { name: 'orderBy', type: 'IssueOrder!' }, { name: 'states', type: '[IssueState!]' }] :
          f === 'pullRequests' ? [{ name: 'first', type: 'Int' }, { name: 'states', type: '[PullRequestState!]' }] :
          undefined,
      })));
    case 'SearchType':
      return { kind: 'ENUM', name: 'SearchType', description: 'The types of search results', enumValues: [
        { name: 'ISSUE', description: 'Issues and pull requests', isDeprecated: false, deprecationReason: null },
        { name: 'REPOSITORY', description: 'Repositories', isDeprecated: false, deprecationReason: null },
        { name: 'USER', description: 'Users', isDeprecated: false, deprecationReason: null },
      ], possibleTypes: null, interfaces: [] };
    case 'IssueState':
      return { kind: 'ENUM', name: 'IssueState', description: null, enumValues: [
        { name: 'OPEN', description: null, isDeprecated: false, deprecationReason: null },
        { name: 'CLOSED', description: null, isDeprecated: false, deprecationReason: null },
      ], possibleTypes: null, interfaces: [] };
    case 'PullRequestState':
      return { kind: 'ENUM', name: 'PullRequestState', description: null, enumValues: [
        { name: 'OPEN', description: null, isDeprecated: false, deprecationReason: null },
        { name: 'CLOSED', description: null, isDeprecated: false, deprecationReason: null },
        { name: 'MERGED', description: null, isDeprecated: false, deprecationReason: null },
      ], possibleTypes: null, interfaces: [] };
    case 'MergeableState':
      return { kind: 'ENUM', name: 'MergeableState', description: null, enumValues: [
        { name: 'MERGEABLE', description: null, isDeprecated: false, deprecationReason: null },
        { name: 'CONFLICTING', description: null, isDeprecated: false, deprecationReason: null },
        { name: 'UNKNOWN', description: null, isDeprecated: false, deprecationReason: null },
      ], possibleTypes: null, interfaces: [] };
    case 'IssueOrder':
      return { kind: 'INPUT_OBJECT', name: 'IssueOrder', description: null, inputFields: [
        { name: 'field', type: { kind: 'ENUM', name: 'IssueOrderField', ofType: null }, defaultValue: null, description: null },
        { name: 'direction', type: { kind: 'ENUM', name: 'OrderDirection', ofType: null }, defaultValue: 'ASC', description: null },
      ] };
    case 'IssueOrderField':
      return { kind: 'ENUM', name: 'IssueOrderField', description: null, enumValues: [
        { name: 'CREATED_AT', description: null, isDeprecated: false, deprecationReason: null },
        { name: 'UPDATED_AT', description: null, isDeprecated: false, deprecationReason: null },
        { name: 'COMMENTS', description: null, isDeprecated: false, deprecationReason: null },
      ], possibleTypes: null, interfaces: [] };
    case 'OrderDirection':
      return { kind: 'ENUM', name: 'OrderDirection', description: null, enumValues: [
        { name: 'ASC', description: null, isDeprecated: false, deprecationReason: null },
        { name: 'DESC', description: null, isDeprecated: false, deprecationReason: null },
      ], possibleTypes: null, interfaces: [] };
    case 'Query':
      return OBJECT('Query', 'The root query type', [{ name: 'repository', type: 'Repository', args: [{ name: 'owner', type: 'String!' }, { name: 'name', type: 'String!' }] }, { name: 'search', type: 'SearchResultItemConnection', args: [{ name: 'query', type: 'String!' }, { name: 'type', type: 'SearchType!' }] }]);
    case 'Mutation':
      return OBJECT('Mutation', 'The root mutation type', [{ name: 'createPullRequest', type: 'CreatePullRequestPayload', args: [{ name: 'input', type: 'CreatePullRequestInput!' }] }, { name: 'createIssue', type: 'CreateIssuePayload', args: [{ name: 'input', type: 'CreateIssueInput!' }] }]);
    default:
      return null;
  }
}
const introspectionSchema = () => ({
  queryType: { name: 'Query' },
  mutationType: { name: 'Mutation' },
  subscriptionType: null,
  types: ['Query', 'Mutation', 'Issue', 'PullRequest', 'Repository', 'SearchType', 'IssueState', 'PullRequestState', 'MergeableState', 'IssueOrder', 'IssueOrderField', 'OrderDirection'].map(introspectionType),
  directives: [],
});

// ── operation execution ───────────────────────────────────────
function executeOperation(query: string, variables: any, operationName: string | undefined) {
  const text = query;

  // introspection
  if (/__type\s*\(/.test(text) || /__schema\b/.test(text)) {
    const typeMatch = text.match(/__type\s*\(\s*name:\s*"([^"]+)"\s*\)/);
    if (typeMatch) {
      const t = introspectionType(typeMatch[1]);
      return { __type: t };
    }
    return { __schema: introspectionSchema() };
  }

  // createPullRequest
  if (text.includes('createPullRequest')) {
    let input = variables?.input;
    if (!input) input = (variables && (variables.repositoryId || variables.headRefName)) ? variables : extractInlineInput(text);
    const repoId = input?.repositoryId ?? input?.repository_id;
    const head = input?.headRefName ?? input?.head;
    const base = input?.baseRefName ?? input?.base;
    const title = input?.title ?? 'Untitled';
    const body = input?.body ?? '';
    const repo = repoId ? [...allRepos().values()].find((r) => r.nodeId === repoId) ?? null : null;
    if (!repo) return { errors: [{ message: `Could not resolve to a Repository with the global id of '${repoId}' (node id)` }] };
    if (!head || !repo.refs.has(`refs/heads/${head}`)) {
      return { errors: [{ message: 'Head ref must be a branch' }] };
    }
    const pr = {
      id: newId(), number: ++repo.prSeq, title, body,
      state: 'open' as const, merged: false, head, base: base ?? repo.defaultBranch,
      user: OWNER, created_at: ts(), updated_at: ts(), merge_commit_sha: null as string | null,
    };
    repo.prs.push(pr);
    return { createPullRequest: { pullRequest: prObject(repo, pr), __typename: 'CreatePullRequestPayload' } };
  }

  // repository(...)
  const repoArgs = extractRepoArgs(text, variables);
  if (!repoArgs) {
    return { errors: [{ message: 'Could not parse the repository argument' }] };
  }
  const repo = getRepo(repoArgs.name);
  if (!repo || repo.fullName.split('/')[0] !== repoArgs.owner) {
    return { data: { repository: null } };
  }
  const sel = repositorySelection(text);
  const knownRepoFields = new Set(REPO_FIELDS);
  const errors: { message: string }[] = [];
  const data: any = { repository: repositoryObject(repo) };
  for (const name of sel) {
    if (!knownRepoFields.has(name)) {
      errors.push({ message: `Cannot query field '${name}' on type 'Repository'.` });
      continue;
    }
    switch (name) {
      case 'owner': data.repository.owner = repositoryObject(repo).owner; break;
      case 'defaultBranchRef': data.repository.defaultBranchRef = repositoryObject(repo).defaultBranchRef; break;
      case 'issue': {
        const n = numberArg(text, 'issue', variables);
        const issue = repo.issues.find((i) => i.number === n) ?? null;
        data.repository.issue = issue ? issueObject(repo, issue) : null;
        break;
      }
      case 'issues': {
        const orderDesc = /direction:\s*DESC/.test(text) || /"direction":\s*"DESC"/.test(JSON.stringify(variables ?? {}));
        const statesArg = statesFrom(text, variables);
        const list = sortedIssues(repo, statesArg);
        if (!orderDesc) list.reverse();
        const first = firstArg(text, variables) ?? list.length;
        data.repository.issues = { nodes: list.slice(0, first).map((i) => issueObject(repo, i)), totalCount: list.length, __typename: 'IssueConnection' };
        break;
      }
      case 'pullRequests': {
        const statesArg = statesFrom(text, variables, true);
        let list = [...repo.prs].filter((p) => !statesArg || statesArg.includes(p.state.toUpperCase()));
        list.sort((a, b) => b.number - a.number);
        const first = firstArg(text, variables) ?? list.length;
        data.repository.pullRequests = { nodes: list.slice(0, first).map((p) => prObject(repo, p)), totalCount: list.length, __typename: 'PullRequestConnection' };
        break;
      }
      case 'pullRequest': {
        const n = numberArg(text, 'pullRequest', variables);
        const pr = repo.prs.find((p) => p.number === n) ?? null;
        data.repository.pullRequest = pr ? prObject(repo, pr) : null;
        break;
      }
      default:
        // scalars already set on repositoryObject
        break;
    }
  }
  return errors.length ? { data, errors } : { data };
}

function extractInlineInput(text: string) {
  const m = text.match(/input:\s*\{([^}]*)\}/);
  if (!m) return null;
  const out: any = {};
  for (const part of m[1].split(',')) {
    const kv = part.match(/(\w+):\s*"?([^",}]+)"?/);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}
function extractRepoArgs(text: string, variables: any): { owner: string; name: string } | null {
  // variables carry the common case: repository(owner: $owner, name: $name)
  if (variables && typeof variables === 'object') {
    const owner = variables.owner ?? variables.repo_owner ?? variables.organization;
    const name = variables.name ?? variables.repo ?? variables.repository;
    if (owner && name) return { owner: String(owner), name: String(name) };
    const nodeId = variables.id ?? variables.repositoryId;
    if (nodeId) {
      const repo = [...allRepos().values()].find((r) => r.nodeId === nodeId);
      if (repo) return { owner: OWNER, name: repo.name };
    }
  }
  const m = text.match(/repository\s*\(\s*owner:\s*"([^"]+)"\s*,\s*name:\s*"([^"]+)"/);
  if (m) return { owner: m[1], name: m[2] };
  const m2 = text.match(/repository\s*\(\s*name:\s*"([^"]+)"\s*,\s*owner:\s*"([^"]+)"/);
  if (m2) return { owner: m2[2], name: m2[1] };
  return null;
}
/** The top-level field names selected inside repository(...){ ... }. */
function repositorySelection(text: string): string[] {
  const start = text.search(/repository\s*\(/);
  if (start === -1) return [];
  const open = text.indexOf('{', start);
  if (open === -1) return [];
  let depth = 0, end = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = text.slice(open + 1, end === -1 ? text.length : end);
  const names: string[] = [];
  let depth2 = 0, token = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') { depth2++; token = ''; continue; }
    if (c === '}') { depth2--; token = ''; continue; }
    if (depth2 === 0) {
      const m = /^[A-Za-z_]\w*/.exec(body.slice(i));
      if (m && (i === 0 || /[\s{,]/.test(body[i - 1]))) {
        names.push(m[0]);
        i += m[0].length - 1;
      }
    }
  }
  return [...new Set(names)];
}
const numberArg = (text: string, field: string, variables: any): number | undefined => {
  const m = text.match(new RegExp(`${field}\\s*\\(\\s*number:\\s*\\$?([A-Za-z_]\\w*)`));
  if (!m) return undefined;
  if (/^\d+$/.test(m[1])) return Number(m[1]);
  const v = variables?.[m[1]];
  return typeof v === 'number' ? v : undefined;
};
const statesFrom = (text: string, variables: any, isPr = false): string[] | null => {
  const m = text.match(/states:\s*\[([^\]]*)\]/);
  if (m) {
    return m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '').toUpperCase()).filter(Boolean);
  }
  const v = variables?.states ?? variables?.issueStates ?? variables?.statesArg;
  if (Array.isArray(v)) return v.map((s: any) => String(s).toUpperCase());
  return null;
};
const firstArg = (text: string, variables: any): number | undefined => {
  const m = text.match(/first:\s*(\d+)/);
  if (m) return Number(m[1]);
  const v = variables?.first;
  return typeof v === 'number' ? v : undefined;
};

// ── entry points ──────────────────────────────────────────────
/** Split a document into its top-level operations, if it holds more than one. */
export function splitOperations(doc: string): string[] {
  const ops: string[] = [];
  const re = /(^|[}\s])(query|mutation)\b/g;
  let matchArr: RegExpExecArray | null;
  const cuts: number[] = [];
  while ((matchArr = re.exec(doc)) !== null) cuts.push(matchArr.index + matchArr[1].length);
  if (cuts.length <= 1) return [doc];
  for (let i = 0; i < cuts.length; i++) {
    const end = i + 1 < cuts.length ? cuts[i + 1] : doc.length;
    ops.push(doc.slice(cuts[i], end));
  }
  return ops.map((s) => s.trim()).filter(Boolean);
}

export function handleGraphql(query: string, variables: any, operationName: string | undefined) {
  const ops = splitOperations(query);
  if (ops.length > 1) return ops.map((op) => executeOperation(op, variables, operationName));
  return executeOperation(query, variables, operationName);
}
