#!/usr/bin/env node
'use strict';

// Read-only replay: classify one attempt through the action's own code path and
// print the decision. It never re-runs anything.
//   node runner-loss-retry/cli.js <owner/repo> <run_id> [attempt] [--rollup-jobs a,b] [--max-reruns N]

const {execFileSync} = require('child_process');
const {evaluate} = require('./evaluate.js');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(name);
    if (i === -1) return fallback;
    const [, value] = args.splice(i, 2);
    return value;
};
const rollupJobs = flag('--rollup-jobs', 'ci-passed,CI Passed,CI Gate');
const maxReruns = flag('--max-reruns', '2');
const [slug, runId, attempt] = args;
if (!slug || !slug.includes('/') || !runId) {
    console.error('usage: cli.js <owner/repo> <run_id> [attempt] [--rollup-jobs a,b] [--max-reruns N]');
    process.exit(64);
}
const [owner, repo] = slug.split('/');
const token = process.env.GITHUB_TOKEN || execFileSync('gh', ['auth', 'token'], {encoding: 'utf8'}).trim();

const request = async (route, params) => {
    const [method, template] = route.split(' ');
    if (method !== 'GET') throw new Error(`cli.js is read-only; refused ${route}`);
    const rest = {...params};
    const path = template.replace(/\{(\w+)\}/g, (_, k) => {
        const v = rest[k];
        delete rest[k];
        return encodeURIComponent(v);
    });
    const query = new URLSearchParams(Object.entries(rest).map(([k, v]) => [k, String(v)]));
    const res = await fetch(`https://api.github.com${path}?${query}`, {
        headers: {authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28'},
    });
    if (!res.ok) {
        const err = new Error(`${route}: HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return {data: await res.json()};
};

evaluate({request}, {owner, repo, runId, attempt, maxReruns, rollupJobs, replay: Boolean(attempt)})
    .then(({run, notes, decision}) => {
        console.log(`${slug} run ${run.id} attempt ${run.attempt} (${run.name}, ${run.event})`);
        for (const n of notes) console.log(`  note: ${n}`);
        for (const j of decision.jobs.filter((x) => x.class !== 'NOT_JUDGED')) {
            console.log(`  ${j.class.padEnd(16)} ${j.name}  [${j.runner || '-'}]`);
        }
        console.log(`DECISION: ${decision.action} (${decision.reason})`);
    })
    .catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
