#!/usr/bin/env node
// Open (or reuse) a pull request on Gitea/Forgejo and schedule its auto-merge.
//
// All inputs are read from INPUT_* environment variables (see action.yml); the
// Actions context (GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_OUTPUT) provides
// the defaults, so the script also runs standalone:
//
//   INPUT_TOKEN=... INPUT_HEAD=... INPUT_TITLE=... node index.js
//
// Requires: node >= 18 (global fetch). Dependency-free on purpose: no
// package.json, no node_modules, nothing to build.
//
// Exits 0 for "PR opened / reused / nothing to do", non-zero only for real
// failures, so a scheduled job can call it idempotently.

"use strict";

const fs = require("node:fs");

const log = (message) => process.stderr.write(`[gitea-pr] ${message}\n`);

function fail(message) {
  log(`error: ${message}`);
  process.exit(1);
}

function input(name, fallback = "") {
  const raw = process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`];
  return raw === undefined || raw === "" ? fallback : raw;
}

function flag(name, fallback = "true") {
  return !/^(false|0|no)$/i.test(input(name, fallback));
}

const token = input("token");
const headBranch = input("head");
const title = input("title");
if (!token) fail("input 'token' is required");
if (!headBranch) fail("input 'head' is required");
if (!title) fail("input 'title' is required");

const server = (input("server-url") || process.env.GITHUB_SERVER_URL || "").replace(
  /\/+$/,
  "",
);
const repo = input("repository") || process.env.GITHUB_REPOSITORY || "";
if (!server) fail("input 'server-url' (or GITHUB_SERVER_URL) is required");
if (!repo) fail("input 'repository' (or GITHUB_REPOSITORY) is required");

const base = input("base", "main");
const body = input("body");
const labels = input("labels");
const mergeMethod = input("merge-method", "default");
const autoMerge = flag("auto-merge");
const deleteBranch = flag("delete-branch");
const labelColor = input("label-color", "#ededed");

/** How long to wait for Gitea to finish computing a new PR's mergeability. */
const MERGEABLE_TIMEOUT_MS = 120_000;

const api = `${server}/api/v1/repos/${repo}`;

/** Encode a ref for a URL without escaping the slashes Gitea routes on. */
const encodeRef = (ref) => ref.split("/").map(encodeURIComponent).join("/");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Call the Gitea API; never throws for HTTP errors, returns { status, body }. */
async function call(method, path, payload, { raw = false } = {}) {
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/json",
  };
  if (payload !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`${api}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { status: 0, body: { message: String(error) } };
  }

  const text = await response.text();
  if (raw) return { status: response.status, body: text };
  let parsed;
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch {
    parsed = { message: text };
  }
  return { status: response.status, body: parsed };
}

const describe = (payload) =>
  typeof payload?.message === "string" ? payload.message : JSON.stringify(payload);

let repositoryCache;

/** The repository object, fetched once: several checks need it. */
async function getRepository() {
  if (repositoryCache === undefined) repositoryCache = await call("GET", "");
  return repositoryCache;
}

/**
 * A missing head branch is a normal outcome for a scheduled job: nothing was
 * pushed yet, the branch was renamed, or the previous PR was merged and its
 * branch deleted. Do not turn that into a failed run.
 *
 * @returns {Promise<boolean>} whether the head branch exists
 */
async function headBranchExists() {
  const path = `/branches/${encodeRef(headBranch)}`;
  const { status, body: response } = await call("GET", path);
  if (status === 200) return true;
  if (status === 404) {
    // Tell "the branch is gone" apart from "the repository slug is wrong".
    const repository = await getRepository();
    if (repository.status !== 200) {
      throw new Error(
        `repository ${repo} is not reachable: HTTP ${repository.status} ${describe(repository.body)}`,
      );
    }
    log(`branch '${headBranch}' does not exist in ${repo}; nothing to open`);
    return false;
  }
  throw new Error(`checking branch '${headBranch}' failed: HTTP ${status} ${describe(response)}`);
}

/** Number of the open PR whose head is `headBranch`, or null. */
async function findOpenPr() {
  const { status, body: pulls } = await call("GET", "/pulls?state=open&limit=50");
  if (status !== 200 || !Array.isArray(pulls)) {
    // A repository with its "Pull Requests" unit switched off answers 404 and
    // `{"message":"not found"}`, which reads like a wrong URL. Name the actual
    // cause instead of leaving the user to guess.
    if (status === 404) {
      const repository = await getRepository();
      if (repository.status === 200 && repository.body?.has_pull_requests === false) {
        throw new Error(
          `the 'Pull Requests' unit is disabled for ${repo}; enable it in the repository settings (Settings -> Advanced Settings)`,
        );
      }
    }
    throw new Error(`listing pull requests failed: HTTP ${status} ${describe(pulls)}`);
  }
  // `head` as a query parameter is not honoured by every Gitea version, so the
  // list is filtered here instead.
  const found = pulls.find(
    (pull) => pull.head?.ref === headBranch && pull.base?.ref === base,
  );
  return found ? found.number : null;
}

/**
 * Whether `headBranch` would add anything to `base` at all.
 *
 * Gitea happily creates a pull request for two identical branches (the PR then
 * just says "empty", with no diff), which is noise for a nightly job. The
 * compare API answers that question directly: `base...head` lists the commits
 * reachable from `head` but not from `base` (`merge-base..head`), which is
 * exactly what the pull request would contain.
 *
 * @returns {Promise<boolean>} true when there is nothing to open
 */
async function nothingToMerge() {
  const range = `${encodeRef(base)}...${encodeRef(headBranch)}`;

  const compared = await call("GET", `/compare/${range}`);
  if (compared.status !== 200 || typeof compared.body?.total_commits !== "number") {
    log(
      `comparing ${base}...${headBranch} failed: HTTP ${compared.status} ${describe(compared.body)}; opening the pull request anyway`,
    );
    return false;
  }
  if (compared.body.total_commits > 0) return false;

  // Zero commits also happens when the branches share no history at all (the
  // comparison is empty then), where a pull request may still be wanted, so
  // confirm with the diff itself: an empty diff means nothing to merge.
  const diff = await call("GET", `/compare/${range}?output=diff`, undefined, { raw: true });
  if (diff.status !== 200) {
    log(
      `reading the diff of ${base}...${headBranch} failed: HTTP ${diff.status}; opening the pull request anyway`,
    );
    return false;
  }
  if (diff.body.trim() !== "") return false;

  log(`${headBranch} adds no commits and no changes on top of ${base}; nothing to open`);
  return true;
}

/** All labels of the repository, across pages (the API caps the page size). */
async function listLabels() {
  const all = [];
  const pageSize = 50;
  for (let page = 1; page <= 20; page += 1) {
    const { status, body } = await call("GET", `/labels?page=${page}&limit=${pageSize}`);
    if (status !== 200 || !Array.isArray(body)) {
      throw new Error(`listing labels failed: HTTP ${status} ${describe(body)}`);
    }
    all.push(...body);
    if (body.length < pageSize) return all;
  }
  throw new Error("listing labels failed: too many pages");
}

/**
 * Label IDs for the `labels` input (Gitea wants IDs, not names). Labels that
 * do not exist yet are created with `label-color`, which keeps the workflow
 * self-contained: adding a name to `labels` is enough.
 */
async function labelIds() {
  const wanted = labels
    .split(/[\n,]/)
    .map((label) => label.trim())
    .filter(Boolean);
  if (wanted.length === 0) return [];

  const known = await listLabels();
  const ids = [];
  for (const name of wanted) {
    const existing = known.find((candidate) => candidate.name === name);
    if (existing) {
      ids.push(existing.id);
      continue;
    }

    const { status, body: created } = await call("POST", "/labels", {
      name,
      color: labelColor,
    });
    if (status === 200 || status === 201) {
      log(`created label '${name}' (#${created.id})`);
      known.push(created);
      ids.push(created.id);
      continue;
    }

    // A concurrent run may have created the label after our listing; Gitea
    // answers such a duplicate with a 5xx instead of a 409.
    const raced = (await listLabels()).find((candidate) => candidate.name === name);
    if (raced) {
      known.push(raced);
      ids.push(raced.id);
      continue;
    }
    throw new Error(`creating label '${name}' failed: HTTP ${status} ${describe(created)}`);
  }
  return ids;
}

async function resolveMergeMethod() {
  if (mergeMethod !== "default") return mergeMethod;
  const { status, body: repository } = await getRepository();
  const style = status === 200 ? repository?.default_merge_style : "";
  return style || "merge";
}

/**
 * Which merge styles the repository allows, for the error message of a rejected
 * merge: a repository with every style switched off can still have PRs, and the
 * API only answers `405 merge is not allowed for this repository`.
 */
async function allowedMergeStyles() {
  const { status, body: repository } = await getRepository();
  if (status !== 200) return "";
  const enabled = [
    ["merge", repository.allow_merge_commits],
    ["squash", repository.allow_squash_merge],
    ["rebase", repository.allow_rebase || repository.allow_rebase_explicit],
    ["fast-forward-only", repository.allow_fast_forward_only_merge],
  ]
    .filter(([, allowed]) => allowed)
    .map(([style]) => style);
  return enabled.length === 0
    ? " (no merge style is enabled in the repository settings)"
    : ` (merge styles enabled: ${enabled.join(", ")})`;
}

/**
 * Ask Gitea to merge the PR once its required checks pass. Scheduling before
 * any check has run is fine: Gitea re-evaluates the schedule when the commit
 * statuses of the PR head turn green.
 */
async function scheduleAutoMerge(number) {
  const payload = {
    Do: await resolveMergeMethod(),
    merge_when_checks_succeed: true,
    delete_branch_after_merge: deleteBranch,
  };

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { status, body: response } = await call("POST", `/pulls/${number}/merge`, payload);
    const message = describe(response);

    if (status === 200 || status === 201) {
      log(`auto-merge scheduled for pull request #${number}`);
      return;
    }
    if (status === 409) {
      log(`pull request #${number}: already merged or already scheduled`);
      return;
    }
    // A push may have moved the head between the readiness poll and this call,
    // which puts the PR back into "checking". Retrying is cheaper than failing.
    if (status === 405 && /try again later/i.test(message) && attempt < maxAttempts) {
      log(`pull request #${number} is still being checked; retrying`);
      await sleep(2000);
      continue;
    }
    if (status === 405) {
      throw new Error(
        `scheduling auto-merge failed: HTTP ${status} ${message}${await allowedMergeStyles()}`,
      );
    }
    throw new Error(`scheduling auto-merge failed: HTTP ${status} ${message}`);
  }
  throw new Error("scheduling auto-merge failed: still 'try again later'");
}

/**
 * Gitea computes the mergeability of a new PR in a background job, and until it
 * finishes the merge endpoint answers `405 Please try again later`
 * (services/pull.CheckPullMergeable -> ErrNotMergeableState). Poll the PR rather
 * than hammering the merge endpoint: the API's `mergeable` is false while the
 * check runs, on a conflict and on a check error.
 *
 * @returns {Promise<"mergeable" | "gone" | "stuck">}
 */
async function waitForMergeable(number) {
  const deadline = Date.now() + MERGEABLE_TIMEOUT_MS;
  let delay = 1000;
  let waiting = false;

  for (;;) {
    const { status, body: pull } = await call("GET", `/pulls/${number}`);
    if (status !== 200) {
      throw new Error(`reading pull request #${number} failed: HTTP ${status} ${describe(pull)}`);
    }
    if (pull.state !== "open") {
      log(`pull request #${number} is ${pull.state}; not scheduling a merge`);
      return "gone";
    }
    if (pull.mergeable) return "mergeable";

    if (Date.now() + delay > deadline) return "stuck";
    if (!waiting) {
      log(`pull request #${number} is still being checked by Gitea; waiting for it`);
      waiting = true;
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 5000);
  }
}

function writeOutput(values) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  fs.appendFileSync(file, lines);
}

async function main() {
  if (!(await headBranchExists())) return;

  let number = await findOpenPr();
  let url = "";

  if (number !== null) {
    log(`pull request #${number} is already open for ${headBranch} -> ${base}`);
  } else {
    if (await nothingToMerge()) return;

    const ids = await labelIds();
    const payload = { head: headBranch, base, title, body };
    if (ids.length > 0) payload.labels = ids;

    const { status, body: created } = await call("POST", "/pulls", payload);

    if (status === 200 || status === 201) {
      number = created.number;
      url = created.html_url || "";
      log(`opened pull request #${number}`);
    } else if (status === 409) {
      // A pull request for this head/base pair already exists. Only reuse it if
      // it is still open; a closed one would silently swallow the update.
      number = await findOpenPr();
      if (number === null) {
        log(`a pull request for ${headBranch} -> ${base} exists but is closed; nothing to do`);
        return;
      }
      log(`pull request #${number} is already open for ${headBranch} -> ${base}`);
    } else if (status === 422) {
      // Most likely "No commits between ..." (the branch did not change).
      const message = describe(created);
      if (/no commit|no change|already exist/i.test(message)) {
        log(`nothing to open: ${message}`);
        return;
      }
      throw new Error(`creating the pull request failed: HTTP ${status} ${message}`);
    } else {
      throw new Error(`creating the pull request failed: HTTP ${status} ${describe(created)}`);
    }
  }

  const prUrl = url || `${server}/${repo}/pulls/${number}`;
  writeOutput({ number, url: prUrl });
  process.stdout.write(`${prUrl}\n`);

  if (!autoMerge) {
    log("auto-merge disabled");
    return;
  }

  const readiness = await waitForMergeable(number);
  if (readiness === "gone") return;
  if (readiness === "stuck") {
    throw new Error(
      `pull request #${number} did not become mergeable within ${MERGEABLE_TIMEOUT_MS / 1000}s: ` +
        "Gitea is still checking it, it has a merge conflict, or its title marks it as work in progress",
    );
  }
  await scheduleAutoMerge(number);
}

main().catch((error) => {
  log(`error: ${error.message}`);
  process.exitCode = 1;
});
