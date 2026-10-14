const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const ALLOWED_ISSUERS = [
  'https://accounts.google.com',
  'accounts.google.com'
];

const client = jwksClient({
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
  cache: true,
  cacheMaxAge: 600000,
  rateLimit: true,
  jwksRequestsPerMinute: 10
});

function getSigningKey(kid) {
  return new Promise((resolve, reject) => {
    client.getSigningKey(kid, (err, key) => {
      if (err) reject(err);
      else resolve(key.getPublicKey());
    });
  });
}

const tokenVerifier = async (req, res, next) => {
  try {
    const authHeader = req.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing or invalid Authorization header. Expected: Bearer <token>'
      });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Bearer token is empty' });
    }

    const decodedHeader = jwt.decode(token, { complete: true });
    if (!decodedHeader || !decodedHeader.header) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid token format — could not decode JWT header'
      });
    }

    const { alg, kid } = decodedHeader.header;

    if (alg !== 'RS256') {
      return res.status(401).json({
        error: 'Unauthorized',
        message: `Unsupported algorithm '${alg}'. Only RS256 is accepted.`
      });
    }

    if (!kid) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Token header is missing key ID (kid)' });
    }

    const payload = decodedHeader.payload;
    if (!payload.iss || !ALLOWED_ISSUERS.includes(payload.iss)) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: `Token issuer '${payload.iss}' is not in the allow list.`
      });
    }

    let signingKey;
    try {
      signingKey = await getSigningKey(kid);
    } catch (keyError) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: `Unable to find signing key for kid '${kid}'.`
      });
    }

    const verified = jwt.verify(token, signingKey, {
      algorithms: ['RS256'],
      issuer: ALLOWED_ISSUERS
    });

    req.user = verified;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Unauthorized', message: 'Token has expired', expiredAt: error.expiredAt });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Unauthorized', message: `Token verification failed: ${error.message}` });
    }
    return res.status(401).json({ error: 'Unauthorized', message: 'Token verification failed' });
  }
};

module.exports = tokenVerifier;
