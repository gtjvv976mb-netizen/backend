/* Bounded source-bound engine test runner. Generates QA artifacts, not game state. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const folder = dirname(fileURLToPath(import.meta.url));
const prefix = process.argv[2] ?? '/private/tmp/chikiseum-production-engine-qa-v1';
const files = ['chikiseum-live-engine.js', 'chikiseum-live-engine.test.js', 'chikiseum-live-parity.test.js',
  'chikiseum-live-engine-qa.js',
  'chikiseum-live-python-oracle.py', 'chikiseum-live-navigation.js', 'chikiseum-live-navigation.test.js',
  'chikiseum-profiles.json', 'chikiseum-species-traits.json', 'chikiseum_reference_arena_v2.json', 'CHIKISEUM-LIVE-ENGINE.md',
  '../chikiseum_practice/engine.py', '../chikiseum_practice/realtime_engine.py', '../chikiseum_practice/reference_arena.py'];
const sha = raw => createHash('sha256').update(raw).digest('hex');
const hashes = () => Object.fromEntries(files.map(file => [file, sha(readFileSync(resolve(folder, file)))]));
const before = hashes();
const stdout = execFileSync(process.execPath, ['--test', '--test-reporter=spec', 'chikiseum-live-engine.test.js',
  'chikiseum-live-parity.test.js', 'chikiseum-live-navigation.test.js'], { cwd: folder, encoding: 'utf8', timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
const after = hashes();
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('QA source changed during test run');
if (!/tests 39\b/.test(stdout) || !/pass 39\b/.test(stdout) || !/fail 0\b/.test(stdout)) throw new Error('Incomplete engine/navigation test gates');
const navLine = stdout.split('\n').find(line => line.startsWith('CHIKISEUM_NODE_NAVIGATION_QA_JSON '));
if (!navLine) throw new Error('Navigation evidence missing');
const navigation = JSON.parse(navLine.slice('CHIKISEUM_NODE_NAVIGATION_QA_JSON '.length));
const capacityLine = stdout.split('\n').find(line => line.startsWith('CHIKISEUM_CHECKPOINT_CAPACITY_JSON '));
if (!capacityLine) throw new Error('Full-cache checkpoint capacity evidence missing');
const capacity = JSON.parse(capacityLine.slice('CHIKISEUM_CHECKPOINT_CAPACITY_JSON '.length));
writeFileSync(prefix + '.log', stdout);
const receipt = { schema: 'chikiseum.production-realtime-engine-qa/v1', status: 'pass', tests: 39, failures: 0,
  canonical_card_cases: 2412, canonical_card_count: 402, tier_levels: [1, 8, 16], states: ['base', 'shield-and-multipliers'],
  original_python_differential: true, actual_hash_bound_navigation: true, activation_authorized: false,
  deployment_performed: false, production_auth_proven: false, real_sol_enabled: false, currency: 'NONE',
  inventory_verified_requires_trusted_adapter: true, level_policy: 'separate_server_earned_pvp',
  source_sha256: before, source_unchanged_after_tests: true,
  navigation_checks: { parity: navigation.parity_checks, independent_prefix: navigation.independent_prefix_checks,
    float32_endpoints: navigation.float32_endpoint_checks }, navigation_benchmarks: navigation.benchmarks,
  engine_defaults: { max_admissions: 512, max_matches: 128, session_ttl_seconds: 900, terminal_ttl_seconds: 300,
    max_events_per_match: 1024, max_cast_ids_per_match: 4096, max_move_ids_per_match: 16384 },
  completion_contract: 'non_destructive_drain_then_ack_after_durable_idempotent_progress_commit',
  full_cache_checkpoint_capacity: capacity,
  restart_contract: 'cancel_ready_and_active_no_winner_or_xp_preserve_finished_completions',
  historical_attempts: [{ tests: 22, passed: 21, failures: 1, cause: 'Test expected full6s despite valid40ms post-resolution elapsed; test predicate repaired' },
    { tests: 23, passed: 22, failures: 1, cause: 'Oracle path URL escaped workspace space; fileURLToPath test-only repair' }],
  raw_log: prefix + '.log', raw_log_sha256: sha(stdout), generated_at: new Date().toISOString() };
const json = JSON.stringify(receipt, null, 2) + '\n'; writeFileSync(prefix + '.json', json);
console.log(JSON.stringify({ receipt: prefix + '.json', sha256: sha(json), log: prefix + '.log', log_sha256: sha(stdout), tests: 39, failures: 0 }));
