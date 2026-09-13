import test from 'node:test';
import assert from 'node:assert/strict';
import { ChikiseumProgressBook, levelFromXP } from './chikiseum-live-progression.js';
const match = (id = 'match1', overrides = {}) => ({ match_id: id, status: 'finished', winner: 'A',
  started_at: 100, completed_at: 160, players: [
    { wallet: 'walletA', asset_id: 'assetA', side: 'A', cast_count: 5, damage_dealt: 150 },
    { wallet: 'walletB', asset_id: 'assetB', side: 'B', cast_count: 4, damage_dealt: 80 }], ...overrides });
test('new battle levels start at1; levels are determined only by XP', () => {
  assert.equal(new ChikiseumProgressBook().fighter('assetA').level, 1);
  assert.equal(levelFromXP(99).level, 1); assert.equal(levelFromXP(100).level, 2);
  assert.equal(levelFromXP(300).level, 3); assert.equal(levelFromXP(43500).level, 30);
  for (const x of [-1, NaN, Infinity, 1.5, '100']) assert.throws(() => levelFromXP(x));
});
test('normal completion gives private durable XP once, without mutating existing book', () => {
  const original = new ChikiseumProgressBook();
  const first = original.withCompletion(match(), 161);
  assert.equal(original.fighter('assetA').xp, 0);
  assert.equal(first.book.fighter('assetA').xp, 30); assert.equal(first.book.fighter('assetB').xp, 18);
  const restart = new ChikiseumProgressBook(first.book.snapshot());
  assert.equal(restart.withCompletion(match(), 170).book.fighter('assetA').xp, 30);
  assert.equal(restart.withCompletion(match(), 170).repeated, true);
});
test('both players must actually cast and damage; idle/cancelled games never award', () => {
  for (const change of [{ completed_at: 120 }, { players: match().players.map(x => ({ ...x, damage_dealt: 0 })) },
    { players: match().players.map(x => ({ ...x, cast_count: 2 })) }])
    assert.equal(new ChikiseumProgressBook().withCompletion(match('idle', change), 170).book.fighter('assetA').xp, 0);
  for (const status of ['cancelled', 'forfeit', 'server_restart', 'ready_timeout', 'inactivity'])
    assert.throws(() => new ChikiseumProgressBook().withCompletion(match('bad', { status }), 170));
});
test('same-opponent rewards capped at3 per UTCday and wallet cap20', () => {
  let book = new ChikiseumProgressBook();
  for (let i = 0; i < 6; i++) book = book.withCompletion(match('m' + i), 170).book;
  assert.equal(book.fighter('assetA').xp, 90);
  for (let i = 0; i < 25; i++) {
    const players = match().players; players[1].wallet += i; players[1].asset_id += i;
    book = book.withCompletion(match('other' + i, { players }), 170).book;
  }
  assert.equal(book.fighter('assetA').xp, 600);
});
test('draw sharesXP; invalid identities/time/persistence fail closed', () => {
  const draw = new ChikiseumProgressBook().withCompletion(match('d', { winner: null, status: 'draw' }), 170);
  assert.equal(draw.book.fighter('assetA').xp, 22); assert.equal(draw.book.fighter('assetB').xp, 22);
  const players = match().players; players[1].wallet = players[0].wallet;
  assert.throws(() => new ChikiseumProgressBook().withCompletion(match('same', { players }), 170));
  assert.throws(() => new ChikiseumProgressBook().withCompletion(match(), 100));
  assert.throws(() => new ChikiseumProgressBook({ schema: 'wrong' }));
  assert.throws(() => new ChikiseumProgressBook().fighter('../profile'));
});
