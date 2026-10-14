const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const planSchema = require('../schemas/plan.schema.json');

const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: true });
addFormats(ajv);
const validatePlan = ajv.compile(planSchema);

const schemaValidator = (req, res, next) => {
  const valid = validatePlan(req.body);
  if (!valid) {
    return res.status(400).json({
      error: 'Validation Error',
      message: 'Request body does not match the required schema',
      details: validatePlan.errors.map(err => ({
        field: err.instancePath || err.schemaPath,
        message: err.message,
        params: err.params
      }))
    });
  }
  next();
};

module.exports = schemaValidator;
