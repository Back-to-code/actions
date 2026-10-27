'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {classifyJob, decide} = require('../classify.js');
const replay = require('./fixtures/replay.json');

const ROLLUPS = 'ci-passed,CI Passed,CI Gate';
const LOST =
    'The self-hosted runner lost communication with the server. Verify the machine is running and has a healthy network connection.';
const server = (message) => ({annotation_level: 'failure', path: '.github', start_line: 1, message});
const done = (name, conclusion = 'success') => ({name, status: 'completed', conclusion, completed_at: 'x'});
const job = (name, conclusion, steps, annotations) => ({name, conclusion, steps, annotations});
const lostJob = (name) => job(name, 'failure', [done('Set up job'), {status: 'in_progress', conclusion: null, completed_at: null}], [server(LOST)]);
const testFailure = (name) => job(name, 'failure', [done('Set up job'), done('Run tests', 'failure')], [{...server('Process completed with exit code 1.'), start_line: 88}]);

test('the 29 recorded dropout attempts reproduce sim.json: 22 rerun, 6 hold, 1 out of scope', () => {
    assert.equal(replay.length, 29);
    const got = {rerun: [], hold: [], 'out-of-scope': []};
    for (const attempt of replay) {
        const {action} = decide(attempt.jobs, null, {rollupJobs: ROLLUPS});
        if (attempt.expected === 'out-of-scope') {
            // The scheduled run classifies as a runner loss; the
            // event gate in evaluate.js skips it (see evaluate.test.js).
            assert.equal(attempt.event, 'schedule');
            assert.equal(action, 'rerun', attempt.label);
        } else {
            assert.equal(action, attempt.expected, attempt.label);
        }
        got[attempt.expected].push(attempt.label);
    }
    assert.equal(got.rerun.length, 22);
    assert.deepEqual(got.hold, [
        'repo-b run-09 a1',
        'repo-b run-16 a1',
        'repo-c run-17 a1',
        'repo-b run-18 a1',
        'repo-b run-23 a1',
        'repo-b run-29 a1',
    ]);
    assert.deepEqual(got['out-of-scope'], ['repo-a run-06 a1']);
});

test('every recorded hold names a non-runner job, and every rerun names a runner loss', () => {
    for (const attempt of replay) {
        const {action, jobs} = decide(attempt.jobs, null, {rollupJobs: ROLLUPS});
        const classes = jobs.map((j) => j.class);
        if (action === 'hold') assert.ok(classes.includes('OTHER'), attempt.label);
        if (action === 'rerun') {
            assert.ok(classes.some((c) => c.startsWith('RUNNER_') || c.startsWith('TIMEOUT_')), attempt.label);
            assert.ok(!classes.includes('OTHER'), attempt.label);
        }
    }
});

test('the lost-communication sentence echoed through ::error:: is OTHER', () => {
    const echoedAtLogLine = job('lint', 'failure', [done('Set up job'), done('Echo', 'failure')], [{...server(LOST), start_line: 42}]);
    const wrongPath = job('lint', 'failure', [done('Set up job'), done('Echo', 'failure')], [{...server(LOST), path: 'ci.sh'}]);
    const asWarning = job('lint', 'failure', [done('Set up job'), done('Echo', 'failure')], [{...server(LOST), annotation_level: 'warning'}]);
    for (const j of [echoedAtLogLine, wrongPath, asWarning]) assert.equal(classifyJob(j), 'OTHER');
    assert.equal(classifyJob(lostJob('lint')), 'RUNNER_LOST');
    assert.equal(decide([echoedAtLogLine], null, {rollupJobs: ROLLUPS}).action, 'hold');
});

test('a codeload-429 WARNING on a job that then timed out mid-workload is not INFRA_SETUP', () => {
    const j = job(
        'Backend Feature Tests (2/2)',
        'cancelled',
        [done('Set up job'), done('Checkout'), done('Run tests', 'cancelled'), done('Post Checkout')],
        [
            {annotation_level: 'warning', path: '.github', start_line: 12, message: "Failed to download archive 'https://codeload.github.com/actions/checkout/tar.gz/abc'. Error: 429"},
            server('The job has exceeded the maximum execution time of 20m0s'),
        ],
    );
    assert.equal(classifyJob(j), 'OTHER');
});

test('a Set up job that FAILED on an action download is INFRA_SETUP', () => {
    const j = job('frontend (1/2)', 'failure', [done('Set up job', 'failure')], [
        {annotation_level: 'failure', path: '.github', start_line: 21, message: "Failed to download archive 'https://codeload.github.com/actions/checkout/tar.gz/abc'."},
    ]);
    assert.equal(classifyJob(j), 'INFRA_SETUP');
});

test('a runner loss plus one real test failure holds', () => {
    const d = decide([lostJob('backend-test'), testFailure('frontend (1/2)')], null, {rollupJobs: ROLLUPS});
    assert.equal(d.action, 'hold');
    assert.match(d.reason, /frontend \(1\/2\)/);
});

test('the same job losing its runner on two attempts holds', () => {
    const d = decide([lostJob('backend-test')], {'backend-test': 'RUNNER_LOST'}, {rollupJobs: ROLLUPS});
    assert.equal(d.action, 'hold');
    assert.match(d.reason, /lost its runner twice: suspect the job \(OOM\/kill\), not the pool/);
    assert.equal(decide([lostJob('backend-test')], {'backend-mysql (1/2)': 'RUNNER_LOST'}, {rollupJobs: ROLLUPS}).action, 'rerun');
});

test('rollups and consequential cancels are left out of the decision', () => {
    const failFast = job('backend-mysql (1/2)', 'cancelled', [], []);
    const d = decide([lostJob('backend-mysql (2/2)'), failFast, testFailure('ci-passed')], null, {rollupJobs: ROLLUPS});
    assert.equal(d.action, 'rerun');
    assert.deepEqual(
        d.jobs.map((j) => j.class),
        ['RUNNER_LOST', 'EXCLUDED_CANCEL', 'EXCLUDED_ROLLUP'],
    );
    const userCancel = job('backend-test', 'cancelled', [done('Set up job'), done('Run', 'cancelled')], [{...server('The run was canceled by @someone.'), start_line: 1}]);
    assert.equal(decide([lostJob('x'), userCancel], null, {rollupJobs: ROLLUPS}).action, 'hold');
});

test('timeouts split by what the runner left behind', () => {
    const t = server('The job has exceeded the maximum execution time of 15m0s');
    assert.equal(classifyJob(job('a', 'cancelled', [], [t])), 'TIMEOUT_NOSTEPS');
    assert.equal(classifyJob(job('a', 'cancelled', [done('Set up job'), {status: 'in_progress', conclusion: null, completed_at: null}], [t])), 'TIMEOUT_STUCK');
    assert.equal(classifyJob(job('a', 'cancelled', [done('Set up job', 'failure')], [t])), 'TIMEOUT_SETUP');
    assert.equal(classifyJob(job('a', 'cancelled', [done('Set up job'), done('Run', 'cancelled')], [t])), 'OTHER');
});

test('only action-download failures hold, and a clean attempt skips', () => {
    const infra = job('frontend (1/2)', 'failure', [done('Set up job', 'failure')], [
        {annotation_level: 'failure', path: '.github', start_line: 3, message: 'Failed to resolve action download info.'},
    ]);
    assert.equal(decide([infra], null, {rollupJobs: ROLLUPS}).action, 'hold');
    assert.equal(decide([job('a', 'success', [], [])], null, {rollupJobs: ROLLUPS}).action, 'skip');
});
