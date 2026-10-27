'use strict';

// Pure classifier: no network, no github-script globals. Input is the jobs of
// ONE run attempt in the REST shape of GET /actions/runs/{id}/attempts/{n}/jobs,
// each non-success job carrying `annotations` from GET /check-runs/{id}/annotations.

const RUNNER_CLASSES = ['RUNNER_LOST', 'TIMEOUT_STUCK', 'TIMEOUT_NOSTEPS', 'TIMEOUT_SETUP'];

const LOST = 'The self-hosted runner lost communication with the server';
const TIMEOUT = 'The job has exceeded the maximum execution time';
const DOWNLOAD = [/Failed to download archive '?https:\/\/codeload\.github\.com\//, /Failed to resolve action download info/];
const FAIL_FAST = 'The strategy configuration was canceled because';
const SETUP_STEPS = new Set(['Set up job', 'Initialize containers']);
const JUDGED = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required', 'stale']);

// The runner and the server write their verdicts at line 1 of path `.github`.
// A workflow's own `::error::` lands on `.github` too, but at its log line, so
// line 1 is what tells a server verdict from an echoed sentence.
const isServerWritten = (a) => a.annotation_level === 'failure' && a.path === '.github' && a.start_line === 1;

const setupFailed = (steps) => steps.some((s) => s.name === 'Set up job' && s.conclusion === 'failure');

const classifyJob = (job) => {
    if (!JUDGED.has(job.conclusion)) return null;
    const annotations = job.annotations || [];
    const steps = job.steps || [];
    const server = annotations.filter(isServerWritten).map((a) => a.message || '');

    if (server.some((m) => m.includes(LOST))) return 'RUNNER_LOST';
    if (server.some((m) => m.includes(TIMEOUT))) {
        if (steps.length === 0) return 'TIMEOUT_NOSTEPS';
        if (steps.some((s) => s.status === 'in_progress' && !s.completed_at)) return 'TIMEOUT_STUCK';
        if (steps.some((s) => SETUP_STEPS.has(s.name) && s.conclusion !== 'success')) return 'TIMEOUT_SETUP';
        return 'OTHER';
    }
    const text = annotations.map((a) => a.message || '').join('\n');
    if (setupFailed(steps) && DOWNLOAD.some((re) => re.test(text))) return 'INFRA_SETUP';
    return 'OTHER';
};

// A matrix fail-fast cancel or a run-level cancel is a consequence of another
// job, never a cause: cancelled with no steps and no annotations, or carrying
// the fail-fast sentence.
const isConsequentialCancel = (job) => {
    if (job.conclusion !== 'cancelled') return false;
    const annotations = job.annotations || [];
    if (annotations.some((a) => (a.message || '').includes(FAIL_FAST))) return true;
    return annotations.length === 0 && (job.steps || []).length === 0;
};

const parseList = (value) =>
    (Array.isArray(value) ? value : String(value || '').split(','))
        .map((s) => s.trim())
        .filter(Boolean);

const classifyAttempt = (jobs, rollupJobs) => {
    const rollups = new Set(parseList(rollupJobs));
    return jobs.map((job) => {
        let cls;
        if (rollups.has(job.name)) cls = 'EXCLUDED_ROLLUP';
        else if (!JUDGED.has(job.conclusion)) cls = 'NOT_JUDGED';
        else if (isConsequentialCancel(job)) cls = 'EXCLUDED_CANCEL';
        else cls = classifyJob(job);
        return {name: job.name, class: cls, runner: job.runner_name || '', conclusion: job.conclusion};
    });
};

const decide = (jobs, previous, options = {}) => {
    const classified = classifyAttempt(jobs, options.rollupJobs);
    const out = classified.map(({name, class: cls, runner}) => ({name, class: cls, runner}));
    const judged = classified.filter((j) => !['EXCLUDED_ROLLUP', 'NOT_JUDGED', 'EXCLUDED_CANCEL'].includes(j.class));
    const names = (list) => list.map((j) => j.name).join(', ');

    if (judged.length === 0) return {action: 'skip', reason: 'no non-success job to judge', jobs: out};

    const other = judged.filter((j) => j.class === 'OTHER');
    if (other.length > 0) return {action: 'hold', reason: `non-runner failure: ${names(other)}`, jobs: out};

    const runner = judged.filter((j) => RUNNER_CLASSES.includes(j.class));
    if (runner.length === 0) {
        return {action: 'hold', reason: 'no runner loss, only action-download failures', jobs: out};
    }

    const prev = previous || {};
    const twice = runner.filter((j) => RUNNER_CLASSES.includes(prev[j.name]));
    if (twice.length > 0) {
        return {
            action: 'hold',
            reason: `lost its runner twice: suspect the job (OOM/kill), not the pool: ${names(twice)}`,
            jobs: out,
        };
    }

    return {action: 'rerun', reason: `runner lost: ${names(runner)}`, jobs: out};
};

// Per-job classes of a previous attempt, for the repetition rule.
const previousClasses = (jobs, rollupJobs) => {
    const map = {};
    for (const j of classifyAttempt(jobs, rollupJobs)) map[j.name] = j.class;
    return map;
};

module.exports = {RUNNER_CLASSES, classifyJob, classifyAttempt, decide, previousClasses, parseList};
