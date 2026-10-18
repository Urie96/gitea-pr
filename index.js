#!/usr/bin/env node
// Open (or reuse) a pull request on Gitea/Forgejo and schedule its auto-merge.
//
// All inputs are read from INPUT_* environment variables (see action.yml); the
// Actions context (GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_OUTPUT) provides
// the defaults, so the script also runs standalone:
//
//   INPUT_TOKEN=... INPUT_HEAD=... INPUT_TITLE=... node index.js
//
// Requires: node >= 18 (global fetch) and git. Dependency-free on purpose: no
// package.json, no node_modules, nothing to build.
//
// Exits 0 for "PR opened / reused / nothing to do", non-zero only for real
// failures, so a scheduled job can call it idempotently.

"use strict";

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

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
const commitMessage = input("commit-message");

const api = `${server}/api/v1/repos/${repo}`;

/** Encode a ref for a URL without escaping the slashes Gitea routes on. */
const encodeRef = (ref) => ref.split("/").map(encodeURIComponent).join("/");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Call the Gitea API; never throws for HTTP errors, returns { status, body }. */
async function call(method, path, payload) {
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

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

/** Commit the working tree to `head` and push it (opt-in via commit-message). */
function pushHeadBranch() {
  if (!commitMessage) return;
  run("git", ["add", "-A"]);
  const clean =
    spawnSync("git", ["diff", "--cached", "--quiet"], { stdio: "ignore" }).status === 0;
  if (clean) log("working tree unchanged; pushing HEAD as is");
  else run("git", ["commit", "-m", commitMessage]);
  run("git", ["push", "--force", "origin", `HEAD:refs/heads/${headBranch}`]);
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
    const repository = await call("GET", "");
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
    throw new Error(`listing pull requests failed: HTTP ${status} ${describe(pulls)}`);
  }
  // `head` as a query parameter is not honoured by every Gitea version, so the
  // list is filtered here instead.
  const found = pulls.find(
    (pull) => pull.head?.ref === headBranch && pull.base?.ref === base,
  );
  return found ? found.number : null;
}

/** Label IDs for the `labels` input (Gitea wants IDs, not names). */
async function labelIds() {
  const wanted = labels
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  if (wanted.length === 0) return [];

  const { status, body: all } = await call("GET", "/labels?limit=50");
  if (status !== 200 || !Array.isArray(all)) {
    throw new Error(`listing labels failed: HTTP ${status} ${describe(all)}`);
  }
  return wanted.map((name) => {
    const label = all.find((candidate) => candidate.name === name);
    if (!label) throw new Error(`label '${name}' does not exist in ${repo}`);
    return label.id;
  });
}

async function resolveMergeMethod() {
  if (mergeMethod !== "default") return mergeMethod;
  const { status, body: repository } = await call("GET", "");
  const style = status === 200 ? repository?.default_merge_style : "";
  return style || "merge";
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
    // "Please try again later" means the PR is still in its mergeability check.
    if (status === 405 && /try again later/i.test(message) && attempt < maxAttempts) {
      log(`pull request #${number} is still being checked; retrying`);
      await sleep(2000);
      continue;
    }
    throw new Error(`scheduling auto-merge failed: HTTP ${status} ${message}`);
  }
  throw new Error("scheduling auto-merge failed: still 'try again later'");
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
  pushHeadBranch();
  if (!(await headBranchExists())) return;

  let number = await findOpenPr();
  let url = "";

  if (number !== null) {
    log(`pull request #${number} is already open for ${headBranch} -> ${base}`);
  } else {
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
  await scheduleAutoMerge(number);
}

main().catch((error) => {
  log(`error: ${error.message}`);
  process.exitCode = 1;
});
