# Agent Console — Project Rules

## Branches, versions and tags (automatic)

Do these steps for each fix or feature. You do not need to ask first.

### 1. Make a branch before the first code change

- A feature: `feat/<short-name>`. A fix: `fix/<short-name>`.
- Make the branch from `main`. Use a worktree under `.worktrees/<short-name>` when other work runs in the main checkout.
- Do not change code on `main` directly.

### 2. Select the version step

The app version uses `MAJOR.MINOR.PATCH`.

| Change | Step | Example |
|---|---|---|
| `feat`: new behaviour that a user can see or use | MINOR | `0.1.3` → `0.2.0` |
| `fix`: a bug fix, with no new behaviour | PATCH | `0.1.3` → `0.1.4` |
| Docs, tests, refactor or chore only | No version step | — |

- Never change MAJOR. Only the user changes MAJOR.
- One branch gets one version step. Use the largest step of its commits: a branch with a feat and a fix gets MINOR.

### 3. Update the version in all places

The app version is in two files. They must always show the same value:

- `package.json` → `"version"`
- `src/mcp.ts` → `new McpServer({ name: 'agent-console', version: '…' })`

The desktop app has its own version (`desktop/package.json` and `desktop/electrobun.config.ts`). Change it only when the branch changes files in `desktop/`. Use the same MINOR/PATCH rule, and keep these two desktop files the same.

### 4. Commit the version step

- Make the version step the last commit on the branch, after the tests pass.
- Commit message: `chore: release vX.Y.Z`.

### 5. Tag the version commit

- Make an annotated tag on that commit: `git tag -a vX.Y.Z -m "vX.Y.Z: <one-line summary>"`.
- The tag name is the new app version with a `v` prefix.
- If the tag exists already, stop and tell the user. Do not move or delete a tag.

### 6. Before you finish

- Run `bun test` and `bun run typecheck`. Report the result.
- Tell the user the branch name, the old and the new version, and the tag.
- Merging into `main`, pushing and deleting a branch still need the user's approval.

### Version check

Before a version step, check that the two app version files agree:

```bash
rg -n '"version"' package.json; rg -n "version: '" src/mcp.ts
```

If they do not agree, tell the user. Use the higher value as the base.
