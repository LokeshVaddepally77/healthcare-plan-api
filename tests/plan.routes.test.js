const express = require('express');
const request = require('supertest');

// Replace RabbitMQ so the tests don't need a running broker
jest.mock('../services/rabbitmq', () => ({ publishMessage: jest.fn().mockResolvedValue(true) }));

const { publishMessage } = require('../services/rabbitmq');
const { memoryStore } = require('../config/storage');
const planRoutes = require('../routes/plan');
const { samplePlan, secondService } = require('./fixtures');

const app = express();
app.use(express.json());
app.use('/api', planRoutes);

const PLAN_ID = samplePlan().objectId;
const planUrl = `/api/v1/plan/${PLAN_ID}`;

const createPlan = () => request(app).post('/api/v1/plan').send(samplePlan());

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

beforeEach(() => {
  memoryStore.store.clear();
  publishMessage.mockClear();
});

describe('POST /api/v1/plan', () => {
  test('creates a plan, returns its ETag and location, and queues it for indexing', async () => {
    const res = await createPlan();

    expect(res.status).toBe(201);
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(res.headers.location).toBe(planUrl);
    expect(res.body.objectId).toBe(PLAN_ID);
    expect(publishMessage).toHaveBeenCalledWith('create', samplePlan());
  });

  test('rejects a second plan with the same objectId', async () => {
    await createPlan();
    const res = await createPlan();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Conflict');
  });

  test.each([
    ['a required field is missing', (p) => { delete p.planType; }],
    ['an enum value is wrong', (p) => { p.planType = 'premium'; }],
    ['the date has the wrong format', (p) => { p.creationDate = '2017-12-12'; }],
    ['a nested number is negative', (p) => { p.planCostShares.copay = -5; }],
    ['an unknown property is sent', (p) => { p.discount = 10; }]
  ])('rejects the plan when %s', async (_, breakIt) => {
    const plan = samplePlan();
    breakIt(plan);

    const res = await request(app).post('/api/v1/plan').send(plan);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation Error');
    expect(res.body.details.length).toBeGreaterThan(0);
    expect(publishMessage).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/plan/:id', () => {
  test('returns the stored plan with its ETag', async () => {
    const created = await createPlan();

    const res = await request(app).get(planUrl);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(samplePlan());
    expect(res.headers.etag).toBe(created.headers.etag);
  });

  test('returns 304 Not Modified when If-None-Match matches', async () => {
    const created = await createPlan();

    const res = await request(app).get(planUrl).set('If-None-Match', created.headers.etag);

    expect(res.status).toBe(304);
    expect(res.text).toBe('');
  });

  test('returns the full plan when If-None-Match is stale', async () => {
    await createPlan();

    const res = await request(app).get(planUrl).set('If-None-Match', '"stale"');

    expect(res.status).toBe(200);
    expect(res.body.objectId).toBe(PLAN_ID);
  });

  test('returns 404 for an unknown plan', async () => {
    const res = await request(app).get('/api/v1/plan/does-not-exist');

    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/plans', () => {
  test('lists a summary of every plan', async () => {
    await createPlan();
    const other = samplePlan();
    other.objectId = 'second-plan';
    other.planType = 'outNetwork';
    await request(app).post('/api/v1/plan').send(other);

    const res = await request(app).get('/api/v1/plans');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.plans).toEqual(expect.arrayContaining([
      { objectId: PLAN_ID, planType: 'inNetwork', creationDate: '12-12-2017' },
      { objectId: 'second-plan', planType: 'outNetwork', creationDate: '12-12-2017' }
    ]));
  });
});

describe('PATCH /api/v1/plan/:id (merge patch)', () => {
  test('merges nested objects and adds array items by objectId', async () => {
    const created = await createPlan();

    const res = await request(app)
      .patch(planUrl)
      .set('If-Match', created.headers.etag)
      .send({ planCostShares: { copay: 30 }, linkedPlanServices: [secondService()] });

    expect(res.status).toBe(200);
    expect(res.body.planCostShares.copay).toBe(30);
    expect(res.body.planCostShares.deductible).toBe(2000);
    expect(res.body.linkedPlanServices.map((s) => s.objectId))
      .toEqual(['27283xvx9asdff-504', '27283xvx9sdf-507']);
    expect(res.headers.etag).not.toBe(created.headers.etag);
    expect(publishMessage).toHaveBeenCalledWith('update', res.body);
  });

  test('updates an existing array item in place when its objectId matches', async () => {
    await createPlan();

    const res = await request(app).patch(planUrl).send({
      linkedPlanServices: [{ objectId: '27283xvx9asdff-504', linkedService: { name: 'Annual physical' } }]
    });

    expect(res.status).toBe(200);
    expect(res.body.linkedPlanServices).toHaveLength(1);
    expect(res.body.linkedPlanServices[0].linkedService.name).toBe('Annual physical');
    expect(res.body.linkedPlanServices[0].linkedService.objectType).toBe('service');
  });

  test('returns 412 and changes nothing when If-Match is stale', async () => {
    await createPlan();

    const res = await request(app).patch(planUrl).set('If-Match', '"stale"').send({ planCostShares: { copay: 99 } });

    expect(res.status).toBe(412);
    expect((await request(app).get(planUrl)).body.planCostShares.copay).toBe(23);
    expect(publishMessage).not.toHaveBeenCalledWith('update', expect.anything());
  });

  test('rejects a patch whose merged result breaks the schema', async () => {
    await createPlan();

    const res = await request(app).patch(planUrl).send({ planCostShares: { copay: -1 } });

    expect(res.status).toBe(400);
    expect((await request(app).get(planUrl)).body.planCostShares.copay).toBe(23);
  });

  test('returns 404 for an unknown plan', async () => {
    const res = await request(app).patch('/api/v1/plan/does-not-exist').send({ planType: 'outNetwork' });

    expect(res.status).toBe(404);
  });
});

describe('PUT /api/v1/plan/:id', () => {
  test('replaces the plan when If-Match is current', async () => {
    const created = await createPlan();
    const replacement = samplePlan();
    replacement.planType = 'outNetwork';

    const res = await request(app).put(planUrl).set('If-Match', created.headers.etag).send(replacement);

    expect(res.status).toBe(200);
    expect((await request(app).get(planUrl)).body.planType).toBe('outNetwork');
    expect(publishMessage).toHaveBeenCalledWith('update', replacement);
  });

  test('returns 412 when If-Match is stale', async () => {
    await createPlan();

    const res = await request(app).put(planUrl).set('If-Match', '"stale"').send(samplePlan());

    expect(res.status).toBe(412);
  });

  test('validates the replacement body', async () => {
    await createPlan();
    const replacement = samplePlan();
    delete replacement.linkedPlanServices;

    const res = await request(app).put(planUrl).send(replacement);

    expect(res.status).toBe(400);
  });

  test('returns 404 for an unknown plan', async () => {
    const plan = samplePlan();
    plan.objectId = 'does-not-exist';

    const res = await request(app).put('/api/v1/plan/does-not-exist').send(plan);

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/v1/plan/:id', () => {
  test('deletes the plan and queues the delete for the search index', async () => {
    await createPlan();

    const res = await request(app).delete(planUrl);

    expect(res.status).toBe(204);
    expect((await request(app).get(planUrl)).status).toBe(404);
    expect(publishMessage).toHaveBeenCalledWith('delete', { objectId: PLAN_ID });
  });

  test('returns 404 for an unknown plan', async () => {
    const res = await request(app).delete('/api/v1/plan/does-not-exist');

    expect(res.status).toBe(404);
  });
});
