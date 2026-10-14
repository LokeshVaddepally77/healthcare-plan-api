# Healthcare Plan Management API

[![Test](https://github.com/LokeshVaddepally77/healthcare-plan-api/actions/workflows/test.yml/badge.svg)](https://github.com/LokeshVaddepally77/healthcare-plan-api/actions/workflows/test.yml)

A secure, event-driven REST API for managing healthcare plan documents. Every request is authenticated with a Google-issued RS256 bearer token, every write is validated against a JSON Schema, and every change is pushed through RabbitMQ into Elasticsearch, where plans are indexed as parent-child documents for search.

## Highlights

- **Google OAuth2 / JWT (RS256):** bearer tokens are verified against Google's public JWKS keys (`jwks-rsa`), with issuer checks.
- **JSON Schema validation:** request bodies are validated with Ajv before anything is stored.
- **Conditional requests with ETags:** `GET` honors `If-None-Match` (returns `304 Not Modified`), and `PUT` / `PATCH` honor `If-Match` (returns `412 Precondition Failed` on a stale ETag).
- **JSON merge patch:** `PATCH` merges partial updates into nested plan objects.
- **Cascaded delete:** deleting a plan removes all of its child objects.
- **Event-driven indexing:** writes publish messages to RabbitMQ, and a separate consumer indexes them into Elasticsearch using a parent-child (`join`) mapping.

## Architecture

```
Client ──Bearer token──▶ Express API ──▶ Key-value store
                             │
                             └──▶ RabbitMQ queue ──▶ Consumer ──▶ Elasticsearch ◀── Kibana
```

## Tech stack

Node.js · Express · Ajv · jsonwebtoken · jwks-rsa · RabbitMQ (amqplib) · Elasticsearch 7 · Kibana · Docker Compose

## API

All `/api` routes require `Authorization: Bearer <Google ID token>`.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/plan` | Create a plan (validated against the schema) |
| `GET` | `/api/v1/plan/:id` | Get a plan (supports `If-None-Match`) |
| `PUT` | `/api/v1/plan/:id` | Replace a plan (supports `If-Match`) |
| `PATCH` | `/api/v1/plan/:id` | Merge-patch a plan (supports `If-Match`) |
| `DELETE` | `/api/v1/plan/:id` | Cascaded delete of a plan and its children |
| `GET` | `/api/v1/plans` | List all plans |
| `GET` | `/health` | Health check (no auth) |

## Run it locally

Requirements: Node.js 18+ and Docker.

```bash
# 1. Start Elasticsearch, Kibana and RabbitMQ
docker-compose up -d

# 2. Install dependencies and configure
npm install
cp .env.example .env

# 3. Create the Elasticsearch index, then start the consumer and the API
npm run setup-index
npm run consumer     # in a second terminal
npm start
```

- API: http://localhost:3000
- Kibana: http://localhost:5601
- RabbitMQ management UI: http://localhost:15672

To call the API, get a Google ID token (for example from the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)) and send it as a bearer token.

## Tests

40 Jest + Supertest tests, run by GitHub Actions on every push. RabbitMQ and Google's key server are mocked, so the tests need no Docker or network:

- **Endpoints:** create, read, list, merge patch, replace and delete; `409` on duplicates, `404` on unknown plans, and schema rejections (missing fields, bad enums, bad dates, negative numbers, unknown properties).
- **Conditional requests:** `304` on a matching `If-None-Match`, `412` on a stale `If-Match`, and new ETags after every write.
- **Merge patch:** nested merging, adding and updating array items by `objectId`, and rejecting a patch whose merged result breaks the schema.
- **Token verification:** valid Google RS256 tokens pass; missing or malformed headers, HS256 tokens, missing key IDs, foreign issuers, unknown keys, expired tokens and forged signatures are all rejected.

```bash
npm test
```

## Project structure

```
config/storage.js            key-value store
middleware/tokenVerifier.js  Google RS256 token verification
middleware/validator.js      Ajv schema validation
routes/plan.js               REST endpoints, ETags, merge patch
schemas/plan.schema.json     JSON Schema for a plan
services/rabbitmq.js         publisher
services/consumer.js         queue consumer → Elasticsearch
services/elasticsearch.js    client and parent-child mapping
services/setupIndex.js       index creation
utils/etag.js                ETag generation
tests/                       Jest + Supertest tests
```

Built for INFO 7255 (Advanced Big-Data Applications and Indexing Techniques) at Northeastern University.
