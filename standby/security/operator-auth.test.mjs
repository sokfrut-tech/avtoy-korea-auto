import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateOperator, digestOperatorToken, operatorCan, operatorPermissions, parseOperatorConfig } from './operator-auth.mjs';

const tokenA = 'A'.repeat(43);
const tokenB = 'B'.repeat(43);
const config = () => parseOperatorConfig(JSON.stringify([
  { id:'operator-a', tokenHash:digestOperatorToken(tokenA), role:'operator', enabled:true },
  { id:'supervisor-b', tokenHash:digestOperatorToken(tokenB), role:'supervisor', enabled:true }
]));

test('operator credentials identify distinct people and never return token digests', () => {
  const operators = config();
  assert.deepEqual(authenticateOperator('Bearer '+tokenA, operators), { id:'operator-a', role:'operator' });
  assert.deepEqual(authenticateOperator('Bearer '+tokenB, operators), { id:'supervisor-b', role:'supervisor' });
  assert.equal(authenticateOperator('Bearer '+'C'.repeat(43), operators), null);
});

test('disabled operators and malformed authorization are denied', () => {
  const disabled = parseOperatorConfig(JSON.stringify([{ id:'disabled', tokenHash:digestOperatorToken(tokenA), role:'owner', enabled:false }]));
  assert.equal(authenticateOperator('Bearer '+tokenA, disabled), null);
  assert.equal(authenticateOperator(tokenA, config()), null);
  assert.equal(authenticateOperator('Bearer short', config()), null);
  assert.equal(authenticateOperator('Bearer '+tokenA+' extra', config()), null);
});

test('operator configuration fails closed on missing, malformed, empty and duplicate entries', () => {
  assert.throws(() => parseOperatorConfig(''), /required/);
  assert.throws(() => parseOperatorConfig('{'), /valid JSON/);
  assert.throws(() => parseOperatorConfig('[]'), /1–100/);
  const duplicate = JSON.stringify([
    { id:'same', tokenHash:digestOperatorToken(tokenA), role:'operator', enabled:true },
    { id:'same', tokenHash:digestOperatorToken(tokenB), role:'viewer', enabled:true }
  ]);
  assert.throws(() => parseOperatorConfig(duplicate), /Duplicate/);
});

test('operator configuration rejects weak hashes, unknown roles and non-boolean enabled flags', () => {
  assert.throws(() => parseOperatorConfig(JSON.stringify([{id:'x',tokenHash:'abc',role:'operator',enabled:true}])), /SHA-256/);
  assert.throws(() => parseOperatorConfig(JSON.stringify([{id:'x',tokenHash:digestOperatorToken(tokenA),role:'root',enabled:true}])), /role/);
  assert.throws(() => parseOperatorConfig(JSON.stringify([{id:'x',tokenHash:digestOperatorToken(tokenA),role:'operator',enabled:1}])), /boolean/);
});

test('role permission matrix is enforced independently of the UI', () => {
  const [viewer, operator, supervisor, owner] = ['viewer','operator','supervisor','owner'].map(role=>({role}));
  assert.equal(operatorCan(viewer,'inbox:read'),true);
  assert.equal(operatorCan(viewer,'notifications:retry'),false);
  assert.equal(operatorCan(operator,'audit:read'),false);
  assert.equal(operatorCan(supervisor,'notifications:retry'),true);
  assert.equal(operatorCan(supervisor,'operators:manage'),false);
  assert.equal(operatorCan(owner,'retention:manage'),true);
  assert.deepEqual(operatorPermissions('unknown'),[]);
});

test('token digest helper requires a 256-bit base64url token shape', () => {
  assert.equal(digestOperatorToken(tokenA).length,64);
  assert.throws(() => digestOperatorToken('weak'), /high-entropy/);
});
