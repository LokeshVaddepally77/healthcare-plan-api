const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// A local RSA key pair stands in for Google's signing keys
const { publicKey: mockPublicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

// Serve that key from a fake JWKS client instead of calling googleapis.com
jest.mock('jwks-rsa', () => () => ({
  getSigningKey: (kid, callback) => {
    if (kid === 'unknown-kid') return callback(new Error('no matching key'));
    return callback(null, { getPublicKey: () => mockPublicKey });
  }
}));

const tokenVerifier = require('../middleware/tokenVerifier');

const signToken = (claims = {}, options = {}) =>
  jwt.sign({ sub: 'user-123', email: 'test@example.com', ...claims }, privateKey, {
    algorithm: 'RS256',
    keyid: 'test-kid',
    issuer: 'https://accounts.google.com',
    expiresIn: '1h',
    ...options
  });

// Calls the middleware the way Express would, and reports what happened
const run = (authorization) =>
  new Promise((resolve) => {
    const req = { get: (name) => (name === 'Authorization' ? authorization : undefined) };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, req }); return this; }
    };
    tokenVerifier(req, res, () => resolve({ status: 'next', req }));
  });

describe('tokenVerifier', () => {
  test('accepts a valid RS256 token from Google and attaches the user', async () => {
    const result = await run(`Bearer ${signToken()}`);

    expect(result.status).toBe('next');
    expect(result.req.user.sub).toBe('user-123');
    expect(result.req.user.email).toBe('test@example.com');
  });

  test.each([
    ['no Authorization header', undefined, 'Missing or invalid Authorization header'],
    ['a non-Bearer scheme', 'Basic dXNlcjpwYXNz', 'Missing or invalid Authorization header'],
    ['an empty Bearer token', 'Bearer ', 'Bearer token is empty'],
    ['a value that is not a JWT', 'Bearer not-a-jwt', 'could not decode JWT header']
  ])('rejects %s', async (_, header, message) => {
    const result = await run(header);

    expect(result.status).toBe(401);
    expect(result.body.message).toContain(message);
  });

  test('rejects tokens signed with HS256', async () => {
    const token = jwt.sign({ sub: 'x' }, 'shared-secret', { algorithm: 'HS256', issuer: 'https://accounts.google.com' });

    const result = await run(`Bearer ${token}`);

    expect(result.status).toBe(401);
    expect(result.body.message).toContain("Unsupported algorithm 'HS256'");
  });

  test('rejects a token without a key ID', async () => {
    const token = jwt.sign({ sub: 'x' }, privateKey, { algorithm: 'RS256', issuer: 'https://accounts.google.com' });

    const result = await run(`Bearer ${token}`);

    expect(result.status).toBe(401);
    expect(result.body.message).toContain('missing key ID');
  });

  test('rejects a token from an issuer that is not Google', async () => {
    const result = await run(`Bearer ${signToken({}, { issuer: 'https://evil.example.com' })}`);

    expect(result.status).toBe(401);
    expect(result.body.message).toContain('not in the allow list');
  });

  test('rejects a token whose signing key cannot be found', async () => {
    const result = await run(`Bearer ${signToken({}, { keyid: 'unknown-kid' })}`);

    expect(result.status).toBe(401);
    expect(result.body.message).toContain("Unable to find signing key for kid 'unknown-kid'");
  });

  test('rejects an expired token', async () => {
    const token = jwt.sign({ sub: 'user-123', exp: Math.floor(Date.now() / 1000) - 60 }, privateKey, {
      algorithm: 'RS256',
      keyid: 'test-kid',
      issuer: 'https://accounts.google.com'
    });

    const result = await run(`Bearer ${token}`);

    expect(result.status).toBe(401);
    expect(result.body.message).toBe('Token has expired');
  });

  test('rejects a token signed by a different private key', async () => {
    const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    });
    const forged = jwt.sign({ sub: 'attacker' }, otherKey, { algorithm: 'RS256', keyid: 'test-kid', issuer: 'https://accounts.google.com' });

    const result = await run(`Bearer ${forged}`);

    expect(result.status).toBe(401);
    expect(result.body.message).toContain('invalid signature');
  });
});
