import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configFault } from '../assistant.mjs';

test('credential-shaped 400s are configuration faults', () => {
  assert.equal(configFault('This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header'), true);
  assert.equal(configFault('anthropic-workspace-id header must be a valid workspace ID.'), true);
  assert.equal(configFault('invalid x-api-key'), false);
  assert.equal(configFault('tools.0.input_schema: additionalProperties must be false'), false);
  assert.equal(configFault('messages: roles must alternate'), false);
  assert.equal(configFault(undefined), false);
});
