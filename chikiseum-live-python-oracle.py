"""Test-only independent Python authority oracle. No production auth or network."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'chikiseum_practice'))
from realtime_engine import RealtimePracticeEngine

now = 1000.0
e = RealtimePracticeEngine(clock=lambda: now, movement_clock=lambda: 100.0 + now - 1000.0)
results = []
for key, card in e.cards.items():
    for level in (1, 8, 16):
        for variant in ('base', 'shield-and-multipliers'):
            now = 1000.0
            for table in ('ledger', 'challenges', 'queue', 'matches', 'trainers'):
                e.db.execute('DELETE FROM ' + table)
            a = e.session('A', card['species'], level)
            b = e.session('B', card['species'], level)
            e.queue(a['token']); mid = e.queue(b['token'])['match_id']
            e.ready(a['token'], mid); e.ready(b['token'], mid)
            m = json.loads(e.db.execute('SELECT data FROM matches WHERE id=?', (mid,)).fetchone()[0])
            for p in m['players']:
                p['position'] = {'x': -.75 if p['side'] == 'A' else .75, 'y': 0., 'z': 0.}
                p['energy'] = 6.
                p['hp'] -= 30.
            if variant != 'base':
                m['players'][0]['statuses'] = {
                    'charge': {'slot': 4, 'source_side': 'A', 'multiplier': 1.35, 'expires_at': 1008.},
                    'rally': {'slot': 9, 'source_side': 'A', 'multiplier': 1.25, 'expires_at': 1008.},
                    'weaken': {'slot': 10, 'source_side': 'B', 'fraction': .2, 'expires_at': 1006.}}
                m['players'][1]['statuses'] = {'shield': {'slot': 3, 'source_side': 'B', 'amount': 10., 'expires_at': 1004.}}
            e._save(m)
            e.cast(a['token'], mid, 'oracle-cast-one', card['slot'])
            now += .05
            snap = e.state(a['token'], mid)
            events = [{k: v for k, v in event.items() if k not in ('id', 'seq')} for event in snap['events']]
            results.append({'key': key, 'level': level, 'variant': variant,
                'players': [{k: p[k] for k in ('hp', 'energy', 'position', 'statuses')} for p in snap['players']],
                'events': events, 'status': snap['status'], 'winner': snap.get('winner')})
e.close()
json.dump(results, sys.stdout, separators=(',', ':'))
