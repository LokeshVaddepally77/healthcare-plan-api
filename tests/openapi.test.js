const path = require('path');
const SwaggerParser = require('@apidevtools/swagger-parser');
const planRoutes = require('../routes/plan');

const SPEC = path.join(__dirname, '..', 'openapi.yaml');

// Express ":id" params become OpenAPI "{id}" templates
const routesInCode = () =>
  planRoutes.stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map((method) => ({
        method,
        path: '/api' + layer.route.path.replace(/:(\w+)/g, '{$1}')
      }))
    );

describe('openapi.yaml', () => {
  let spec;

  beforeAll(async () => {
    spec = await SwaggerParser.validate(SPEC);
  });

  test('is a valid OpenAPI 3 document', () => {
    expect(spec.openapi).toMatch(/^3\./);
  });

  test('documents every route in routes/plan.js', () => {
    for (const { method, path: routePath } of routesInCode()) {
      expect(spec.paths[routePath]?.[method]).toBeDefined();
    }
  });

  test('requires the bearer token on every /api route', () => {
    for (const [routePath, ops] of Object.entries(spec.paths)) {
      if (!routePath.startsWith('/api')) continue;
      for (const op of Object.values(ops).filter((o) => o.responses)) {
        expect(op.security ?? spec.security).toEqual([{ googleIdToken: [] }]);
      }
    }
  });

  test('keeps the Plan schema in step with schemas/plan.schema.json', () => {
    const jsonSchema = require('../schemas/plan.schema.json');
    const plan = spec.components.schemas.Plan;

    expect(plan.required.sort()).toEqual([...jsonSchema.required].sort());
    expect(Object.keys(plan.properties).sort()).toEqual(Object.keys(jsonSchema.properties).sort());
    expect(plan.properties.planType.enum).toEqual(jsonSchema.properties.planType.enum);
  });
});
