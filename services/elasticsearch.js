const { Client } = require('@elastic/elasticsearch');

const ES_URL = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';
const INDEX_NAME = process.env.ELASTICSEARCH_INDEX || 'healthcare';

const esClient = new Client({ node: ES_URL });

/**
 * Check if Elasticsearch is connected
 */
async function connectElasticsearch() {
  try {
    const health = await esClient.cluster.health();
    console.log(`✓ Connected to Elasticsearch (status: ${health.body.status})`);
    return true;
  } catch (error) {
    console.error('✗ Failed to connect to Elasticsearch:', error.message);
    return false;
  }
}

/**
 * Create the index with parent-child mapping
 * 
 * The join field defines the parent-child relationships:
 *   plan → planCostShares (membercostshare)
 *   plan → linkedPlanServices (planservice)
 *   planservice → linkedService (service)
 *   planservice → planserviceCostShares (membercostshare)
 */
async function setupIndex() {
  try {
    // Delete existing index if it exists
    const exists = await esClient.indices.exists({ index: INDEX_NAME });
    if (exists.body) {
      await esClient.indices.delete({ index: INDEX_NAME });
      console.log(`  Deleted existing index: ${INDEX_NAME}`);
    }

    // Create index with parent-child mapping
    await esClient.indices.create({
      index: INDEX_NAME,
      body: {
        mappings: {
          properties: {
            // The join field that defines parent-child relationships
            plan_join: {
              type: 'join',
              relations: {
                plan: ['membercostshare', 'planservice'],
                planservice: ['service', 'membercostshare_service']
              }
            },
            // Common fields across all document types
            objectId: { type: 'keyword' },
            objectType: { type: 'keyword' },
            _org: { type: 'keyword' },
            name: { type: 'text' },
            // Plan fields
            planType: { type: 'keyword' },
            creationDate: { type: 'keyword' },
            // Cost share fields
            deductible: { type: 'integer' },
            copay: { type: 'integer' }
          }
        }
      }
    });

    console.log(`✓ Created index with parent-child mapping: ${INDEX_NAME}`);
    return true;
  } catch (error) {
    console.error('Failed to setup index:', error.message);
    return false;
  }
}

/**
 * Index a complete healthcare plan with parent-child relationships
 * Breaks down the plan into separate documents:
 *   1. Plan (parent)
 *   2. planCostShares (child of plan)
 *   3. Each linkedPlanService (child of plan)
 *   4. Each linkedService (child of planservice)
 *   5. Each planserviceCostShares (child of planservice)
 */
async function indexPlan(planData) {
  try {
    const planId = planData.objectId;

    // 1. Index the Plan (parent document)
    await esClient.index({
      index: INDEX_NAME,
      id: planId,
      body: {
        objectId: planData.objectId,
        objectType: planData.objectType,
        _org: planData._org,
        planType: planData.planType,
        creationDate: planData.creationDate,
        plan_join: {
          name: 'plan'
        }
      },
      refresh: 'true'
    });
    console.log(`  Indexed plan: ${planId}`);

    // 2. Index planCostShares (child of plan)
    const costShares = planData.planCostShares;
    if (costShares) {
      await esClient.index({
        index: INDEX_NAME,
        id: costShares.objectId,
        routing: planId,  // Must route to same shard as parent
        body: {
          objectId: costShares.objectId,
          objectType: costShares.objectType,
          _org: costShares._org,
          deductible: costShares.deductible,
          copay: costShares.copay,
          plan_join: {
            name: 'membercostshare',
            parent: planId
          }
        },
        refresh: 'true'
      });
      console.log(`  Indexed planCostShares: ${costShares.objectId}`);
    }

    // 3. Index each linkedPlanService and its children
    if (planData.linkedPlanServices) {
      for (const service of planData.linkedPlanServices) {
        const serviceId = service.objectId;

        // 3a. Index the planservice (child of plan)
        await esClient.index({
          index: INDEX_NAME,
          id: serviceId,
          routing: planId,
          body: {
            objectId: service.objectId,
            objectType: service.objectType,
            _org: service._org,
            plan_join: {
              name: 'planservice',
              parent: planId
            }
          },
          refresh: 'true'
        });
        console.log(`  Indexed planservice: ${serviceId}`);

        // 3b. Index the linkedService (child of planservice, grandchild of plan)
        const linkedService = service.linkedService;
        if (linkedService) {
          await esClient.index({
            index: INDEX_NAME,
            id: linkedService.objectId,
            routing: planId,  // Route to same shard as root parent
            body: {
              objectId: linkedService.objectId,
              objectType: linkedService.objectType,
              _org: linkedService._org,
              name: linkedService.name,
              plan_join: {
                name: 'service',
                parent: serviceId
              }
            },
            refresh: 'true'
          });
          console.log(`  Indexed linkedService: ${linkedService.objectId}`);
        }

        // 3c. Index planserviceCostShares (child of planservice, grandchild of plan)
        const serviceCostShares = service.planserviceCostShares;
        if (serviceCostShares) {
          await esClient.index({
            index: INDEX_NAME,
            id: serviceCostShares.objectId,
            routing: planId,
            body: {
              objectId: serviceCostShares.objectId,
              objectType: serviceCostShares.objectType,
              _org: serviceCostShares._org,
              deductible: serviceCostShares.deductible,
              copay: serviceCostShares.copay,
              plan_join: {
                name: 'membercostshare_service',
                parent: serviceId
              }
            },
            refresh: 'true'
          });
          console.log(`  Indexed planserviceCostShares: ${serviceCostShares.objectId}`);
        }
      }
    }

    console.log(`✓ Plan fully indexed: ${planId}`);
    return true;
  } catch (error) {
    console.error('Error indexing plan:', error.message);
    if (error.meta && error.meta.body) {
      console.error('ES Error:', JSON.stringify(error.meta.body.error, null, 2));
    }
    return false;
  }
}

/**
 * Delete all documents related to a plan (cascaded delete)
 * Removes the plan and all its children/grandchildren from the index
 */
async function deletePlan(planId) {
  try {
    // Delete all documents that are routed to this plan (children + grandchildren)
    await esClient.deleteByQuery({
      index: INDEX_NAME,
      body: {
        query: {
          bool: {
            should: [
              { term: { objectId: planId } },
              { parent_id: { type: 'membercostshare', id: planId } },
              { parent_id: { type: 'planservice', id: planId } },
              // Also delete grandchildren by matching all documents with this routing
              { match_all: {} }
            ]
          }
        }
      },
      routing: planId,
      refresh: true
    });

    // Also try to delete the parent document directly
    try {
      await esClient.delete({
        index: INDEX_NAME,
        id: planId,
        refresh: 'true'
      });
    } catch (e) {
      // May already be deleted by deleteByQuery
    }

    // Delete by routing to clean up everything associated with this plan
    await esClient.deleteByQuery({
      index: INDEX_NAME,
      body: {
        query: { match_all: {} }
      },
      routing: planId,
      refresh: true,
      conflicts: 'proceed'
    });

    console.log(`✓ Plan and all children deleted from index: ${planId}`);
    return true;
  } catch (error) {
    console.error('Error deleting plan from index:', error.message);
    return false;
  }
}

/**
 * Get count of all documents in the index
 */
async function getDocumentCount() {
  try {
    const result = await esClient.count({ index: INDEX_NAME });
    return result.body.count;
  } catch (error) {
    return 0;
  }
}

module.exports = {
  esClient,
  connectElasticsearch,
  setupIndex,
  indexPlan,
  deletePlan,
  getDocumentCount,
  INDEX_NAME
};
