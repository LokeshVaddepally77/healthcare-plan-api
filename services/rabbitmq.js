const amqp = require('amqplib');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
const QUEUE_NAME = process.env.RABBITMQ_QUEUE || 'healthcare_indexing';

let connection = null;
let channel = null;

/**
 * Connect to RabbitMQ and create the queue
 */
async function connectRabbitMQ() {
  try {
    connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();

    // Create a durable queue (survives RabbitMQ restarts)
    await channel.assertQueue(QUEUE_NAME, {
      durable: true
    });

    console.log('✓ Connected to RabbitMQ');
    console.log(`  Queue: ${QUEUE_NAME}`);
    return true;
  } catch (error) {
    console.error('✗ Failed to connect to RabbitMQ:', error.message);
    return false;
  }
}

/**
 * Publish a message to the queue
 * 
 * @param {string} action - 'create', 'update', or 'delete'
 * @param {object} data - the plan data (or objectId for delete)
 */
async function publishMessage(action, data) {
  if (!channel) {
    console.error('RabbitMQ channel not available');
    return false;
  }

  const message = {
    action: action,    // 'create', 'update', 'delete'
    data: data,        // plan data or { objectId } for delete
    timestamp: new Date().toISOString()
  };

  try {
    channel.sendToQueue(
      QUEUE_NAME,
      Buffer.from(JSON.stringify(message)),
      { persistent: true }  // message survives RabbitMQ restart
    );

    console.log(`📤 Published to queue: ${action} | ${data.objectId || 'N/A'}`);
    return true;
  } catch (error) {
    console.error('Failed to publish message:', error.message);
    return false;
  }
}

/**
 * Consume messages from the queue
 * 
 * @param {function} handler - async function to process each message
 */
async function consumeMessages(handler) {
  if (!channel) {
    console.error('RabbitMQ channel not available');
    return;
  }

  // Process one message at a time
  channel.prefetch(1);

  channel.consume(QUEUE_NAME, async (msg) => {
    if (msg === null) return;

    try {
      const message = JSON.parse(msg.content.toString());
      console.log(`📥 Received from queue: ${message.action} | ${message.data?.objectId || 'N/A'}`);

      // Process the message
      await handler(message);

      // Acknowledge the message (remove from queue)
      channel.ack(msg);
      console.log(`✓ Message processed and acknowledged`);
    } catch (error) {
      console.error('Error processing message:', error.message);
      // Reject and requeue the message
      channel.nack(msg, false, true);
    }
  });

  console.log(`🔄 Consumer listening on queue: ${QUEUE_NAME}`);
}

/**
 * Close the RabbitMQ connection
 */
async function closeRabbitMQ() {
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
    console.log('RabbitMQ connection closed');
  } catch (error) {
    console.error('Error closing RabbitMQ:', error.message);
  }
}

module.exports = {
  connectRabbitMQ,
  publishMessage,
  consumeMessages,
  closeRabbitMQ
};
