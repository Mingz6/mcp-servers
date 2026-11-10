# Git cheatsheet

- `git worktree add ../repo.worktrees/fix -b fix origin/main`: a second checkout for parallel work.
- `git push --force-with-lease=main:<old-sha>`: refuse the push if someone else moved the branch.
- A failed push is safe to retry; see the [retry policy](../docs/retry-policy.md) for the backoff.
