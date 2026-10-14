const crypto = require('crypto');

const generateETag = (data) => {
  const hash = crypto
    .createHash('md5')
    .update(JSON.stringify(data))
    .digest('hex');
  return `"${hash}"`;
};

const etagMatches = (requestETag, currentETag) => {
  if (!requestETag || !currentETag) return false;
  const cleanRequestETag = requestETag.replace(/"/g, '');
  const cleanCurrentETag = currentETag.replace(/"/g, '');
  return cleanRequestETag === cleanCurrentETag;
};

module.exports = { generateETag, etagMatches };
