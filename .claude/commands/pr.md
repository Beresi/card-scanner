# PR Command

Generate a pull request for the current branch.

## Steps

1. Run in parallel to gather context:
   - `git status` — check for uncommitted changes
   - `git log main..HEAD --oneline` — list all commits on this branch
   - `git diff main...HEAD --stat` — summarize changed files
2. If there are uncommitted changes, ask the user if they want to commit first
3. If the branch has no commits ahead of main, report that and stop
4. Analyze all commits and changed files to understand what was done
5. Push the branch: `git push -u origin HEAD`
6. Create the PR using `gh pr create`:

```
gh pr create --title "<short title>" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points describing what changed and why>

## Changes
<list of key changes by area>

## Test plan
- [ ] `npm run lint` passes
- [ ] `npm run type-check` passes
- [ ] `npm run build` succeeds
- [ ] Manual testing: <specific scenarios>
EOF
)"
```

## Rules

- PR title under 70 characters, use conventional commit style: `feat(scope): description`
- Base branch is `main` unless user specifies otherwise
- Do NOT use `--assignee` or any flag that would attribute the PR to Claude
- Return the PR URL when done
