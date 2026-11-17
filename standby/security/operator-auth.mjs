import { createHash, timingSafeEqual } from 'node:crypto';

const ROLES = new Set(['viewer','operator','supervisor','owner']);
const PERMISSIONS = Object.freeze({
  viewer: new Set(['inbox:read']),
  operator: new Set(['inbox:read']),
  supervisor: new Set(['inbox:read','notifications:retry','audit:read']),
  owner: new Set(['inbox:read','notifications:retry','audit:read','operators:manage','retention:manage'])
});

function tokenDigest(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function parseOperatorConfig(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new TypeError('STANDBY_OPERATORS_JSON is required');
  let entries;
  try { entries = JSON.parse(raw); } catch { throw new TypeError('STANDBY_OPERATORS_JSON must be valid JSON'); }
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 100) {
    throw new TypeError('Operator configuration must contain 1–100 operators');
  }
  const ids = new Set();
  const digests = new Set();
  const operators = entries.map((entry) => {
    const id = String(entry?.id || '');
    const digest = String(entry?.tokenHash || '').toLowerCase();
    const role = String(entry?.role || '');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new TypeError('Invalid operator id');
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError('Operator tokenHash must be a SHA-256 hex digest');
    if (!ROLES.has(role)) throw new TypeError('Invalid operator role');
    if (typeof entry.enabled !== 'boolean') throw new TypeError('Operator enabled flag must be boolean');
    if (ids.has(id) || digests.has(digest)) throw new TypeError('Duplicate operator id or token digest');
    ids.add(id); digests.add(digest);
    return Object.freeze({ id, tokenHash:digest, role, enabled:entry.enabled });
  });
  return Object.freeze(operators);
}

export function authenticateOperator(authorization, operators) {
  const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(String(authorization || ''));
  const token = match?.[1] || '';
  const candidate = Buffer.from(token ? tokenDigest(token) : '0'.repeat(64), 'hex');
  let found = null;
  for (const operator of operators || []) {
    const expected = Buffer.from(operator.tokenHash, 'hex');
    const equal = timingSafeEqual(candidate, expected);
    if (equal && operator.enabled) found = operator;
  }
  if (!token || !found) return null;
  return Object.freeze({ id:found.id, role:found.role });
}

export function operatorCan(operator, permission) {
  return Boolean(operator && PERMISSIONS[operator.role]?.has(permission));
}

export function operatorPermissions(role) {
  if (!ROLES.has(role)) return Object.freeze([]);
  return Object.freeze([...PERMISSIONS[role]]);
}

export function digestOperatorToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
    throw new TypeError('Operator token must be a high-entropy base64url string of at least 43 characters');
  }
  return tokenDigest(token);
}
