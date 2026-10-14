require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { connectStore } = require('./config/storage');
const planRoutes = require('./routes/plan');
const tokenVerifier = require('./middleware/tokenVerifier');
const { connectRabbitMQ } = require('./services/rabbitmq');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    storage: 'In-Memory',
    elasticsearch: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
    rabbitmq: 'connected'
  });
});

// All API routes protected by Bearer token
app.use('/api', tokenVerifier, planRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested endpoint does not exist',
    path: req.path
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred'
  });
});

// Start server
const startServer = async () => {
  try {
    // Initialize storage
    const storageConnected = await connectStore();
    if (!storageConnected) {
      console.error('Failed to initialize storage.');
      process.exit(1);
    }

    // Connect to RabbitMQ
    const mqConnected = await connectRabbitMQ();
    if (!mqConnected) {
      console.error('Failed to connect to RabbitMQ. Make sure Docker is running.');
      console.error('Run: docker-compose up -d');
      process.exit(1);
    }

    app.listen(PORT, () => {
      console.log(`
╔════════════════════════════════════════════════════════════╗
║   Healthcare Plan API Server — Demo 3                     ║
║   Version: 3.0.0                                          ║
║   Port: ${PORT}                                              ║
║   Storage: In-Memory Key-Value Store                      ║
║   Search: Elasticsearch (Parent-Child)                    ║
║   Queue: RabbitMQ                                         ║
║   Security: Google IDP + RS256 Bearer Token               ║
╚════════════════════════════════════════════════════════════╝

API Endpoints (all require Bearer token):
  POST   /api/v1/plan         - Create plan (→ KV store + RabbitMQ → ES)
  GET    /api/v1/plan/:id     - Get plan (conditional: If-None-Match)
  PATCH  /api/v1/plan/:id     - Merge patch (→ KV store + RabbitMQ → ES)
  PUT    /api/v1/plan/:id     - Replace plan (→ KV store + RabbitMQ → ES)
  DELETE /api/v1/plan/:id     - Cascaded delete (→ KV store + RabbitMQ → ES)
  GET    /api/v1/plans        - List all plans

Public Endpoints:
  GET    /health              - Health check

⚠️  Make sure the consumer is running: npm run consumer
🔗 Kibana: http://localhost:5601 (for search queries)
🔗 RabbitMQ: http://localhost:15672 (guest/guest)
      `);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  process.exit(0);
});

startServer();
