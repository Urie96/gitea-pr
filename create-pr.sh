#!/usr/bin/env bash
# Open (or reuse) a pull request on Gitea and schedule its auto-merge.
#
# All inputs are read from INPUT_* environment variables (see action.yml); the
# Actions context (GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_OUTPUT) provides
# the defaults, so the script also runs standalone:
#
#   INPUT_TOKEN=... INPUT_HEAD=... INPUT_TITLE=... ./create-pr.sh
#
# Requires: bash, curl, jq, git.
#
# Exit status is 0 for "PR opened / reused / nothing to do", non-zero only for
# real failures, so a scheduled job can re-run it idempotently.
set -euo pipefail

log() { printf '[gitea-pr] %s\n' "$*" >&2; }
die() {
  log "error: $*"
  exit 1
}

token="${INPUT_TOKEN:-}"
head_branch="${INPUT_HEAD:-}"
title="${INPUT_TITLE:-}"
[ -n "$token" ] || die "input 'token' is required"
[ -n "$head_branch" ] || die "input 'head' is required"
[ -n "$title" ] || die "input 'title' is required"

server="${INPUT_SERVER_URL:-${GITHUB_SERVER_URL:-}}"
repo="${INPUT_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
base="${INPUT_BASE:-main}"
body="${INPUT_BODY:-}"
labels="${INPUT_LABELS:-}"
merge_style="${INPUT_MERGE_METHOD:-default}"
auto_merge=$(printf '%s' "${INPUT_AUTO_MERGE:-true}" | tr '[:upper:]' '[:lower:]')
delete_branch=$(printf '%s' "${INPUT_DELETE_BRANCH:-true}" | tr '[:upper:]' '[:lower:]')
commit_message="${INPUT_COMMIT_MESSAGE:-}"

[ -n "$server" ] || die "input 'server-url' (or GITHUB_SERVER_URL) is required"
[ -n "$repo" ] || die "input 'repository' (or GITHUB_REPOSITORY) is required"
api="${server%/}/api/v1/repos/$repo"

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

# request <method> <path> [json] -> $status, $response
request() {
  local method=$1 path=$2 data=${3-} code
  local -a args=(
    -sS -X "$method"
    -H "Authorization: token $token"
    -H 'Accept: application/json'
    -o "$workdir/body" -w '%{http_code}'
  )
  [ -z "$data" ] || args+=(-H 'Content-Type: application/json' -d "$data")
  code=$(curl "${args[@]}" "$api$path") || code=000
  status=$code
  response=$(cat "$workdir/body" 2>/dev/null || true)
}

# Commit the working tree to the head branch and push it (opt-in).
push_head_branch() {
  [ -n "$commit_message" ] || return 0
  git add -A
  if git diff --cached --quiet; then
    log "working tree unchanged; pushing HEAD as is"
  else
    git commit -m "$commit_message"
  fi
  git push --force origin "HEAD:refs/heads/$head_branch"
}

find_open_pr() {
  request GET "/pulls?state=open&limit=50"
  [ "$status" = 200 ] || die "listing pull requests failed: HTTP $status ${response}"
  # `head` as a query parameter is not reliable on every Gitea version, so the
  # list is filtered client-side (same approach as update-flake-inputs-gitea).
  jq -r --arg head "$head_branch" --arg base "$base" \
    '[.[] | select(.head.ref == $head and .base.ref == $base) | .number] | first // empty' \
    <<<"$response"
}

# Comma-separated list of label IDs for $labels (Gitea wants IDs, not names).
label_id_list() {
  [ -n "$labels" ] || return 0
  request GET "/labels?limit=50"
  [ "$status" = 200 ] || die "listing labels failed: HTTP $status ${response}"
  local all=$response ids="" name id
  local -a names
  IFS=',' read -r -a names <<<"$labels"
  for name in "${names[@]}"; do
    name="${name#"${name%%[![:space:]]*}"}"
    name="${name%"${name##*[![:space:]]}"}"
    [ -n "$name" ] || continue
    id=$(jq -r --arg name "$name" '[.[] | select(.name == $name) | .id] | first // empty' <<<"$all")
    [ -n "$id" ] || die "label '$name' does not exist in $repo"
    ids="${ids:+$ids,}$id"
  done
  printf '%s' "$ids"
}

push_head_branch

# A missing head branch is a normal outcome for a scheduled job: nothing was
# pushed yet, the branch was renamed, or the previous PR was merged and its
# branch deleted. Do not turn that into a failed run.
request GET "/branches/$head_branch"
case "$status" in
  200) ;;
  404)
    # Tell "the branch is gone" apart from "the repository slug is wrong".
    request GET ""
    [ "$status" = 200 ] || die "repository $repo is not reachable: HTTP $status ${response}"
    log "branch '$head_branch' does not exist in $repo; nothing to open"
    exit 0
    ;;
  *) die "checking branch '$head_branch' failed: HTTP $status ${response}" ;;
esac

number=$(find_open_pr)
pr_url=""
if [ -n "$number" ]; then
  log "pull request #$number is already open for $head_branch -> $base"
else
  ids=$(label_id_list)
  payload=$(jq -cn \
    --arg head "$head_branch" --arg base "$base" --arg title "$title" \
    --arg body "$body" --argjson labels "[${ids}]" \
    '{head: $head, base: $base, title: $title, body: $body}
     | if ($labels | length) > 0 then . + {labels: $labels} else . end')
  request POST "/pulls" "$payload"
  case "$status" in
    200 | 201)
      number=$(jq -r '.number' <<<"$response")
      pr_url=$(jq -r '.html_url // empty' <<<"$response")
      log "opened pull request #$number"
      ;;
    409)
      # A pull request for this head/base pair already exists. Only reuse it if
      # it is still open; a closed one would silently swallow the update.
      number=$(find_open_pr)
      if [ -n "$number" ]; then
        log "pull request #$number is already open for $head_branch -> $base"
      else
        log "a pull request for $head_branch -> $base exists but is closed; nothing to do"
        exit 0
      fi
      ;;
    422)
      # Most likely "No commits between ..." (the branch did not change).
      message=$(jq -r '.message // empty' <<<"$response")
      lower=$(printf '%s' "$message" | tr '[:upper:]' '[:lower:]')
      case "$lower" in
        *"no commit"* | *"no change"* | *"already exist"*)
          log "nothing to open: $message"
          exit 0
          ;;
      esac
      die "creating the pull request failed: HTTP $status $message"
      ;;
    *)
      die "creating the pull request failed: HTTP $status ${response}"
      ;;
  esac
fi

[ -n "$pr_url" ] || pr_url="${server%/}/$repo/pulls/$number"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    printf 'number=%s\n' "$number"
    printf 'url=%s\n' "$pr_url"
  } >>"$GITHUB_OUTPUT"
fi
printf '%s\n' "$pr_url"

if [ "$auto_merge" != true ]; then
  log "auto-merge disabled"
  exit 0
fi

# The merge style has to be explicit: `fast-forward-only` ignores
# merge_when_checks_succeed on some Gitea versions (go-gitea/gitea#35756).
if [ "$merge_style" = default ]; then
  request GET ""
  merge_style=""
  if [ "$status" = 200 ]; then
    merge_style=$(jq -r '.default_merge_style // empty' <<<"$response")
  fi
  : "${merge_style:=merge}"
fi

payload=$(jq -cn --arg style "$merge_style" --argjson delete "$delete_branch" \
  '{Do: $style, merge_when_checks_succeed: true, delete_branch_after_merge: $delete}')

attempt=0
while [ "$attempt" -lt 6 ]; do
  attempt=$((attempt + 1))
  request POST "/pulls/$number/merge" "$payload"
  case "$status" in
    200 | 201)
      log "auto-merge scheduled for pull request #$number"
      exit 0
      ;;
    409)
      log "pull request #$number: already merged or already scheduled"
      exit 0
      ;;
    405)
      # "Please try again later" means the PR's mergeability check is still
      # running; anything else (e.g. no permission, WIP) is a real error.
      message=$(jq -r '.message // empty' <<<"$response")
      lower=$(printf '%s' "$message" | tr '[:upper:]' '[:lower:]')
      case "$lower" in
        *"try again later"*)
          log "pull request #$number is still being checked; retrying"
          sleep 2
          ;;
        *"already merged"*)
          log "pull request #$number is already merged"
          exit 0
          ;;
        *) die "scheduling auto-merge failed: $message" ;;
      esac
      ;;
    *)
      die "scheduling auto-merge failed: HTTP $status ${response}"
      ;;
  esac
done
die "scheduling auto-merge failed: still 'try again later' after $attempt attempts"
