# gitea-pr

A Gitea/Forgejo composite action that opens a pull request and schedules it to
be merged once the required checks pass — the piece to reuse after a scheduled
job has cloned a repo and changed something (`nix flake update`, a version
bump, generated docs, …).

```yaml
- uses: urie96/gitea-pr
  with:
    token: ${{ secrets.BOT_TOKEN }}
    head: update/flake-inputs
    base: main
    title: Update flake inputs
    labels: dependencies
```

It is idempotent: re-running it on an unchanged branch finds the open pull
request again and re-schedules the auto-merge instead of failing.

## Requirements

- `node >= 20` (global `fetch`, stable) in the job environment; the script is
  dependency-free (no `package.json`, no `node_modules`, nothing to build)
- the `head` branch already pushed
- a **personal access token of a real user or bot account**

The token requirement is not an accident. Gitea ignores events whose actor is
the internal `gitea-actions` user (`services/actions/notifier_helper.go`: "avoiding
triggering cyclically"), and the job token (`secrets.GITEA_TOKEN`, `github.token`)
authenticates as exactly that user. A pull request opened with the job token
therefore gets **no** `pull_request` workflow run, no required status check, and
the auto-merge stays pending forever. Use a PAT, ideally from a dedicated bot
account, stored as an organization secret.

Pass the same PAT to `actions/checkout` too, otherwise a push to an already open
pull request is attributed to `gitea-actions` and its `synchronize` event is
dropped as well:

```yaml
- uses: actions/checkout@v4
  with:
    token: ${{ secrets.BOT_TOKEN }}
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `token` | – | PAT of a real user/bot (required) |
| `head` | – | Source branch (required) |
| `base` | `main` | Target branch |
| `title` | – | PR title (required) |
| `body` | `''` | PR description |
| `labels` | `''` | Label names, comma- or newline-separated; missing labels are created |
| `label-color` | `#ededed` | Color of labels created for `labels` |
| `merge-method` | `default` | `merge`, `squash`, `rebase`, `rebase-merge`, `default` |
| `auto-merge` | `true` | Schedule `merge_when_checks_succeed` |
| `delete-branch` | `true` | Delete `head` after the merge |
| `server-url` | `${{ github.server_url }}` | Gitea base URL |
| `repository` | `${{ github.repository }}` | `owner/name` |

Outputs: `number`, `url`.

### Labels

`labels` is a list of names separated by commas or newlines (spaces around a
name are trimmed, `''` means no labels). Action inputs are always strings, so a
YAML list cannot be passed; use a block scalar for one label per line:

```yaml
- uses: urie96/gitea-pr
  with:
    token: ${{ secrets.BOT_TOKEN }}
    head: update/flake-inputs
    base: main
    title: Update flake inputs
    labels: |
      dependencies
      automated
      needs-review
    label-color: '#0366d6'
```

The Gitea API takes label IDs, so the action resolves the names. Existing labels
are reused as they are; missing ones are created with `label-color`
(`POST /repos/{owner}/{repo}/labels`) before the pull request is opened, so
adding a label to the workflow needs no manual repository setup. Labels are only
applied when the pull request is created; an already open PR keeps the labels it
has.

## Example: weekly flake input update

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
    token: ${{ secrets.BOT_TOKEN }}

- id: bump
  run: |
    set -eu
    git fetch origin main
    git checkout -B update/flake-inputs origin/main
    nix flake update
    if git diff --quiet -- flake.lock; then
      echo "changed=false" >> "$GITHUB_OUTPUT"
    else
      git add flake.lock
      git commit -m "chore(flake): update flake inputs"
      git push --force origin HEAD:refs/heads/update/flake-inputs
      echo "changed=true" >> "$GITHUB_OUTPUT"
    fi

- if: steps.bump.outputs.changed == 'true'
  uses: urie96/gitea-pr
  with:
    token: ${{ secrets.BOT_TOKEN }}
    head: update/flake-inputs
    base: main
    title: chore(flake): update flake inputs
    merge-method: merge
```

## Example: nightly PR from a long-lived branch

With the no-ops above, a "merge whatever is on `daily` into `main` once a day"
job needs no shell at all — the action skips itself when `daily` is missing or
already contained in `main`:

```yaml
- uses: actions/checkout@v4
- uses: urie96/gitea-pr
  with:
    token: ${{ secrets.BOT_TOKEN }}
    head: daily
    base: main
    title: Nightly merge daily into main
    merge-method: merge
```

## Example: one pull request per item (loop)

The action handles a *single* pull request, so a script that opens many PRs in a
loop (for example `nix run .#updater -- --pr`) cannot use it as one step. Two
options there:

1. let the script call the merge endpoint itself right after it created a PR —
   `POST /repos/{owner}/{repo}/pulls/{number}/merge` with
   `{"Do":"merge","merge_when_checks_succeed":true,"delete_branch_after_merge":true}`
   (this is what `Mic92/update-flake-inputs-gitea` does in Python);
2. keep a small `auto-merge` job in the PR workflow that only schedules the
   merge, and have the script just set a label (the pattern used by `pr.yml` in
   `nur-packages`).

Both end up doing the same API call; option 1 removes the second job, option 2
keeps the merge decision tied to the checks.

## How the merge is scheduled

```
POST /repos/{owner}/{repo}/pulls/{number}/merge
{"Do":"merge","merge_when_checks_succeed":true,"delete_branch_after_merge":true}
```

Gitea stores that in `pull_auto_merge` and re-evaluates it when the PR becomes
mergeable and whenever a commit status turns `success`, so scheduling it right
after creating the PR is safe even though no check has run yet.

Handled as success (all of these exit 0, so a scheduled job stays green):

- `404` on the head branch: nothing pushed yet, branch renamed, or already
  merged and deleted. The repository itself is probed first, so a typo in the
  repository slug is still an error.
- `409` (already merged or already scheduled).
- `405` with "try again later": the PR is still being checked; retried up to 6
  times.
- `422` "no commits/changes": the branch is identical to the base.
- an existing open PR for the same `head`/`base` is reused.

Notes:

- `fast-forward-only` ignores `merge_when_checks_succeed` on some Gitea versions
  (go-gitea/gitea#35756), which is why the merge method is always sent
  explicitly.
- A pull request for the same `head`/`base` that is already *closed* is not
  reused; the job logs "nothing to do" and exits 0.
- Auto-merge survives later force-pushes to the branch: the scheduled record
  stays and is re-queued for the new head commit.

## Using it from your own instance

`DEFAULT_ACTIONS_URL` decides how a bare `uses: owner/repo@ref` is resolved
(default: `github.com`, i.e. GitHub), so `uses: urie96/gitea-pr` resolves on
GitHub. To reference this action from your own Gitea instance, either set
`[actions] DEFAULT_ACTIONS_URL = self` in `app.ini` (the bare form then resolves
locally) or use an absolute URL:

```yaml
- uses: https://git.example.com/urie96/gitea-pr@v1
```

Pin a tag rather than the default branch: `git tag v1 && git push --tags` and
then use `uses: urie96/gitea-pr@v1`.

## License

MIT
