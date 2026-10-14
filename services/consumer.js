/**
 * RabbitMQ Consumer Process
 * 
 * This runs as a SEPARATE process from the API server.
 * It dequeues messages from RabbitMQ and writes to Elasticsearch.
 * 
 * Run with: npm run consumer
 * 
 * Why separate? Because Elasticsearch is slow (100ms+) compared to
 * the key-value store (1ms). By using a queue and a separate consumer,
 * the API response time stays fast.
 */

require('dotenv').config();
const { connectRabbitMQ, consumeMessages } = require('./rabbitmq');
const { connectElasticsearch, setupIndex, indexPlan, deletePlan } = require('./elasticsearch');

async function startConsumer() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║   Healthcare Plan — Queue Consumer                        ║
║   Dequeues from RabbitMQ → Writes to Elasticsearch        ║
╚════════════════════════════════════════════════════════════╝
  `);

  // Connect to Elasticsearch
  const esConnected = await connectElasticsearch();
  if (!esConnected) {
    console.error('Cannot start consumer without Elasticsearch');
    process.exit(1);
  }

  // Setup the index with parent-child mapping
  await setupIndex();

  // Connect to RabbitMQ
  const mqConnected = await connectRabbitMQ();
  if (!mqConnected) {
    console.error('Cannot start consumer without RabbitMQ');
    process.exit(1);
  }

  // Start consuming messages
  await consumeMessages(async (message) => {
    const { action, data } = message;

    switch (action) {
      case 'create':
        console.log(`\n📝 Processing CREATE for plan: ${data.objectId}`);
        await indexPlan(data);
        break;

      case 'update':
        console.log(`\n📝 Processing UPDATE for plan: ${data.objectId}`);
        // For update: delete old documents, then re-index the updated plan
        await deletePlan(data.objectId);
        await indexPlan(data);
        break;

      case 'delete':
        console.log(`\n🗑️  Processing DELETE for plan: ${data.objectId}`);
        await deletePlan(data.objectId);
        break;

      default:
        console.error(`Unknown action: ${action}`);
    }
  });
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down consumer...');
  process.exit(0);
});

startConsumer().catch(error => {
  console.error('Consumer failed to start:', error);
  process.exit(1);
});
