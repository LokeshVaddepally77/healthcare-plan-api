const express = require('express');
const router = express.Router();
const { memoryStore } = require('../config/storage');
const schemaValidator = require('../middleware/validator');
const { generateETag, etagMatches } = require('../utils/etag');
const { publishMessage } = require('../services/rabbitmq');

const API_VERSION = 'v1';
const PLAN_KEY_PREFIX = 'plan:';

// ═══════════════════════════════════════════════════════════
//  POST /v1/plan — Create a new plan
//  Demo 3: Also publishes to RabbitMQ → Elasticsearch
// ═══════════════════════════════════════════════════════════

router.post(`/${API_VERSION}/plan`, schemaValidator, async (req, res) => {
  try {
    const planData = req.body;
    const objectId = planData.objectId;
    const key = `${PLAN_KEY_PREFIX}${objectId}`;

    const exists = await memoryStore.exists(key);
    if (exists) {
      return res.status(409).json({
        error: 'Conflict',
        message: `Plan with objectId '${objectId}' already exists`
      });
    }

    const etag = generateETag(planData);

    // Step 1: Store in key-value store (fast)
    await memoryStore.set(key, JSON.stringify(planData));
    await memoryStore.set(`${key}:etag`, etag);

    // Step 2: Publish to RabbitMQ queue (fast) → consumer will index in Elasticsearch
    await publishMessage('create', planData);

    res.status(201)
      .set('ETag', etag)
      .set('Location', `/api/${API_VERSION}/plan/${objectId}`)
      .json({
        message: 'Plan created successfully',
        objectId: objectId,
        etag: etag
      });
  } catch (error) {
    console.error('Error creating plan:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to create plan' });
  }
});

// ═══════════════════════════════════════════════════════════
//  GET /v1/plan/:id — Retrieve a plan by objectId
//  Supports conditional GET with If-None-Match header
// ═══════════════════════════════════════════════════════════

router.get(`/${API_VERSION}/plan/:id`, async (req, res) => {
  try {
    const objectId = req.params.id;
    const key = `${PLAN_KEY_PREFIX}${objectId}`;

    const planDataStr = await memoryStore.get(key);
    if (!planDataStr) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Plan with objectId '${objectId}' not found`
      });
    }

    const planData = JSON.parse(planDataStr);
    const storedETag = await memoryStore.get(`${key}:etag`);

    const ifNoneMatch = req.get('If-None-Match');
    if (ifNoneMatch && etagMatches(ifNoneMatch, storedETag)) {
      return res.status(304).set('ETag', storedETag).end();
    }

    res.status(200)
      .set('ETag', storedETag)
      .set('Cache-Control', 'private, max-age=3600')
      .json(planData);
  } catch (error) {
    console.error('Error retrieving plan:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to retrieve plan' });
  }
});

// ═══════════════════════════════════════════════════════════
//  DELETE /v1/plan/:id — Cascaded delete
//  Demo 3: Deletes from key-value store AND publishes
//  delete message to RabbitMQ → Elasticsearch
// ═══════════════════════════════════════════════════════════

router.delete(`/${API_VERSION}/plan/:id`, async (req, res) => {
  try {
    const objectId = req.params.id;
    const key = `${PLAN_KEY_PREFIX}${objectId}`;

    const exists = await memoryStore.exists(key);
    if (!exists) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Plan with objectId '${objectId}' not found`
      });
    }

    // Step 1: Delete from key-value store
    await memoryStore.del(key);
    await memoryStore.del(`${key}:etag`);

    // Step 2: Publish delete message to RabbitMQ → consumer will delete from Elasticsearch
    await publishMessage('delete', { objectId: objectId });

    res.status(204).end();
  } catch (error) {
    console.error('Error deleting plan:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to delete plan' });
  }
});

// ═══════════════════════════════════════════════════════════
//  GET /v1/plans — List all plans
// ═══════════════════════════════════════════════════════════

router.get(`/${API_VERSION}/plans`, async (req, res) => {
  try {
    const keys = await memoryStore.keys(`${PLAN_KEY_PREFIX}*`);
    const planKeys = keys.filter(key => !key.endsWith(':etag'));

    const plans = [];
    for (const key of planKeys) {
      const planDataStr = await memoryStore.get(key);
      if (planDataStr) {
        const planData = JSON.parse(planDataStr);
        plans.push({
          objectId: planData.objectId,
          planType: planData.planType,
          creationDate: planData.creationDate
        });
      }
    }

    res.status(200).json({ count: plans.length, plans: plans });
  } catch (error) {
    console.error('Error listing plans:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to list plans' });
  }
});

// ═══════════════════════════════════════════════════════════
//  PATCH /v1/plan/:id — Merge Patch
//  Demo 3: Patch must work all the way to the index
//  After patching in key-value store, publishes update
//  message to RabbitMQ → Elasticsearch re-indexes
// ═══════════════════════════════════════════════════════════

router.patch(`/${API_VERSION}/plan/:id`, async (req, res) => {
  try {
    const objectId = req.params.id;
    const key = `${PLAN_KEY_PREFIX}${objectId}`;
    const patchData = req.body;

    const planDataStr = await memoryStore.get(key);
    if (!planDataStr) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Plan with objectId '${objectId}' not found`
      });
    }

    const storedETag = await memoryStore.get(`${key}:etag`);

    // Conditional write: If-Match header
    const ifMatch = req.get('If-Match');
    if (ifMatch) {
      if (!etagMatches(ifMatch, storedETag)) {
        return res.status(412).json({
          error: 'Precondition Failed',
          message: 'The resource has been modified since you last retrieved it.',
          currentETag: storedETag,
          providedETag: ifMatch
        });
      }
    }

    // Apply merge patch
    const existingPlan = JSON.parse(planDataStr);
    const mergedPlan = mergePatch(existingPlan, patchData);

    // Validate the merged result
    const Ajv = require('ajv');
    const addFormats = require('ajv-formats');
    const planSchema = require('../schemas/plan.schema.json');
    const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: true });
    addFormats(ajv);
    const validate = ajv.compile(planSchema);
    const valid = validate(mergedPlan);

    if (!valid) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'The merged result does not match the required schema',
        details: validate.errors.map(err => ({
          field: err.instancePath || err.schemaPath,
          message: err.message,
          params: err.params
        }))
      });
    }

    // Step 1: Store updated plan in key-value store
    const newETag = generateETag(mergedPlan);
    await memoryStore.set(key, JSON.stringify(mergedPlan));
    await memoryStore.set(`${key}:etag`, newETag);

    // Step 2: Publish update to RabbitMQ → consumer will re-index in Elasticsearch
    await publishMessage('update', mergedPlan);

    res.status(200).set('ETag', newETag).json(mergedPlan);
  } catch (error) {
    console.error('Error patching plan:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to patch plan' });
  }
});

// ═══════════════════════════════════════════════════════════
//  PUT /v1/plan/:id — Full replacement
// ═══════════════════════════════════════════════════════════

router.put(`/${API_VERSION}/plan/:id`, schemaValidator, async (req, res) => {
  try {
    const objectId = req.params.id;
    const key = `${PLAN_KEY_PREFIX}${objectId}`;
    const newPlanData = req.body;

    const planDataStr = await memoryStore.get(key);
    if (!planDataStr) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Plan with objectId '${objectId}' not found`
      });
    }

    const storedETag = await memoryStore.get(`${key}:etag`);

    const ifMatch = req.get('If-Match');
    if (ifMatch) {
      if (!etagMatches(ifMatch, storedETag)) {
        return res.status(412).json({
          error: 'Precondition Failed',
          message: 'The resource has been modified since you last retrieved it.',
          currentETag: storedETag,
          providedETag: ifMatch
        });
      }
    }

    const newETag = generateETag(newPlanData);
    await memoryStore.set(key, JSON.stringify(newPlanData));
    await memoryStore.set(`${key}:etag`, newETag);

    // Publish update to RabbitMQ
    await publishMessage('update', newPlanData);

    res.status(200).set('ETag', newETag).json({
      message: 'Plan updated successfully',
      objectId: objectId,
      etag: newETag
    });
  } catch (error) {
    console.error('Error updating plan:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to update plan' });
  }
});

// ═══════════════════════════════════════════════════════════
//  DEEP MERGE PATCH UTILITY (with array merging by objectId)
// ═══════════════════════════════════════════════════════════

function mergePatch(target, patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return patch;
  }

  const result = typeof target === 'object' && target !== null && !Array.isArray(target)
    ? { ...target }
    : {};

  for (const key of Object.keys(patch)) {
    if (patch[key] === null) {
      delete result[key];
    } else if (Array.isArray(patch[key]) && Array.isArray(result[key])) {
      result[key] = mergeArrays(result[key], patch[key]);
    } else if (
      typeof patch[key] === 'object' &&
      !Array.isArray(patch[key]) &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key]) &&
      result[key] !== null
    ) {
      result[key] = mergePatch(result[key], patch[key]);
    } else {
      result[key] = patch[key];
    }
  }

  return result;
}

function mergeArrays(targetArray, patchArray) {
  const targetHasIds = targetArray.every(item => typeof item === 'object' && item !== null && item.objectId);
  const patchHasIds = patchArray.every(item => typeof item === 'object' && item !== null && item.objectId);

  if (!targetHasIds || !patchHasIds) {
    return patchArray;
  }

  const resultMap = new Map();
  for (const item of targetArray) {
    resultMap.set(item.objectId, { ...item });
  }

  for (const patchItem of patchArray) {
    const existingItem = resultMap.get(patchItem.objectId);
    if (existingItem) {
      resultMap.set(patchItem.objectId, mergePatch(existingItem, patchItem));
    } else {
      resultMap.set(patchItem.objectId, patchItem);
    }
  }

  return Array.from(resultMap.values());
}

module.exports = router;
