# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Leonorm56/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Leonorm56/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process and no dependencies: git smart HTTP (upload-pack protocol v2 with shallow/deepen, receive-pack v0), the REST v3 surface (`/api/v3`), GraphQL v4 (`/api/graphql`) and a Model Context Protocol endpoint (`/mcp`) over one in-memory object store. It writes no files, spawns no `git` binary, and talks to nothing but its own client.

Everything it stores is a real git object: blobs, trees, commits and tags are hashed with SHA-1 over `"<type> <size>\0" + bytes`, packs are built and parsed by hand (zlib for the streams, plain objects only — no deltas), and the REST/GraphQL/MCP views all read the same store the smart-HTTP surface serves. Push fast-forwards and refusals are decided from the object graph, pull requests diff the trees of their base and head branches, and a squash merge writes a fresh commit whose parent is the base tip.

The four surfaces agree with each other on purpose: an issue created over MCP is the issue REST lists and GraphQL returns, with the same `id`; a repository created over REST is addressable by the opaque `node_id` GraphQL hands out (`R_<dbId>_<name>`), and a pull request merged through `mergePullRequest` is closed, merged and carries `merge_commit_sha` on every surface. GraphQL is a small real implementation — tokenizer, parser (operations, variables, aliases, fragments, inline fragments), resolvers and cursor pagination — not a schema stub, so an unknown field answers a GraphQL `errors` entry instead of silently disappearing, and two operation documents in one HTTP body answer as a JSON array in order.

Runs on the Node 22 runtime with nothing installed: the source is erasable TypeScript executed directly (`node main.ts`), so there is no build step, no `node_modules` and no transpiler.

## Run it

```sh
node main.ts
```

`main.ts` is the entry the grader starts: it binds an ephemeral port, registers it with the trial env at `MAKEFUN_ENV_URL`, serves until the trial is done, then exits 0. The bearer token the suite sends is `MAKEFUN_SHOP_TOKEN`; `GET /healthz` answers without one.

---

<sub>Entered on [make.fun](https://make.fun/?ref=a6wrad6x&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
