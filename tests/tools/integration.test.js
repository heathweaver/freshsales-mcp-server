/**
 * Integration Test Suite
 *
 * Tests the actual running server at https://freshsales.ssc.one
 */

import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { acquireTestServer, releaseTestServer } from '../helpers/test-server.js';

const DEFAULT_BASE_URL = 'https://freshsales.ssc.one';
let baseUrl = process.env.TEST_BASE_URL || DEFAULT_BASE_URL;
let serverInfo;
let skipSuite = false;

before(async () => {
  try {
    serverInfo = await acquireTestServer();
    baseUrl = serverInfo.baseUrl;
  } catch (error) {
    skipSuite = true;
    console.warn(`⚠️  Skipping integration tests: ${error instanceof Error ? error.message : error}`);
  }
});

after(async () => {
  if (!skipSuite) {
    await releaseTestServer();
  }
});

function getAuthHeaders() {
  const token =
    serverInfo?.token ||
    process.env.MCP_ALLOWED_TOKENS?.split(',')[0]?.trim();
  return token
    ? {
        Authorization: `Bearer ${token}`,
      }
    : {};
}

// ─── Helper: initialize an MCP session ───────────────────────────────────────
async function initSession() {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...getAuthHeaders(),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    }),
  });

  const sessionId = response.headers.get('mcp-session-id');
  return { response, sessionId };
}

// ─── Helper: call an MCP tool ────────────────────────────────────────────────
async function callTool(sessionId, toolName, args = {}, id = 3) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
      ...getAuthHeaders(),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });

  assert.strictEqual(response.ok, true, `tools/call ${toolName} should return 200`);

  const text = await response.text();
  const eventData = text.split('\n').find(line => line.startsWith('data: '));
  assert.ok(eventData, 'Should have event data');

  const data = JSON.parse(eventData.replace('data: ', ''));
  const toolResult = data.result?.content?.[0]?.text;
  assert.ok(toolResult, `Tool ${toolName} should return content`);

  return JSON.parse(toolResult);
}

// ─── Server & Auth Tests ────────────────────────────────────────────────────

test('Health check endpoint responds', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const response = await fetch(`${baseUrl}/health`);
  assert.strictEqual(response.ok, true, 'Health endpoint should return 200');

  const data = await response.json();
  assert.strictEqual(data.status, 'ok');
  assert.strictEqual(data.server, 'freshsales-mcp-server-http');
});

test('MCP unauthorized without bearer token', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    }),
  });
  assert.strictEqual(response.status, 401, 'Unauthorized should return 401');
});

test('MCP initialize creates session (authorized)', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { response, sessionId } = await initSession();

  assert.strictEqual(response.ok, true, 'Initialize should return 200');
  assert.ok(sessionId, 'Should return session ID in header');

  const text = await response.text();
  const eventData = text.split('\n').find(line => line.startsWith('data: '));
  assert.ok(eventData, 'Should have event data');

  const data = JSON.parse(eventData.replace('data: ', ''));
  assert.strictEqual(data.result.serverInfo.name, 'freshsales-mcp-server-http');
});

test('MCP tools/list includes Freshsales tools (authorized)', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  assert.ok(sessionId, 'Should have session ID');

  const toolsResponse = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
      ...getAuthHeaders(),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    }),
  });

  assert.strictEqual(toolsResponse.ok, true, 'tools/list should return 200');

  const text = await toolsResponse.text();
  const eventData = text.split('\n').find(line => line.startsWith('data: '));
  assert.ok(eventData, 'Should have event data');

  const data = JSON.parse(eventData.replace('data: ', ''));
  const toolNames = data.result.tools.map(t => t.name);

  assert.ok(toolNames.includes('freshsales_list_contacts'), 'Should include freshsales_list_contacts');
  assert.ok(toolNames.includes('freshsales_get_contact'), 'Should include freshsales_get_contact');
  assert.ok(toolNames.includes('freshsales_create_contact'), 'Should include freshsales_create_contact');
  assert.ok(toolNames.includes('freshsales_list_accounts'), 'Should include freshsales_list_accounts');
  assert.ok(toolNames.includes('freshsales_create_deal'), 'Should include freshsales_create_deal');
  assert.ok(toolNames.includes('freshsales_search'), 'Should include freshsales_search');
  assert.ok(toolNames.includes('freshsales_lookup'), 'Should include freshsales_lookup');
  assert.ok(toolNames.includes('freshsales_create_note'), 'Should include freshsales_create_note');
  assert.ok(toolNames.every(name => name.startsWith('freshsales_')), 'All tool names should be freshsales_* prefixed');

  console.log(`✅ Found ${toolNames.length} Freshsales tools`);
});

// ─── Contact Tests ──────────────────────────────────────────────────────────

test('freshsales_list_contact_filters - returns available filters', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  const result = await callTool(sessionId, 'freshsales_list_contact_filters');

  assert.strictEqual(result.success, true, 'Should succeed');
  assert.ok(result.filters, 'Should return filters');
  assert.ok(Array.isArray(result.filters), 'Filters should be an array');
  assert.ok(result.filters.length > 0, 'Should have at least one filter');

  console.log(`✅ Found ${result.filters.length} contact filter(s): ${result.filters.map(f => f.name).join(', ')}`);
});

test('freshsales_list_contacts - returns contacts from first view', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();

  // Get filters first to find a view_id
  const filtersResult = await callTool(sessionId, 'freshsales_list_contact_filters', {}, 3);
  assert.ok(filtersResult.filters.length > 0, 'Need at least one filter');
  const viewId = String(filtersResult.filters[0].id);

  const result = await callTool(sessionId, 'freshsales_list_contacts', { view_id: viewId, per_page: 5 }, 4);
  assert.strictEqual(result.success, true, 'Should succeed');
  assert.ok(result.contacts, 'Should return contacts');
  assert.ok(Array.isArray(result.contacts), 'Contacts should be an array');

  console.log(`✅ Found ${result.contacts.length} contact(s) in view "${filtersResult.filters[0].name}"`);
});

test('freshsales_list_contact_fields - returns field definitions', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  const result = await callTool(sessionId, 'freshsales_list_contact_fields');

  assert.strictEqual(result.success, true, 'Should succeed');
  assert.ok(result.fields, 'Should return fields');
  assert.ok(Array.isArray(result.fields), 'Fields should be an array');
  assert.ok(result.fields.length > 0, 'Should have at least one field');

  const fieldNames = result.fields.map(f => f.name);
  console.log(`✅ Found ${result.fields.length} contact field(s)`);
  assert.ok(fieldNames.includes('first_name') || fieldNames.includes('First name'), 'Should have first_name field');
});

// ─── Sales Account Tests ────────────────────────────────────────────────────

test('freshsales_list_account_filters - returns available filters', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  const result = await callTool(sessionId, 'freshsales_list_account_filters');

  assert.strictEqual(result.success, true, 'Should succeed');
  assert.ok(result.filters, 'Should return filters');
  assert.ok(Array.isArray(result.filters), 'Filters should be an array');
  assert.ok(result.filters.length > 0, 'Should have at least one filter');

  console.log(`✅ Found ${result.filters.length} account filter(s): ${result.filters.map(f => f.name).join(', ')}`);
});

test('freshsales_list_accounts - returns accounts from first view', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();

  const filtersResult = await callTool(sessionId, 'freshsales_list_account_filters', {}, 3);
  assert.ok(filtersResult.filters.length > 0, 'Need at least one filter');
  const viewId = String(filtersResult.filters[0].id);

  const result = await callTool(sessionId, 'freshsales_list_accounts', { view_id: viewId, per_page: 5 }, 4);
  assert.strictEqual(result.success, true, 'Should succeed');
  assert.ok(result.sales_accounts, 'Should return sales_accounts');
  assert.ok(Array.isArray(result.sales_accounts), 'Sales accounts should be an array');

  console.log(`✅ Found ${result.sales_accounts.length} account(s) in view "${filtersResult.filters[0].name}"`);
});

test('freshsales_list_account_fields - returns field definitions', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  const result = await callTool(sessionId, 'freshsales_list_account_fields');

  assert.strictEqual(result.success, true, 'Should succeed');
  assert.ok(result.fields, 'Should return fields');
  assert.ok(Array.isArray(result.fields), 'Fields should be an array');
  assert.ok(result.fields.length > 0, 'Should have at least one field');

  console.log(`✅ Found ${result.fields.length} account field(s)`);
});

// ─── Deal Tests ─────────────────────────────────────────────────────────────

test('freshsales_list_deal_filters - returns available filters', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  const result = await callTool(sessionId, 'freshsales_list_deal_filters');

  assert.strictEqual(result.success, true, 'Should succeed');
  assert.ok(result.filters, 'Should return filters');
  assert.ok(Array.isArray(result.filters), 'Filters should be an array');

  console.log(`✅ Found ${result.filters.length} deal filter(s): ${result.filters.map(f => f.name).join(', ')}`);
});

test('freshsales_list_deal_fields - returns field definitions', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  const result = await callTool(sessionId, 'freshsales_list_deal_fields');

  assert.strictEqual(result.success, true, 'Should succeed');
  assert.ok(result.fields, 'Should return fields');
  assert.ok(Array.isArray(result.fields), 'Fields should be an array');

  console.log(`✅ Found ${result.fields.length} deal field(s)`);
});

// ─── Search & Lookup Tests ──────────────────────────────────────────────────

test('freshsales_search - searches across entities', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  const result = await callTool(sessionId, 'freshsales_search', { query: 'test' });

  assert.strictEqual(result.success, true, 'Search should succeed');
  assert.ok(result.results, 'Should return results');

  console.log(`✅ Search returned results`);
});

test('freshsales_lookup - looks up by field', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  const result = await callTool(sessionId, 'freshsales_lookup', {
    query: 'test',
    field: 'name',
    entities: 'sales_account',
  });

  assert.strictEqual(result.success, true, 'Lookup should succeed');
  assert.ok(result.results, 'Should return results');

  console.log(`✅ Lookup returned results`);
});

// ─── Selector Tests ─────────────────────────────────────────────────────────

test('freshsales_get_selector - returns deal stages', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  const result = await callTool(sessionId, 'freshsales_get_selector', { selector_type: 'deal_stages' });

  assert.strictEqual(result.success, true, 'Should succeed');
  assert.ok(result.data, 'Should return data');

  console.log(`✅ Got deal stages selector data`);
});

test('freshsales_get_selector - returns lead sources', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  const result = await callTool(sessionId, 'freshsales_get_selector', { selector_type: 'lead_sources' });

  assert.strictEqual(result.success, true, 'Should succeed');
  assert.ok(result.data, 'Should return data');

  console.log(`✅ Got lead sources selector data`);
});

test('freshsales_get_selector - returns business types', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  const result = await callTool(sessionId, 'freshsales_get_selector', { selector_type: 'business_types' });

  assert.strictEqual(result.success, true, 'Should succeed');
  assert.ok(result.data, 'Should return data');

  console.log(`✅ Got business types selector data`);
});

// ─── CRUD Lifecycle: Contact ────────────────────────────────────────────────

test('Contact CRUD lifecycle: create, get, update, delete', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  let contactId = null;

  try {
    // Create
    const createResult = await callTool(sessionId, 'freshsales_create_contact', {
      first_name: 'AUTOTEST',
      last_name: 'McTestface',
      email: `autotest-${Date.now()}@test.invalid`,
      job_title: 'Test Engineer',
    }, 10);
    assert.strictEqual(createResult.success, true, 'Create should succeed');
    assert.ok(createResult.contact, 'Should return contact');
    contactId = createResult.contact.id;
    console.log(`  Created contact: ${contactId}`);

    // Get
    const getResult = await callTool(sessionId, 'freshsales_get_contact', { contact_id: String(contactId) }, 11);
    assert.strictEqual(getResult.success, true, 'Get should succeed');
    assert.strictEqual(getResult.contact.first_name, 'AUTOTEST');
    console.log(`  Retrieved contact: ${getResult.contact.first_name} ${getResult.contact.last_name}`);

    // Update
    const updateResult = await callTool(sessionId, 'freshsales_update_contact', {
      contact_id: String(contactId),
      job_title: 'Senior Test Engineer',
    }, 12);
    assert.strictEqual(updateResult.success, true, 'Update should succeed');
    console.log(`  Updated contact job title`);

    // Verify update
    const verifyResult = await callTool(sessionId, 'freshsales_get_contact', { contact_id: String(contactId) }, 13);
    assert.strictEqual(verifyResult.contact.job_title, 'Senior Test Engineer', 'Job title should be updated');
    console.log(`  Verified update: job_title = "${verifyResult.contact.job_title}"`);

  } finally {
    // Delete
    if (contactId) {
      try {
        const deleteResult = await callTool(sessionId, 'freshsales_delete_contact', { contact_id: String(contactId) }, 99);
        assert.strictEqual(deleteResult.success, true, 'Delete should succeed');
        console.log(`  Deleted contact: ${contactId}`);
      } catch { /* ignore cleanup errors */ }
    }
  }

  console.log('✅ Contact CRUD lifecycle complete');
});

// ─── CRUD Lifecycle: Sales Account ──────────────────────────────────────────

test('Sales Account CRUD lifecycle: create, get, update, delete', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  let accountId = null;

  try {
    // Create
    const createResult = await callTool(sessionId, 'freshsales_create_account', {
      name: `AUTOTEST Corp ${Date.now()}`,
      website: 'https://autotest.invalid',
      city: 'Test City',
    }, 10);
    assert.strictEqual(createResult.success, true, 'Create should succeed');
    assert.ok(createResult.sales_account, 'Should return sales_account');
    accountId = createResult.sales_account.id;
    console.log(`  Created account: ${accountId}`);

    // Get
    const getResult = await callTool(sessionId, 'freshsales_get_account', { account_id: String(accountId) }, 11);
    assert.strictEqual(getResult.success, true, 'Get should succeed');
    assert.ok(getResult.sales_account.name.startsWith('AUTOTEST Corp'), 'Name should match');
    console.log(`  Retrieved account: ${getResult.sales_account.name}`);

    // Update
    const updateResult = await callTool(sessionId, 'freshsales_update_account', {
      account_id: String(accountId),
      city: 'Updated City',
    }, 12);
    assert.strictEqual(updateResult.success, true, 'Update should succeed');
    console.log(`  Updated account city`);

  } finally {
    // Delete
    if (accountId) {
      try {
        const deleteResult = await callTool(sessionId, 'freshsales_delete_account', { account_id: String(accountId) }, 99);
        assert.strictEqual(deleteResult.success, true, 'Delete should succeed');
        console.log(`  Deleted account: ${accountId}`);
      } catch { /* ignore cleanup errors */ }
    }
  }

  console.log('✅ Sales Account CRUD lifecycle complete');
});

// ─── Note on Contact ────────────────────────────────────────────────────────

test('Note lifecycle: create note on contact, then delete', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  let contactId = null;
  let noteId = null;

  try {
    // Create a test contact
    const contactResult = await callTool(sessionId, 'freshsales_create_contact', {
      first_name: 'AUTOTEST',
      last_name: 'NoteTest',
      email: `autotest-note-${Date.now()}@test.invalid`,
    }, 10);
    contactId = contactResult.contact.id;

    // Create note on contact
    const noteResult = await callTool(sessionId, 'freshsales_create_note', {
      description: 'This is an automated test note.',
      targetable_type: 'Contact',
      targetable_id: contactId,
    }, 11);
    assert.strictEqual(noteResult.success, true, 'Note creation should succeed');
    assert.ok(noteResult.note, 'Should return note');
    noteId = noteResult.note.id;
    console.log(`  Created note: ${noteId} on contact ${contactId}`);

    // Delete note
    const deleteNoteResult = await callTool(sessionId, 'freshsales_delete_note', { note_id: String(noteId) }, 12);
    assert.strictEqual(deleteNoteResult.success, true, 'Note delete should succeed');
    noteId = null;
    console.log(`  Deleted note`);

  } finally {
    if (noteId) {
      try { await callTool(sessionId, 'freshsales_delete_note', { note_id: String(noteId) }, 98); } catch { /* */ }
    }
    if (contactId) {
      try { await callTool(sessionId, 'freshsales_delete_contact', { contact_id: String(contactId) }, 99); } catch { /* */ }
    }
  }

  console.log('✅ Note lifecycle complete');
});

// ─── Task Tests ─────────────────────────────────────────────────────────────

test('freshsales_list_tasks - returns tasks', async (t) => {
  if (skipSuite) { t.skip('Integration tests disabled'); return; }

  const { sessionId } = await initSession();
  const result = await callTool(sessionId, 'freshsales_list_tasks', { filter: 'open' });

  assert.strictEqual(result.success, true, 'Should succeed');
  assert.ok(result.tasks, 'Should return tasks');
  assert.ok(Array.isArray(result.tasks), 'Tasks should be an array');

  console.log(`✅ Found ${result.tasks.length} open task(s)`);
});
