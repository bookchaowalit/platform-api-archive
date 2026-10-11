import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildingBlocksResponse, loadBuildingBlockCatalog } from '../../api/building_blocks.js';

test('building-block read model applies defaults and category routing', () => {
  const response = buildingBlocksResponse({});
  assert.equal(response.schema_version, 'solo-empire.building-block-services.v1');
  assert.equal(response.total, loadBuildingBlockCatalog().services.length);
  const llm = response.services.find((service) => service.id === 'llm');
  assert.equal(llm?.status, 'planned'); // generation runs in bookchaowalit/solo-ai-gateway
  assert.equal(llm?.gateway, '/api/ai');
  const sms = response.services.find((service) => service.id === 'sms');
  assert.equal(sms?.status, 'planned');
  assert.equal(sms?.approval, false);
  assert.deepEqual(sms?.impl, []);
  assert.equal(response.policy.apps_embed_provider_secrets, false);
});

test('building-block filters combine', () => {
  const response = buildingBlocksResponse({ category: 'kyc', decision: 'buy' });
  assert.ok(response.total > 0);
  assert.ok(response.services.every((service) => service.category === 'kyc' && service.decision === 'buy'));
  assert.equal(buildingBlocksResponse({ id: 'does-not-exist' }).total, 0);
});
