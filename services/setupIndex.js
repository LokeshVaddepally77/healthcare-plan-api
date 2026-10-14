/**
 * Standalone script to setup Elasticsearch index
 * Run with: npm run setup-index
 */

require('dotenv').config();
const { connectElasticsearch, setupIndex } = require('./elasticsearch');

async function run() {
  const connected = await connectElasticsearch();
  if (!connected) {
    console.error('Cannot connect to Elasticsearch');
    process.exit(1);
  }
  await setupIndex();
  console.log('Index setup complete!');
  process.exit(0);
}

run();
