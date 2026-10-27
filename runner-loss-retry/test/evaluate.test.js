'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {evaluate} = require('../evaluate.js');
const replay = require('./fixtures/replay.json');

const ROLLUPS = 'ci-passed,CI Passed,CI Gate';
const SHA = 'a'.repeat(40);
const LOST = {annotation_level: 'failure', path: '.github', start_line: 1, message: 'The self-hosted runner lost communication with the server.'};
const lostJob = (id, name) => ({id, name, conclusion: 'failure', runner_name: 'r', steps: [{name: 'Set up job', status: 'completed', conclusion: 'success', completed_at: 'x'}]});

// A fake of Octokit's `request`: routes resolve against a table, and every call is logged.
const fakeApi = ({run, attempts, annotations = {}, branchSha = SHA, newestRun = {id: run.id, head_sha: SHA}}) => {
    const calls = [];
    const request = async (route, params) => {
        calls.push(route);
        if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') return {data: run};
        if (route.endsWith('/attempts/{attempt_number}/jobs')) return {data: {jobs: params.page === 1 ? attempts[params.attempt_number] : []}};
        if (route.endsWith('/annotations')) return {data: params.page === 1 ? annotations[params.check_run_id] || [] : []};
        if (route === 'GET /repos/{owner}/{repo}/branches/{branch}') return {data: {commit: {sha: branchSha}}};
        if (route.endsWith('/workflows/{workflow_id}/runs')) return {data: {workflow_runs: [newestRun]}};
        throw new Error(`unexpected ${route}`);
    };
    return {request, calls};
};
const baseRun = (over = {}) => ({id: 7, name: 'CI', status: 'completed', run_attempt: 1, event: 'push', head_sha: SHA, head_branch: 'development', workflow_id: 3, ...over});
const opts = (over = {}) => ({owner: 'o', repo: 'r', runId: 7, maxReruns: 2, rollupJobs: ROLLUPS, ...over});

test('a fresh runner loss on a push run reruns', async () => {
    const api = fakeApi({run: baseRun(), attempts: {1: [lostJob(11, 'backend-test')]}, annotations: {11: [LOST]}});
    const {decision} = await evaluate(api, opts());
    assert.equal(decision.action, 'rerun');
    assert.ok(!api.calls.some((c) => c.startsWith('POST')), 'evaluate never re-runs');
});

test('the recorded scheduled dropout is skipped at the event gate', async () => {
    const scheduled = replay.find((a) => a.expected === 'out-of-scope');
    const jobs = scheduled.jobs.map((j, i) => ({...j, id: i}));
    const annotations = Object.fromEntries(jobs.map((j) => [j.id, j.annotations]));
    const api = fakeApi({run: baseRun({event: 'schedule'}), attempts: {1: jobs}, annotations});
    const {decision} = await evaluate(api, opts());
    assert.equal(decision.action, 'skip');
    assert.match(decision.reason, /schedule runs are out of scope/);
    assert.ok(!api.calls.some((c) => c.includes('/jobs')), 'skipped before reading jobs');
});

test('merge_group is skipped', async () => {
    const api = fakeApi({run: baseRun({event: 'merge_group'}), attempts: {}});
    assert.equal((await evaluate(api, opts())).decision.action, 'skip');
});

test('run_attempt above max-reruns is skipped', async () => {
    const api = fakeApi({run: baseRun({run_attempt: 3}), attempts: {}});
    const {decision} = await evaluate(api, opts());
    assert.equal(decision.action, 'skip');
    assert.match(decision.reason, /run_attempt 3 exceeds max-reruns 2/);
});

test('an attempt that is not the latest is skipped, and judged under replay', async () => {
    const run = baseRun({run_attempt: 2});
    const attempts = {1: [lostJob(11, 'backend-test')]};
    const annotations = {11: [LOST]};
    assert.match((await evaluate(fakeApi({run, attempts, annotations}), opts({attempt: 1}))).decision.reason, /not the latest attempt/);
    const replayed = await evaluate(fakeApi({run, attempts, annotations}), opts({attempt: 1, replay: true}));
    assert.equal(replayed.decision.action, 'rerun');
    assert.match(replayed.notes[0], /replay ignores: not the latest attempt/);
});

test('a push run whose branch moved is skipped', async () => {
    const api = fakeApi({run: baseRun(), attempts: {1: [lostJob(11, 'x')]}, annotations: {11: [LOST]}, branchSha: 'b'.repeat(40)});
    const {decision} = await evaluate(api, opts());
    assert.equal(decision.action, 'skip');
    assert.match(decision.reason, /branch development moved/);
});

test('a pull_request run with a newer run on its branch is skipped', async () => {
    const run = baseRun({event: 'pull_request', head_branch: 'feature-1'});
    const api = fakeApi({run, attempts: {1: [lostJob(11, 'x')]}, annotations: {11: [LOST]}, newestRun: {id: 8, head_sha: 'c'.repeat(40)}});
    const {decision} = await evaluate(api, opts());
    assert.equal(decision.action, 'skip');
    assert.match(decision.reason, /newer pull_request run \(8\)/);
});

test('attempt 2 reads attempt 1 and holds a job that lost its runner twice', async () => {
    const api = fakeApi({
        run: baseRun({run_attempt: 2}),
        attempts: {1: [lostJob(11, 'backend-test')], 2: [lostJob(21, 'backend-test')]},
        annotations: {11: [LOST], 21: [LOST]},
    });
    const {decision} = await evaluate(api, opts());
    assert.equal(decision.action, 'hold');
    assert.match(decision.reason, /lost its runner twice/);
});
