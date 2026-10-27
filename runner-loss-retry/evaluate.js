'use strict';

// The fetch-and-gate layer shared by action.yml and cli.js. `api.request(route, params)`
// must behave like Octokit's `github.request`: it resolves to `{data}`.

const {decide, previousClasses} = require('./classify.js');

const PER_PAGE = 100;
const MAX_PAGES = 20;
const SKIP_EVENTS = new Set(['schedule', 'merge_group']);
const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);

const pages = async (api, route, params, key) => {
    const all = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        const {data} = await api.request(route, {...params, per_page: PER_PAGE, page});
        const items = key ? data[key] : data;
        all.push(...items);
        if (items.length < PER_PAGE) return all;
    }
    throw new Error(`${route}: more than ${MAX_PAGES} pages`);
};

const fetchAttempt = async (api, owner, repo, runId, attempt) => {
    const jobs = await pages(
        api,
        'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
        {owner, repo, run_id: runId, attempt_number: attempt},
        'jobs',
    );
    for (const job of jobs) {
        if (job.conclusion === 'success' || job.conclusion === 'skipped' || job.conclusion === null) continue;
        job.annotations = await pages(api, 'GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations', {
            owner,
            repo,
            check_run_id: job.id,
        });
    }
    return jobs;
};

// The newer run is the verdict: a run whose head has moved is not ours to re-run.
const headMoved = async (api, owner, repo, run) => {
    if (PR_EVENTS.has(run.event)) {
        const {data} = await api.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
            owner,
            repo,
            workflow_id: run.workflow_id,
            branch: run.head_branch,
            event: run.event,
            per_page: 1,
        });
        const newest = data.workflow_runs[0];
        if (newest && newest.head_sha !== run.head_sha) {
            return `a newer ${run.event} run (${newest.id}) tests ${newest.head_sha.slice(0, 7)}`;
        }
        return null;
    }
    try {
        const {data} = await api.request('GET /repos/{owner}/{repo}/branches/{branch}', {
            owner,
            repo,
            branch: run.head_branch,
        });
        if (data.commit.sha !== run.head_sha) return `branch ${run.head_branch} moved to ${data.commit.sha.slice(0, 7)}`;
        return null;
    } catch (err) {
        if (err.status === 404) return `branch ${run.head_branch} no longer exists`;
        throw err;
    }
};

// `replay` judges a historical attempt: the freshness gates are reported as
// notes instead of skipping, so a past dropout can be classified after the fact.
const evaluate = async (api, opts) => {
    const {owner, repo, runId} = opts;
    const maxReruns = Number(opts.maxReruns ?? 2);
    const notes = [];
    const {data: run} = await api.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
        owner,
        repo,
        run_id: runId,
    });
    const attempt = Number(opts.attempt || run.run_attempt);
    const result = (decision) => ({
        run: {id: run.id, attempt, event: run.event, name: run.name, head_sha: run.head_sha, url: run.html_url},
        notes,
        decision,
    });
    const skip = (reason) => result({action: 'skip', reason, jobs: []});

    if (run.status !== 'completed' && attempt === run.run_attempt) return skip(`run is ${run.status}`);
    if (attempt > maxReruns) return skip(`run_attempt ${attempt} exceeds max-reruns ${maxReruns}`);
    if (SKIP_EVENTS.has(run.event)) return skip(`${run.event} runs are out of scope`);

    const stale = [];
    if (attempt < run.run_attempt) stale.push(`not the latest attempt (latest is ${run.run_attempt})`);
    const moved = await headMoved(api, owner, repo, run);
    if (moved) stale.push(moved);
    if (stale.length > 0) {
        if (!opts.replay) return skip(stale.join('; '));
        notes.push(...stale.map((s) => `replay ignores: ${s}`));
    }

    const jobs = await fetchAttempt(api, owner, repo, runId, attempt);
    const previous =
        attempt > 1 ? previousClasses(await fetchAttempt(api, owner, repo, runId, attempt - 1), opts.rollupJobs) : null;
    return result(decide(jobs, previous, {rollupJobs: opts.rollupJobs}));
};

const rerunFailedJobs = (api, owner, repo, runId) =>
    api.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs', {owner, repo, run_id: runId});

module.exports = {evaluate, fetchAttempt, rerunFailedJobs, pages};
