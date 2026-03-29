import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import express, { type Response } from 'express';
import cors from 'cors';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const SCOPES = ['freshsales.read', 'freshsales.write'] as const;
const DEFAULT_SCOPE = SCOPES.join(' ');
const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// Freshsales IDs are numeric
const ID_REGEX = /^[0-9]+$/;

type ToolResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
};

type ToolConfig = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown) => Promise<ToolResponse>;
};

function ensureId(value: unknown, field: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${field} must be a string or number`);
  }
  const str = String(value).trim();
  if (!ID_REGEX.test(str)) {
    throw new Error(`${field} must be a valid Freshsales ID (numeric string)`);
  }
  return str;
}

function ensureOptionalId(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return ensureId(value, field);
}

function ensureString(
  value: unknown,
  field: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {}
): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  if (!allowEmpty && value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  return value;
}

function ensureOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return ensureString(value, field);
}

function ensureOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${field} must be a number`);
  }
  return value;
}

function ensureOptionalIntegerInRange(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function ensureOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function ensureOptionalEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function ensureObject<T extends Record<string, unknown>>(value: unknown, field: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as T;
}

function buildToolResponse(payload: unknown, isError: boolean): ToolResponse {
  return {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
    isError,
  };
}

function idSchema(description: string) {
  return {
    type: 'string',
    description: `${description} Provide the Freshsales ID (numeric string).`,
  };
}

type FreshsalesRequestOptions = {
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
};

class FreshsalesClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(apiKey: string, subdomain: string) {
    const cleanSubdomain = subdomain.includes('.myfreshworks.com')
      ? subdomain.split('.')[0]
      : subdomain;
    this.baseUrl = `https://${cleanSubdomain}.myfreshworks.com/crm/sales/api`;
    this.token = `Token token=${apiKey}`;
  }

  async get(path: string, query?: Record<string, unknown>) {
    return this.request('GET', path, { query });
  }

  async post(path: string, body?: Record<string, unknown>, query?: Record<string, unknown>) {
    return this.request('POST', path, { body, query });
  }

  async put(path: string, body?: Record<string, unknown>, query?: Record<string, unknown>) {
    return this.request('PUT', path, { body, query });
  }

  async delete(path: string, body?: Record<string, unknown>, query?: Record<string, unknown>) {
    return this.request('DELETE', path, { body, query });
  }

  private async request(method: string, path: string, options: FreshsalesRequestOptions = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined || value === null) {
          continue;
        }
        if (Array.isArray(value)) {
          for (const entry of value) {
            url.searchParams.append(`${key}[]`, String(entry));
          }
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: this.token,
      Accept: 'application/json',
    };

    const init: RequestInit = {
      method,
      headers,
    };

    if (method !== 'GET' && options.body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, init);
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        payload?.errors?.message?.[0] ||
        payload?.errors?.message ||
        payload?.message ||
        payload?.error ||
        response.statusText;
      throw new Error(`Freshsales API error (${response.status}): ${message}`);
    }

    return payload;
  }
}

// Store transports by session ID
const transports: Record<string, StreamableHTTPServerTransport> = {};

// ---------------------------------------------------------------------------
// Persistent OAuth state (file-backed)
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || '/app/data';
mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = join(DATA_DIR, 'oauth-state.json');

type PersistedState = {
  clients: Record<string, OAuthClientInformationFull>;
  authCodes: Record<string, { clientId: string; codeChallenge: string; redirectUri: string; scope: string; expiresAt: number }>;
  tokens: Record<string, { clientId: string; scopes: string[]; expiresAt: number }>;
  refreshTokens: Record<string, { accessToken: string; clientId: string; scopes: string[]; createdAt: number }>;
};

function loadState(): PersistedState {
  try {
    if (existsSync(STATE_FILE)) {
      const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as PersistedState;
      console.log('Loaded OAuth state from disk', {
        clients: Object.keys(data.clients || {}).length,
        tokens: Object.keys(data.tokens || {}).length,
      });
      return {
        clients: data.clients || {},
        authCodes: data.authCodes || {},
        tokens: data.tokens || {},
        refreshTokens: data.refreshTokens || {},
      };
    }
  } catch (error) {
    console.error('Failed to load OAuth state', error);
  }
  return { clients: {}, authCodes: {}, tokens: {}, refreshTokens: {} };
}

const state = loadState();

function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('Failed to save OAuth state', error);
  }
}

// Allow pre-shared tokens via env (comma-separated)
const allowedTokens = new Set(
  (process.env.MCP_ALLOWED_TOKENS || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
);

// ---------------------------------------------------------------------------
// OAuthServerProvider implementation using the MCP SDK
// ---------------------------------------------------------------------------
class FreshsalesOAuthProvider implements OAuthServerProvider {
  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient(clientId: string): OAuthClientInformationFull | undefined {
        return state.clients[clientId];
      },
      registerClient(clientData: any): OAuthClientInformationFull {
        const clientId = `mcp-client-${randomUUID()}`;
        const client: OAuthClientInformationFull = {
          ...clientData,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        state.clients[clientId] = client;
        saveState();
        console.log('Registered client', { clientId });
        return client;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const code = randomUUID();
    state.authCodes[code] = {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scope: params.scopes?.join(' ') || DEFAULT_SCOPE,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    saveState();
    console.log('Issued authorization code', { clientId: client.client_id, code });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (params.state) {
      redirectUrl.searchParams.set('state', params.state);
    }
    res.redirect(redirectUrl.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = state.authCodes[authorizationCode];
    if (!record) {
      throw new Error('Unknown authorization code');
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
  ): Promise<OAuthTokens> {
    const record = state.authCodes[authorizationCode];
    if (!record) {
      throw new Error('Unknown authorization code');
    }
    if (record.clientId !== client.client_id) {
      throw new Error('Client mismatch');
    }
    if (Date.now() > record.expiresAt) {
      delete state.authCodes[authorizationCode];
      saveState();
      throw new Error('Authorization code expired');
    }

    delete state.authCodes[authorizationCode];

    const accessToken = `mcp_${randomUUID()}`;
    const refreshToken = `refresh_${randomUUID()}`;
    const expiresIn = Math.floor(ACCESS_TOKEN_TTL_MS / 1000);

    state.tokens[accessToken] = {
      clientId: client.client_id,
      scopes: record.scope.split(' '),
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    };
    state.refreshTokens[refreshToken] = {
      accessToken,
      clientId: client.client_id,
      scopes: record.scope.split(' '),
      createdAt: Date.now(),
    };
    saveState();

    console.log('Token exchange successful', { clientId: client.client_id });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: record.scope,
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const record = state.refreshTokens[refreshToken];
    if (!record || record.clientId !== client.client_id) {
      throw new Error('Invalid refresh token');
    }

    // Revoke old access token
    delete state.tokens[record.accessToken];

    const accessToken = `mcp_${randomUUID()}`;
    const newRefreshToken = `refresh_${randomUUID()}`;
    const resolvedScopes = scopes || record.scopes;
    const expiresIn = Math.floor(ACCESS_TOKEN_TTL_MS / 1000);

    state.tokens[accessToken] = {
      clientId: client.client_id,
      scopes: resolvedScopes,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    };

    // Rotate refresh token
    delete state.refreshTokens[refreshToken];
    state.refreshTokens[newRefreshToken] = {
      accessToken,
      clientId: client.client_id,
      scopes: resolvedScopes,
      createdAt: Date.now(),
    };
    saveState();

    console.log('Token refresh successful', { clientId: client.client_id });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: newRefreshToken,
      scope: resolvedScopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Check pre-shared tokens first (never expire)
    if (allowedTokens.has(token)) {
      return {
        token,
        clientId: 'pre-shared',
        scopes: SCOPES.slice(),
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    }

    const record = state.tokens[token];
    if (!record) {
      throw new Error('Invalid token');
    }
    if (record.expiresAt < Math.floor(Date.now() / 1000)) {
      delete state.tokens[token];
      saveState();
      throw new Error('Token expired');
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    delete state.tokens[request.token];
    delete state.refreshTokens[request.token];
    saveState();
  }
}

const oauthProvider = new FreshsalesOAuthProvider();

class FreshsalesMCPServer {
  private app: express.Application;
  private freshsalesClient: FreshsalesClient;
  private toolConfigs: ToolConfig[];

  constructor() {
    const apiKey = process.env.FRESHSALES_API_KEY;
    if (!apiKey) {
      console.error('Error: FRESHSALES_API_KEY environment variable is required');
      process.exit(1);
    }

    const subdomain = process.env.FRESHSALES_SUBDOMAIN || process.env.FRESHSALES_BUNDLE_ALIAS;
    if (!subdomain) {
      console.error('Error: FRESHSALES_SUBDOMAIN environment variable is required');
      process.exit(1);
    }

    this.freshsalesClient = new FreshsalesClient(apiKey, subdomain);

    this.app = express();
    this.toolConfigs = this.buildToolConfigs();
    this.setupExpress();
  }

  private createServer(): Server {
    const server = new Server(
      { name: 'freshsales-mcp-server-http', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = this.toolConfigs.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }));
      console.log(`tools/list: returning ${tools.length} tools`);
      return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const tool = this.toolConfigs.find(config => config.name === request.params.name);
        if (!tool) {
          throw new Error(`Unknown tool: ${request.params.name}`);
        }
        return await tool.handler(request.params.arguments ?? {});
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('MCP CallTool error', { tool: request.params.name, error: errorMessage });
        return buildToolResponse({ success: false, error: errorMessage }, true);
      }
    });
    return server;
  }

  private createTool(config: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: (args: Record<string, unknown>) => string;
    buildQuery?: (args: Record<string, unknown>) => Record<string, unknown> | undefined;
    buildBody?: (args: Record<string, unknown>) => Record<string, unknown> | undefined;
    transform?: (payload: any) => Record<string, unknown>;
  }): ToolConfig {
    return {
      name: config.name,
      description: config.description,
      inputSchema: config.inputSchema,
      handler: async (rawArgs: unknown) => {
        const args = ensureObject<Record<string, unknown>>(rawArgs ?? {}, 'arguments');
        const query = config.buildQuery ? config.buildQuery(args) : undefined;
        const body = config.buildBody ? config.buildBody(args) : undefined;

        let payload: any;
        switch (config.method) {
          case 'GET':
            payload = await this.freshsalesClient.get(config.path(args), query);
            break;
          case 'POST':
            payload = await this.freshsalesClient.post(config.path(args), body, query);
            break;
          case 'PUT':
            payload = await this.freshsalesClient.put(config.path(args), body, query);
            break;
          case 'DELETE':
            payload = await this.freshsalesClient.delete(config.path(args), body, query);
            break;
          default:
            throw new Error(`Unsupported HTTP method: ${config.method}`);
        }

        const result = config.transform
          ? config.transform(payload)
          : { success: true, data: payload };

        return buildToolResponse(result, false);
      },
    };
  }

  private buildToolConfigs(): ToolConfig[] {
    // -----------------------------------------------------------------------
    // CONTACTS
    // -----------------------------------------------------------------------
    const contactTools: ToolConfig[] = [
      this.createTool({
        name: 'freshsales_list_contacts',
        description: 'List contacts using a view. Use freshsales_list_contact_filters first to get available view IDs.',
        inputSchema: {
          type: 'object',
          required: ['view_id'],
          additionalProperties: false,
          properties: {
            view_id: idSchema('View ID to list contacts from.'),
            page: { type: 'number', description: 'Page number (default 1).' },
            per_page: { type: 'number', description: 'Results per page (max 100, default 25).' },
            sort: { type: 'string', description: 'Field to sort by.' },
            sort_type: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction.' },
          },
        },
        method: 'GET',
        path: args => `/contacts/view/${ensureId(args.view_id, 'view_id')}`,
        buildQuery: args => ({
          page: ensureOptionalNumber(args.page, 'page'),
          per_page: ensureOptionalIntegerInRange(args.per_page, 'per_page', 1, 100),
          sort: ensureOptionalString(args.sort, 'sort'),
          sort_type: ensureOptionalEnum(args.sort_type, 'sort_type', ['asc', 'desc'] as const),
        }),
        transform: payload => ({ success: true, contacts: payload?.contacts ?? [], meta: payload?.meta }),
      }),

      this.createTool({
        name: 'freshsales_get_contact',
        description: 'Get a single contact by ID, including all fields and associations.',
        inputSchema: {
          type: 'object',
          required: ['contact_id'],
          additionalProperties: false,
          properties: {
            contact_id: idSchema('Contact ID to retrieve.'),
          },
        },
        method: 'GET',
        path: args => `/contacts/${ensureId(args.contact_id, 'contact_id')}`,
        transform: payload => ({ success: true, contact: payload?.contact ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_create_contact',
        description: 'Create a new contact in Freshsales. Provide at least first_name or last_name, and optionally email, job_title, phone, etc.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            first_name: { type: 'string', description: 'First name.' },
            last_name: { type: 'string', description: 'Last name.' },
            email: { type: 'string', description: 'Primary email address.' },
            mobile_number: { type: 'string', description: 'Mobile phone number.' },
            work_number: { type: 'string', description: 'Work phone number.' },
            job_title: { type: 'string', description: 'Job title.' },
            linkedin: { type: 'string', description: 'LinkedIn profile URL.' },
            twitter: { type: 'string', description: 'Twitter handle.' },
            city: { type: 'string', description: 'City.' },
            state: { type: 'string', description: 'State/province.' },
            country: { type: 'string', description: 'Country.' },
            zipcode: { type: 'string', description: 'Zip/postal code.' },
            address: { type: 'string', description: 'Street address.' },
            sales_account_id: { type: 'number', description: 'ID of the associated sales account (company).' },
            owner_id: { type: 'number', description: 'ID of the assigned owner/user.' },
            lead_source_id: { type: 'number', description: 'Lead source ID.' },
            lifecycle_stage_id: { type: 'number', description: 'Lifecycle stage ID.' },
            territory_id: { type: 'number', description: 'Territory ID.' },
            custom_field: { type: 'object', description: 'Custom fields as key-value pairs (e.g. {"cf_field_name": "value"}).' },
          },
        },
        method: 'POST',
        path: () => '/contacts',
        buildBody: args => {
          const contact: Record<string, unknown> = {};
          const fields = [
            'first_name', 'last_name', 'email', 'mobile_number', 'work_number',
            'job_title', 'linkedin', 'twitter', 'city', 'state', 'country',
            'zipcode', 'address', 'sales_account_id', 'owner_id', 'lead_source_id',
            'lifecycle_stage_id', 'territory_id', 'custom_field',
          ];
          for (const f of fields) {
            if (args[f] !== undefined) contact[f] = args[f];
          }
          return { contact };
        },
        transform: payload => ({ success: true, contact: payload?.contact ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_update_contact',
        description: 'Update an existing contact. Only provide the fields you want to change.',
        inputSchema: {
          type: 'object',
          required: ['contact_id'],
          additionalProperties: false,
          properties: {
            contact_id: idSchema('Contact ID to update.'),
            first_name: { type: 'string', description: 'First name.' },
            last_name: { type: 'string', description: 'Last name.' },
            email: { type: 'string', description: 'Primary email address.' },
            mobile_number: { type: 'string', description: 'Mobile phone number.' },
            work_number: { type: 'string', description: 'Work phone number.' },
            job_title: { type: 'string', description: 'Job title.' },
            linkedin: { type: 'string', description: 'LinkedIn profile URL.' },
            twitter: { type: 'string', description: 'Twitter handle.' },
            city: { type: 'string', description: 'City.' },
            state: { type: 'string', description: 'State/province.' },
            country: { type: 'string', description: 'Country.' },
            zipcode: { type: 'string', description: 'Zip/postal code.' },
            address: { type: 'string', description: 'Street address.' },
            sales_account_id: { type: 'number', description: 'ID of the associated sales account (company).' },
            owner_id: { type: 'number', description: 'ID of the assigned owner/user.' },
            lead_source_id: { type: 'number', description: 'Lead source ID.' },
            lifecycle_stage_id: { type: 'number', description: 'Lifecycle stage ID.' },
            territory_id: { type: 'number', description: 'Territory ID.' },
            custom_field: { type: 'object', description: 'Custom fields as key-value pairs (e.g. {"cf_field_name": "value"}).' },
          },
        },
        method: 'PUT',
        path: args => `/contacts/${ensureId(args.contact_id, 'contact_id')}`,
        buildBody: args => {
          const contact: Record<string, unknown> = {};
          const fields = [
            'first_name', 'last_name', 'email', 'mobile_number', 'work_number',
            'job_title', 'linkedin', 'twitter', 'city', 'state', 'country',
            'zipcode', 'address', 'sales_account_id', 'owner_id', 'lead_source_id',
            'lifecycle_stage_id', 'territory_id', 'custom_field',
          ];
          for (const f of fields) {
            if (args[f] !== undefined) contact[f] = args[f];
          }
          return { contact };
        },
        transform: payload => ({ success: true, contact: payload?.contact ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_upsert_contact',
        description: 'Create or update a contact using a unique identifier (email, work_email, or external_id). If found, updates; otherwise creates.',
        inputSchema: {
          type: 'object',
          required: ['unique_identifier'],
          additionalProperties: false,
          properties: {
            unique_identifier: {
              type: 'object',
              description: 'Unique field to match on (e.g. {"emails": "john@example.com"} or {"external_id": "ext123"}).',
            },
            first_name: { type: 'string', description: 'First name.' },
            last_name: { type: 'string', description: 'Last name.' },
            email: { type: 'string', description: 'Primary email address.' },
            mobile_number: { type: 'string', description: 'Mobile phone number.' },
            work_number: { type: 'string', description: 'Work phone number.' },
            job_title: { type: 'string', description: 'Job title.' },
            linkedin: { type: 'string', description: 'LinkedIn profile URL.' },
            sales_account_id: { type: 'number', description: 'Associated sales account ID.' },
            owner_id: { type: 'number', description: 'Owner user ID.' },
            custom_field: { type: 'object', description: 'Custom fields as key-value pairs.' },
          },
        },
        method: 'POST',
        path: () => '/contacts/upsert',
        buildBody: args => {
          const contact: Record<string, unknown> = {};
          const fields = [
            'first_name', 'last_name', 'email', 'mobile_number', 'work_number',
            'job_title', 'linkedin', 'sales_account_id', 'owner_id', 'custom_field',
          ];
          for (const f of fields) {
            if (args[f] !== undefined) contact[f] = args[f];
          }
          return {
            unique_identifier: args.unique_identifier,
            contact,
          };
        },
        transform: payload => ({ success: true, contact: payload?.contact ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_delete_contact',
        description: 'Delete a contact by ID. This action cannot be undone.',
        inputSchema: {
          type: 'object',
          required: ['contact_id'],
          additionalProperties: false,
          properties: {
            contact_id: idSchema('Contact ID to delete.'),
          },
        },
        method: 'DELETE',
        path: args => `/contacts/${ensureId(args.contact_id, 'contact_id')}`,
        transform: () => ({ success: true, message: 'Contact deleted' }),
      }),

      this.createTool({
        name: 'freshsales_list_contact_filters',
        description: 'List all available contact views/filters. Returns view IDs that can be used with freshsales_list_contacts.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
        method: 'GET',
        path: () => '/contacts/filters',
        transform: payload => ({ success: true, filters: payload?.filters ?? [] }),
      }),

      this.createTool({
        name: 'freshsales_list_contact_fields',
        description: 'List all available contact fields including custom fields. Useful for understanding what fields can be used when creating/updating contacts.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
        method: 'GET',
        path: () => '/settings/contacts/fields',
        transform: payload => ({ success: true, fields: payload?.fields ?? [] }),
      }),

      this.createTool({
        name: 'freshsales_list_contact_activities',
        description: 'List recent activities for a contact (emails, calls, tasks, notes, etc.).',
        inputSchema: {
          type: 'object',
          required: ['contact_id'],
          additionalProperties: false,
          properties: {
            contact_id: idSchema('Contact ID.'),
          },
        },
        method: 'GET',
        path: args => `/contacts/${ensureId(args.contact_id, 'contact_id')}/activities.json`,
        transform: payload => ({ success: true, activities: payload?.activities ?? payload }),
      }),
    ];

    // -----------------------------------------------------------------------
    // SALES ACCOUNTS (COMPANIES)
    // -----------------------------------------------------------------------
    const accountTools: ToolConfig[] = [
      this.createTool({
        name: 'freshsales_list_accounts',
        description: 'List sales accounts (companies) using a view. Use freshsales_list_account_filters first to get available view IDs.',
        inputSchema: {
          type: 'object',
          required: ['view_id'],
          additionalProperties: false,
          properties: {
            view_id: idSchema('View ID to list accounts from.'),
            page: { type: 'number', description: 'Page number (default 1).' },
            per_page: { type: 'number', description: 'Results per page (max 100, default 25).' },
            sort: { type: 'string', description: 'Field to sort by.' },
            sort_type: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction.' },
          },
        },
        method: 'GET',
        path: args => `/sales_accounts/view/${ensureId(args.view_id, 'view_id')}`,
        buildQuery: args => ({
          page: ensureOptionalNumber(args.page, 'page'),
          per_page: ensureOptionalIntegerInRange(args.per_page, 'per_page', 1, 100),
          sort: ensureOptionalString(args.sort, 'sort'),
          sort_type: ensureOptionalEnum(args.sort_type, 'sort_type', ['asc', 'desc'] as const),
        }),
        transform: payload => ({ success: true, sales_accounts: payload?.sales_accounts ?? [], meta: payload?.meta }),
      }),

      this.createTool({
        name: 'freshsales_get_account',
        description: 'Get a single sales account (company) by ID, including all fields and associations.',
        inputSchema: {
          type: 'object',
          required: ['account_id'],
          additionalProperties: false,
          properties: {
            account_id: idSchema('Sales account ID to retrieve.'),
          },
        },
        method: 'GET',
        path: args => `/sales_accounts/${ensureId(args.account_id, 'account_id')}`,
        transform: payload => ({ success: true, sales_account: payload?.sales_account ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_get_account_contacts',
        description: 'Get all contacts associated with a sales account (company).',
        inputSchema: {
          type: 'object',
          required: ['account_id'],
          additionalProperties: false,
          properties: {
            account_id: idSchema('Sales account ID.'),
          },
        },
        method: 'GET',
        path: args => `/sales_accounts/${ensureId(args.account_id, 'account_id')}/contacts`,
        transform: payload => ({ success: true, contacts: payload?.contacts ?? [] }),
      }),

      this.createTool({
        name: 'freshsales_create_account',
        description: 'Create a new sales account (company). The name field is required.',
        inputSchema: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'Company name (required).' },
            website: { type: 'string', description: 'Company website URL.' },
            linkedin: { type: 'string', description: 'LinkedIn company page URL.' },
            twitter: { type: 'string', description: 'Twitter handle.' },
            phone: { type: 'string', description: 'Company phone number.' },
            city: { type: 'string', description: 'City.' },
            state: { type: 'string', description: 'State/province.' },
            country: { type: 'string', description: 'Country.' },
            zipcode: { type: 'string', description: 'Zip/postal code.' },
            address: { type: 'string', description: 'Street address.' },
            industry_type_id: { type: 'number', description: 'Industry type ID.' },
            business_type_id: { type: 'number', description: 'Business type ID.' },
            number_of_employees: { type: 'number', description: 'Number of employees.' },
            annual_revenue: { type: 'number', description: 'Annual revenue.' },
            owner_id: { type: 'number', description: 'Assigned owner/user ID.' },
            territory_id: { type: 'number', description: 'Territory ID.' },
            parent_sales_account_id: { type: 'number', description: 'Parent account ID.' },
            custom_field: { type: 'object', description: 'Custom fields as key-value pairs (e.g. {"cf_field_name": "value"}).' },
          },
        },
        method: 'POST',
        path: () => '/sales_accounts',
        buildBody: args => {
          const sales_account: Record<string, unknown> = {};
          const fields = [
            'name', 'website', 'linkedin', 'twitter', 'phone', 'city', 'state',
            'country', 'zipcode', 'address', 'industry_type_id', 'business_type_id',
            'number_of_employees', 'annual_revenue', 'owner_id', 'territory_id',
            'parent_sales_account_id', 'custom_field',
          ];
          for (const f of fields) {
            if (args[f] !== undefined) sales_account[f] = args[f];
          }
          return { sales_account };
        },
        transform: payload => ({ success: true, sales_account: payload?.sales_account ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_update_account',
        description: 'Update an existing sales account (company). Only provide the fields you want to change.',
        inputSchema: {
          type: 'object',
          required: ['account_id'],
          additionalProperties: false,
          properties: {
            account_id: idSchema('Sales account ID to update.'),
            name: { type: 'string', description: 'Company name.' },
            website: { type: 'string', description: 'Company website URL.' },
            linkedin: { type: 'string', description: 'LinkedIn company page URL.' },
            twitter: { type: 'string', description: 'Twitter handle.' },
            phone: { type: 'string', description: 'Company phone number.' },
            city: { type: 'string', description: 'City.' },
            state: { type: 'string', description: 'State/province.' },
            country: { type: 'string', description: 'Country.' },
            zipcode: { type: 'string', description: 'Zip/postal code.' },
            address: { type: 'string', description: 'Street address.' },
            industry_type_id: { type: 'number', description: 'Industry type ID.' },
            business_type_id: { type: 'number', description: 'Business type ID.' },
            number_of_employees: { type: 'number', description: 'Number of employees.' },
            annual_revenue: { type: 'number', description: 'Annual revenue.' },
            owner_id: { type: 'number', description: 'Assigned owner/user ID.' },
            territory_id: { type: 'number', description: 'Territory ID.' },
            parent_sales_account_id: { type: 'number', description: 'Parent account ID.' },
            custom_field: { type: 'object', description: 'Custom fields as key-value pairs (e.g. {"cf_field_name": "value"}).' },
          },
        },
        method: 'PUT',
        path: args => `/sales_accounts/${ensureId(args.account_id, 'account_id')}`,
        buildBody: args => {
          const sales_account: Record<string, unknown> = {};
          const fields = [
            'name', 'website', 'linkedin', 'twitter', 'phone', 'city', 'state',
            'country', 'zipcode', 'address', 'industry_type_id', 'business_type_id',
            'number_of_employees', 'annual_revenue', 'owner_id', 'territory_id',
            'parent_sales_account_id', 'custom_field',
          ];
          for (const f of fields) {
            if (args[f] !== undefined) sales_account[f] = args[f];
          }
          return { sales_account };
        },
        transform: payload => ({ success: true, sales_account: payload?.sales_account ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_upsert_account',
        description: 'Create or update a sales account using a unique identifier (name or external_id). If found, updates; otherwise creates.',
        inputSchema: {
          type: 'object',
          required: ['unique_identifier'],
          additionalProperties: false,
          properties: {
            unique_identifier: {
              type: 'object',
              description: 'Unique field to match on (e.g. {"name": "Acme Corp"}).',
            },
            name: { type: 'string', description: 'Company name.' },
            website: { type: 'string', description: 'Company website URL.' },
            linkedin: { type: 'string', description: 'LinkedIn company page URL.' },
            phone: { type: 'string', description: 'Company phone number.' },
            city: { type: 'string', description: 'City.' },
            state: { type: 'string', description: 'State/province.' },
            country: { type: 'string', description: 'Country.' },
            owner_id: { type: 'number', description: 'Owner user ID.' },
            custom_field: { type: 'object', description: 'Custom fields as key-value pairs.' },
          },
        },
        method: 'POST',
        path: () => '/sales_accounts/upsert',
        buildBody: args => {
          const sales_account: Record<string, unknown> = {};
          const fields = [
            'name', 'website', 'linkedin', 'phone', 'city', 'state',
            'country', 'owner_id', 'custom_field',
          ];
          for (const f of fields) {
            if (args[f] !== undefined) sales_account[f] = args[f];
          }
          return {
            unique_identifier: args.unique_identifier,
            sales_account,
          };
        },
        transform: payload => ({ success: true, sales_account: payload?.sales_account ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_delete_account',
        description: 'Delete a sales account (company) by ID. This action cannot be undone.',
        inputSchema: {
          type: 'object',
          required: ['account_id'],
          additionalProperties: false,
          properties: {
            account_id: idSchema('Sales account ID to delete.'),
          },
        },
        method: 'DELETE',
        path: args => `/sales_accounts/${ensureId(args.account_id, 'account_id')}`,
        transform: () => ({ success: true, message: 'Sales account deleted' }),
      }),

      this.createTool({
        name: 'freshsales_list_account_filters',
        description: 'List all available sales account views/filters. Returns view IDs that can be used with freshsales_list_accounts.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
        method: 'GET',
        path: () => '/sales_accounts/filters',
        transform: payload => ({ success: true, filters: payload?.filters ?? [] }),
      }),

      this.createTool({
        name: 'freshsales_list_account_fields',
        description: 'List all available sales account fields including custom fields.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
        method: 'GET',
        path: () => '/settings/sales_accounts/fields',
        transform: payload => ({ success: true, fields: payload?.fields ?? [] }),
      }),
    ];

    // -----------------------------------------------------------------------
    // DEALS
    // -----------------------------------------------------------------------
    const dealTools: ToolConfig[] = [
      this.createTool({
        name: 'freshsales_list_deals',
        description: 'List deals using a view. Use freshsales_list_deal_filters first to get available view IDs.',
        inputSchema: {
          type: 'object',
          required: ['view_id'],
          additionalProperties: false,
          properties: {
            view_id: idSchema('View ID to list deals from.'),
            page: { type: 'number', description: 'Page number (default 1).' },
            per_page: { type: 'number', description: 'Results per page (max 100, default 25).' },
            sort: { type: 'string', description: 'Field to sort by.' },
            sort_type: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction.' },
          },
        },
        method: 'GET',
        path: args => `/deals/view/${ensureId(args.view_id, 'view_id')}`,
        buildQuery: args => ({
          page: ensureOptionalNumber(args.page, 'page'),
          per_page: ensureOptionalIntegerInRange(args.per_page, 'per_page', 1, 100),
          sort: ensureOptionalString(args.sort, 'sort'),
          sort_type: ensureOptionalEnum(args.sort_type, 'sort_type', ['asc', 'desc'] as const),
        }),
        transform: payload => ({ success: true, deals: payload?.deals ?? [], meta: payload?.meta }),
      }),

      this.createTool({
        name: 'freshsales_get_deal',
        description: 'Get a single deal by ID, including all fields and associations.',
        inputSchema: {
          type: 'object',
          required: ['deal_id'],
          additionalProperties: false,
          properties: {
            deal_id: idSchema('Deal ID to retrieve.'),
          },
        },
        method: 'GET',
        path: args => `/deals/${ensureId(args.deal_id, 'deal_id')}`,
        transform: payload => ({ success: true, deal: payload?.deal ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_create_deal',
        description: 'Create a new deal. The name and amount fields are recommended.',
        inputSchema: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'Deal name (required).' },
            amount: { type: 'number', description: 'Deal amount/value.' },
            expected_close: { type: 'string', description: 'Expected close date (YYYY-MM-DD).' },
            deal_stage_id: { type: 'number', description: 'Deal stage ID.' },
            deal_pipeline_id: { type: 'number', description: 'Deal pipeline ID.' },
            sales_account_id: { type: 'number', description: 'Associated sales account (company) ID.' },
            contacts_id: { type: 'array', items: { type: 'number' }, description: 'Array of associated contact IDs.' },
            deal_type_id: { type: 'number', description: 'Deal type ID.' },
            deal_reason_id: { type: 'number', description: 'Deal reason ID (for won/lost).' },
            probability: { type: 'number', description: 'Win probability percentage (0-100).' },
            currency_id: { type: 'number', description: 'Currency ID.' },
            owner_id: { type: 'number', description: 'Assigned owner/user ID.' },
            territory_id: { type: 'number', description: 'Territory ID.' },
            deal_product_id: { type: 'number', description: 'Product ID.' },
            deal_payment_status_id: { type: 'number', description: 'Payment status ID.' },
            campaign_id: { type: 'number', description: 'Campaign ID.' },
            custom_field: { type: 'object', description: 'Custom fields as key-value pairs.' },
          },
        },
        method: 'POST',
        path: () => '/deals',
        buildBody: args => {
          const deal: Record<string, unknown> = {};
          const fields = [
            'name', 'amount', 'expected_close', 'deal_stage_id', 'deal_pipeline_id',
            'sales_account_id', 'contacts_id', 'deal_type_id', 'deal_reason_id',
            'probability', 'currency_id', 'owner_id', 'territory_id',
            'deal_product_id', 'deal_payment_status_id', 'campaign_id', 'custom_field',
          ];
          for (const f of fields) {
            if (args[f] !== undefined) deal[f] = args[f];
          }
          return { deal };
        },
        transform: payload => ({ success: true, deal: payload?.deal ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_update_deal',
        description: 'Update an existing deal. Only provide the fields you want to change.',
        inputSchema: {
          type: 'object',
          required: ['deal_id'],
          additionalProperties: false,
          properties: {
            deal_id: idSchema('Deal ID to update.'),
            name: { type: 'string', description: 'Deal name.' },
            amount: { type: 'number', description: 'Deal amount/value.' },
            expected_close: { type: 'string', description: 'Expected close date (YYYY-MM-DD).' },
            deal_stage_id: { type: 'number', description: 'Deal stage ID.' },
            deal_pipeline_id: { type: 'number', description: 'Deal pipeline ID.' },
            sales_account_id: { type: 'number', description: 'Associated sales account (company) ID.' },
            contacts_id: { type: 'array', items: { type: 'number' }, description: 'Array of associated contact IDs.' },
            deal_type_id: { type: 'number', description: 'Deal type ID.' },
            deal_reason_id: { type: 'number', description: 'Deal reason ID (for won/lost).' },
            probability: { type: 'number', description: 'Win probability percentage (0-100).' },
            currency_id: { type: 'number', description: 'Currency ID.' },
            owner_id: { type: 'number', description: 'Assigned owner/user ID.' },
            territory_id: { type: 'number', description: 'Territory ID.' },
            deal_product_id: { type: 'number', description: 'Product ID.' },
            deal_payment_status_id: { type: 'number', description: 'Payment status ID.' },
            campaign_id: { type: 'number', description: 'Campaign ID.' },
            custom_field: { type: 'object', description: 'Custom fields as key-value pairs.' },
          },
        },
        method: 'PUT',
        path: args => `/deals/${ensureId(args.deal_id, 'deal_id')}`,
        buildBody: args => {
          const deal: Record<string, unknown> = {};
          const fields = [
            'name', 'amount', 'expected_close', 'deal_stage_id', 'deal_pipeline_id',
            'sales_account_id', 'contacts_id', 'deal_type_id', 'deal_reason_id',
            'probability', 'currency_id', 'owner_id', 'territory_id',
            'deal_product_id', 'deal_payment_status_id', 'campaign_id', 'custom_field',
          ];
          for (const f of fields) {
            if (args[f] !== undefined) deal[f] = args[f];
          }
          return { deal };
        },
        transform: payload => ({ success: true, deal: payload?.deal ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_upsert_deal',
        description: 'Create or update a deal using a unique identifier (name or external_id). If found, updates; otherwise creates.',
        inputSchema: {
          type: 'object',
          required: ['unique_identifier'],
          additionalProperties: false,
          properties: {
            unique_identifier: {
              type: 'object',
              description: 'Unique field to match on (e.g. {"name": "Big Deal"}).',
            },
            name: { type: 'string', description: 'Deal name.' },
            amount: { type: 'number', description: 'Deal amount/value.' },
            expected_close: { type: 'string', description: 'Expected close date (YYYY-MM-DD).' },
            deal_stage_id: { type: 'number', description: 'Deal stage ID.' },
            deal_pipeline_id: { type: 'number', description: 'Deal pipeline ID.' },
            sales_account_id: { type: 'number', description: 'Associated sales account ID.' },
            owner_id: { type: 'number', description: 'Owner user ID.' },
            custom_field: { type: 'object', description: 'Custom fields as key-value pairs.' },
          },
        },
        method: 'POST',
        path: () => '/deals/upsert',
        buildBody: args => {
          const deal: Record<string, unknown> = {};
          const fields = [
            'name', 'amount', 'expected_close', 'deal_stage_id', 'deal_pipeline_id',
            'sales_account_id', 'owner_id', 'custom_field',
          ];
          for (const f of fields) {
            if (args[f] !== undefined) deal[f] = args[f];
          }
          return {
            unique_identifier: args.unique_identifier,
            deal,
          };
        },
        transform: payload => ({ success: true, deal: payload?.deal ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_delete_deal',
        description: 'Delete a deal by ID. This action cannot be undone.',
        inputSchema: {
          type: 'object',
          required: ['deal_id'],
          additionalProperties: false,
          properties: {
            deal_id: idSchema('Deal ID to delete.'),
          },
        },
        method: 'DELETE',
        path: args => `/deals/${ensureId(args.deal_id, 'deal_id')}`,
        transform: () => ({ success: true, message: 'Deal deleted' }),
      }),

      this.createTool({
        name: 'freshsales_list_deal_filters',
        description: 'List all available deal views/filters. Returns view IDs that can be used with freshsales_list_deals.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
        method: 'GET',
        path: () => '/deals/filters',
        transform: payload => ({ success: true, filters: payload?.filters ?? [] }),
      }),

      this.createTool({
        name: 'freshsales_list_deal_fields',
        description: 'List all available deal fields including custom fields.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
        method: 'GET',
        path: () => '/settings/deals/fields',
        transform: payload => ({ success: true, fields: payload?.fields ?? [] }),
      }),
    ];

    // -----------------------------------------------------------------------
    // TASKS
    // -----------------------------------------------------------------------
    const taskTools: ToolConfig[] = [
      this.createTool({
        name: 'freshsales_list_tasks',
        description: 'List tasks. Optionally filter by owner or status.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            filter: { type: 'string', enum: ['open', 'due_today', 'due_tomorrow', 'overdue', 'completed'], description: 'Filter tasks by status.' },
            owner_id: { type: 'number', description: 'Filter tasks by owner user ID.' },
            page: { type: 'number', description: 'Page number.' },
            per_page: { type: 'number', description: 'Results per page (max 100).' },
          },
        },
        method: 'GET',
        path: () => '/tasks',
        buildQuery: args => ({
          filter: ensureOptionalEnum(args.filter, 'filter', ['open', 'due_today', 'due_tomorrow', 'overdue', 'completed'] as const),
          owner_id: ensureOptionalNumber(args.owner_id, 'owner_id'),
          page: ensureOptionalNumber(args.page, 'page'),
          per_page: ensureOptionalIntegerInRange(args.per_page, 'per_page', 1, 100),
        }),
        transform: payload => ({ success: true, tasks: payload?.tasks ?? [] }),
      }),

      this.createTool({
        name: 'freshsales_get_task',
        description: 'Get a single task by ID.',
        inputSchema: {
          type: 'object',
          required: ['task_id'],
          additionalProperties: false,
          properties: {
            task_id: idSchema('Task ID to retrieve.'),
          },
        },
        method: 'GET',
        path: args => `/tasks/${ensureId(args.task_id, 'task_id')}`,
        transform: payload => ({ success: true, task: payload?.task ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_create_task',
        description: 'Create a new task. Can be associated with a contact, deal, or sales account.',
        inputSchema: {
          type: 'object',
          required: ['title', 'due_date'],
          additionalProperties: false,
          properties: {
            title: { type: 'string', description: 'Task title (required).' },
            description: { type: 'string', description: 'Task description.' },
            due_date: { type: 'string', description: 'Due date (YYYY-MM-DD, required).' },
            owner_id: { type: 'number', description: 'Assigned owner/user ID.' },
            targetable_type: { type: 'string', enum: ['Contact', 'SalesAccount', 'Deal'], description: 'Type of entity to associate with.' },
            targetable_id: { type: 'number', description: 'ID of the associated entity.' },
            task_type_id: { type: 'number', description: 'Task type ID.' },
            outcome_id: { type: 'number', description: 'Outcome ID.' },
          },
        },
        method: 'POST',
        path: () => '/tasks',
        buildBody: args => {
          const task: Record<string, unknown> = {};
          const fields = [
            'title', 'description', 'due_date', 'owner_id',
            'targetable_type', 'targetable_id', 'task_type_id', 'outcome_id',
          ];
          for (const f of fields) {
            if (args[f] !== undefined) task[f] = args[f];
          }
          return { task };
        },
        transform: payload => ({ success: true, task: payload?.task ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_update_task',
        description: 'Update an existing task. Only provide the fields you want to change.',
        inputSchema: {
          type: 'object',
          required: ['task_id'],
          additionalProperties: false,
          properties: {
            task_id: idSchema('Task ID to update.'),
            title: { type: 'string', description: 'Task title.' },
            description: { type: 'string', description: 'Task description.' },
            due_date: { type: 'string', description: 'Due date (YYYY-MM-DD).' },
            owner_id: { type: 'number', description: 'Assigned owner/user ID.' },
            targetable_type: { type: 'string', enum: ['Contact', 'SalesAccount', 'Deal'], description: 'Type of entity to associate with.' },
            targetable_id: { type: 'number', description: 'ID of the associated entity.' },
            task_type_id: { type: 'number', description: 'Task type ID.' },
            outcome_id: { type: 'number', description: 'Outcome ID.' },
          },
        },
        method: 'PUT',
        path: args => `/tasks/${ensureId(args.task_id, 'task_id')}`,
        buildBody: args => {
          const task: Record<string, unknown> = {};
          const fields = [
            'title', 'description', 'due_date', 'owner_id',
            'targetable_type', 'targetable_id', 'task_type_id', 'outcome_id',
          ];
          for (const f of fields) {
            if (args[f] !== undefined) task[f] = args[f];
          }
          return { task };
        },
        transform: payload => ({ success: true, task: payload?.task ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_mark_task_done',
        description: 'Mark a task as completed.',
        inputSchema: {
          type: 'object',
          required: ['task_id'],
          additionalProperties: false,
          properties: {
            task_id: idSchema('Task ID to mark as done.'),
          },
        },
        method: 'PUT',
        path: args => `/tasks/${ensureId(args.task_id, 'task_id')}`,
        buildBody: () => ({ task: { status: 1 } }),
        transform: payload => ({ success: true, task: payload?.task ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_delete_task',
        description: 'Delete a task by ID.',
        inputSchema: {
          type: 'object',
          required: ['task_id'],
          additionalProperties: false,
          properties: {
            task_id: idSchema('Task ID to delete.'),
          },
        },
        method: 'DELETE',
        path: args => `/tasks/${ensureId(args.task_id, 'task_id')}`,
        transform: () => ({ success: true, message: 'Task deleted' }),
      }),
    ];

    // -----------------------------------------------------------------------
    // APPOINTMENTS (MEETINGS)
    // -----------------------------------------------------------------------
    const appointmentTools: ToolConfig[] = [
      this.createTool({
        name: 'freshsales_list_appointments',
        description: 'List appointments/meetings. Optionally filter by status.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            filter: { type: 'string', enum: ['upcoming', 'past'], description: 'Filter by upcoming or past.' },
            page: { type: 'number', description: 'Page number.' },
            per_page: { type: 'number', description: 'Results per page (max 100).' },
          },
        },
        method: 'GET',
        path: () => '/appointments',
        buildQuery: args => ({
          filter: ensureOptionalEnum(args.filter, 'filter', ['upcoming', 'past'] as const),
          page: ensureOptionalNumber(args.page, 'page'),
          per_page: ensureOptionalIntegerInRange(args.per_page, 'per_page', 1, 100),
        }),
        transform: payload => ({ success: true, appointments: payload?.appointments ?? [] }),
      }),

      this.createTool({
        name: 'freshsales_get_appointment',
        description: 'Get a single appointment/meeting by ID.',
        inputSchema: {
          type: 'object',
          required: ['appointment_id'],
          additionalProperties: false,
          properties: {
            appointment_id: idSchema('Appointment ID to retrieve.'),
          },
        },
        method: 'GET',
        path: args => `/appointments/${ensureId(args.appointment_id, 'appointment_id')}`,
        transform: payload => ({ success: true, appointment: payload?.appointment ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_create_appointment',
        description: 'Create a new appointment/meeting.',
        inputSchema: {
          type: 'object',
          required: ['title', 'from_date', 'end_date'],
          additionalProperties: false,
          properties: {
            title: { type: 'string', description: 'Appointment title (required).' },
            description: { type: 'string', description: 'Appointment description.' },
            from_date: { type: 'string', description: 'Start date/time (ISO 8601, required).' },
            end_date: { type: 'string', description: 'End date/time (ISO 8601, required).' },
            location: { type: 'string', description: 'Meeting location.' },
            time_zone: { type: 'string', description: 'Time zone (e.g. "America/New_York").' },
            targetable_type: { type: 'string', enum: ['Contact', 'SalesAccount', 'Deal'], description: 'Type of entity to associate with.' },
            targetable_id: { type: 'number', description: 'ID of the associated entity.' },
            attendees: { type: 'array', items: { type: 'object' }, description: 'Array of attendee objects with email and name.' },
            outcome_id: { type: 'number', description: 'Outcome ID.' },
          },
        },
        method: 'POST',
        path: () => '/appointments',
        buildBody: args => {
          const appointment: Record<string, unknown> = {};
          const fields = [
            'title', 'description', 'from_date', 'end_date', 'location',
            'time_zone', 'targetable_type', 'targetable_id', 'attendees', 'outcome_id',
          ];
          for (const f of fields) {
            if (args[f] !== undefined) appointment[f] = args[f];
          }
          return { appointment };
        },
        transform: payload => ({ success: true, appointment: payload?.appointment ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_update_appointment',
        description: 'Update an existing appointment/meeting.',
        inputSchema: {
          type: 'object',
          required: ['appointment_id'],
          additionalProperties: false,
          properties: {
            appointment_id: idSchema('Appointment ID to update.'),
            title: { type: 'string', description: 'Appointment title.' },
            description: { type: 'string', description: 'Appointment description.' },
            from_date: { type: 'string', description: 'Start date/time (ISO 8601).' },
            end_date: { type: 'string', description: 'End date/time (ISO 8601).' },
            location: { type: 'string', description: 'Meeting location.' },
            time_zone: { type: 'string', description: 'Time zone.' },
            targetable_type: { type: 'string', enum: ['Contact', 'SalesAccount', 'Deal'], description: 'Type of entity.' },
            targetable_id: { type: 'number', description: 'ID of the associated entity.' },
            attendees: { type: 'array', items: { type: 'object' }, description: 'Array of attendee objects.' },
            outcome_id: { type: 'number', description: 'Outcome ID.' },
          },
        },
        method: 'PUT',
        path: args => `/appointments/${ensureId(args.appointment_id, 'appointment_id')}`,
        buildBody: args => {
          const appointment: Record<string, unknown> = {};
          const fields = [
            'title', 'description', 'from_date', 'end_date', 'location',
            'time_zone', 'targetable_type', 'targetable_id', 'attendees', 'outcome_id',
          ];
          for (const f of fields) {
            if (args[f] !== undefined) appointment[f] = args[f];
          }
          return { appointment };
        },
        transform: payload => ({ success: true, appointment: payload?.appointment ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_delete_appointment',
        description: 'Delete an appointment/meeting by ID.',
        inputSchema: {
          type: 'object',
          required: ['appointment_id'],
          additionalProperties: false,
          properties: {
            appointment_id: idSchema('Appointment ID to delete.'),
          },
        },
        method: 'DELETE',
        path: args => `/appointments/${ensureId(args.appointment_id, 'appointment_id')}`,
        transform: () => ({ success: true, message: 'Appointment deleted' }),
      }),
    ];

    // -----------------------------------------------------------------------
    // NOTES
    // -----------------------------------------------------------------------
    const noteTools: ToolConfig[] = [
      this.createTool({
        name: 'freshsales_create_note',
        description: 'Create a note on a contact, sales account, or deal.',
        inputSchema: {
          type: 'object',
          required: ['description', 'targetable_type', 'targetable_id'],
          additionalProperties: false,
          properties: {
            description: { type: 'string', description: 'Note content/body (required).' },
            targetable_type: { type: 'string', enum: ['Contact', 'SalesAccount', 'Deal'], description: 'Type of entity to attach note to (required).' },
            targetable_id: { type: 'number', description: 'ID of the entity to attach note to (required).' },
          },
        },
        method: 'POST',
        path: () => '/notes',
        buildBody: args => ({
          note: {
            description: ensureString(args.description, 'description'),
            targetable_type: ensureString(args.targetable_type, 'targetable_type'),
            targetable_id: args.targetable_id,
          },
        }),
        transform: payload => ({ success: true, note: payload?.note ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_update_note',
        description: 'Update an existing note.',
        inputSchema: {
          type: 'object',
          required: ['note_id', 'description'],
          additionalProperties: false,
          properties: {
            note_id: idSchema('Note ID to update.'),
            description: { type: 'string', description: 'Updated note content/body.' },
          },
        },
        method: 'PUT',
        path: args => `/notes/${ensureId(args.note_id, 'note_id')}`,
        buildBody: args => ({
          note: {
            description: ensureString(args.description, 'description'),
          },
        }),
        transform: payload => ({ success: true, note: payload?.note ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_delete_note',
        description: 'Delete a note by ID.',
        inputSchema: {
          type: 'object',
          required: ['note_id'],
          additionalProperties: false,
          properties: {
            note_id: idSchema('Note ID to delete.'),
          },
        },
        method: 'DELETE',
        path: args => `/notes/${ensureId(args.note_id, 'note_id')}`,
        transform: () => ({ success: true, message: 'Note deleted' }),
      }),
    ];

    // -----------------------------------------------------------------------
    // SALES ACTIVITIES
    // -----------------------------------------------------------------------
    const salesActivityTools: ToolConfig[] = [
      this.createTool({
        name: 'freshsales_list_sales_activities',
        description: 'List sales activities (calls, emails logged, etc.).',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            page: { type: 'number', description: 'Page number.' },
            per_page: { type: 'number', description: 'Results per page (max 100).' },
          },
        },
        method: 'GET',
        path: () => '/sales_activities',
        buildQuery: args => ({
          page: ensureOptionalNumber(args.page, 'page'),
          per_page: ensureOptionalIntegerInRange(args.per_page, 'per_page', 1, 100),
        }),
        transform: payload => ({ success: true, sales_activities: payload?.sales_activities ?? [] }),
      }),

      this.createTool({
        name: 'freshsales_get_sales_activity',
        description: 'Get a single sales activity by ID.',
        inputSchema: {
          type: 'object',
          required: ['activity_id'],
          additionalProperties: false,
          properties: {
            activity_id: idSchema('Sales activity ID.'),
          },
        },
        method: 'GET',
        path: args => `/sales_activities/${ensureId(args.activity_id, 'activity_id')}`,
        transform: payload => ({ success: true, sales_activity: payload?.sales_activity ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_create_sales_activity',
        description: 'Create a custom sales activity (log a call, meeting, etc.).',
        inputSchema: {
          type: 'object',
          required: ['title', 'start_date', 'end_date', 'sales_activity_type_id'],
          additionalProperties: false,
          properties: {
            title: { type: 'string', description: 'Activity title (required).' },
            notes: { type: 'string', description: 'Activity notes/description.' },
            start_date: { type: 'string', description: 'Start date/time (ISO 8601, required).' },
            end_date: { type: 'string', description: 'End date/time (ISO 8601, required).' },
            sales_activity_type_id: { type: 'number', description: 'Activity type ID (required).' },
            sales_activity_outcome_id: { type: 'number', description: 'Activity outcome ID.' },
            targetable_type: { type: 'string', enum: ['Contact', 'SalesAccount', 'Deal'], description: 'Type of entity to associate with.' },
            targetable_id: { type: 'number', description: 'ID of the associated entity.' },
            owner_id: { type: 'number', description: 'Owner/user ID.' },
          },
        },
        method: 'POST',
        path: () => '/sales_activities',
        buildBody: args => {
          const sales_activity: Record<string, unknown> = {};
          const fields = [
            'title', 'notes', 'start_date', 'end_date', 'sales_activity_type_id',
            'sales_activity_outcome_id', 'targetable_type', 'targetable_id', 'owner_id',
          ];
          for (const f of fields) {
            if (args[f] !== undefined) sales_activity[f] = args[f];
          }
          return { sales_activity };
        },
        transform: payload => ({ success: true, sales_activity: payload?.sales_activity ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_update_sales_activity',
        description: 'Update an existing sales activity.',
        inputSchema: {
          type: 'object',
          required: ['activity_id'],
          additionalProperties: false,
          properties: {
            activity_id: idSchema('Sales activity ID to update.'),
            title: { type: 'string', description: 'Activity title.' },
            notes: { type: 'string', description: 'Activity notes/description.' },
            start_date: { type: 'string', description: 'Start date/time (ISO 8601).' },
            end_date: { type: 'string', description: 'End date/time (ISO 8601).' },
            sales_activity_type_id: { type: 'number', description: 'Activity type ID.' },
            sales_activity_outcome_id: { type: 'number', description: 'Activity outcome ID.' },
            owner_id: { type: 'number', description: 'Owner/user ID.' },
          },
        },
        method: 'PUT',
        path: args => `/sales_activities/${ensureId(args.activity_id, 'activity_id')}`,
        buildBody: args => {
          const sales_activity: Record<string, unknown> = {};
          const fields = [
            'title', 'notes', 'start_date', 'end_date', 'sales_activity_type_id',
            'sales_activity_outcome_id', 'owner_id',
          ];
          for (const f of fields) {
            if (args[f] !== undefined) sales_activity[f] = args[f];
          }
          return { sales_activity };
        },
        transform: payload => ({ success: true, sales_activity: payload?.sales_activity ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_delete_sales_activity',
        description: 'Delete a sales activity by ID.',
        inputSchema: {
          type: 'object',
          required: ['activity_id'],
          additionalProperties: false,
          properties: {
            activity_id: idSchema('Sales activity ID to delete.'),
          },
        },
        method: 'DELETE',
        path: args => `/sales_activities/${ensureId(args.activity_id, 'activity_id')}`,
        transform: () => ({ success: true, message: 'Sales activity deleted' }),
      }),
    ];

    // -----------------------------------------------------------------------
    // SEARCH, LOOKUP, & SELECTORS
    // -----------------------------------------------------------------------
    const searchTools: ToolConfig[] = [
      this.createTool({
        name: 'freshsales_search',
        description: 'Search across contacts, sales accounts, and deals. Returns matching results across all entity types.',
        inputSchema: {
          type: 'object',
          required: ['query'],
          additionalProperties: false,
          properties: {
            query: { type: 'string', description: 'Search query string (required).' },
            entities: { type: 'string', description: 'Comma-separated entity types to search (e.g. "contact,sales_account,deal"). Defaults to all.' },
          },
        },
        method: 'GET',
        path: () => '/search',
        buildQuery: args => ({
          q: ensureString(args.query, 'query'),
          entities: ensureOptionalString(args.entities, 'entities'),
        }),
        transform: payload => ({ success: true, results: payload }),
      }),

      this.createTool({
        name: 'freshsales_lookup',
        description: 'Look up a record by a specific field value (e.g. email, phone, LinkedIn URL). More precise than search.',
        inputSchema: {
          type: 'object',
          required: ['query', 'field', 'entities'],
          additionalProperties: false,
          properties: {
            query: { type: 'string', description: 'Value to look up (required).' },
            field: { type: 'string', description: 'Field name to search by (e.g. "emails", "phone", "linkedin", "name") (required).' },
            entities: { type: 'string', description: 'Entity type to search in (e.g. "contact", "sales_account") (required).' },
          },
        },
        method: 'GET',
        path: () => '/lookup',
        buildQuery: args => ({
          q: ensureString(args.query, 'query'),
          f: ensureString(args.field, 'field'),
          entities: ensureString(args.entities, 'entities'),
        }),
        transform: payload => ({ success: true, results: payload }),
      }),

      this.createTool({
        name: 'freshsales_filtered_search',
        description: 'Perform an advanced filtered search on a specific entity type with operators (starts_with, is, contains, etc.).',
        inputSchema: {
          type: 'object',
          required: ['entity', 'filter_rule'],
          additionalProperties: false,
          properties: {
            entity: { type: 'string', enum: ['contact', 'sales_account', 'deal'], description: 'Entity type to search (required).' },
            filter_rule: {
              type: 'array',
              description: 'Array of filter rules. Each rule: {"attribute": "field_name", "operator": "starts_with|is|contains|is_not|...", "value": "search_value"}.',
              items: {
                type: 'object',
                properties: {
                  attribute: { type: 'string' },
                  operator: { type: 'string' },
                  value: { type: 'string' },
                },
              },
            },
            page: { type: 'number', description: 'Page number.' },
            per_page: { type: 'number', description: 'Results per page (max 100).' },
          },
        },
        method: 'POST',
        path: args => `/filtered_search/${ensureString(args.entity, 'entity')}`,
        buildBody: args => ({
          filter_rule: args.filter_rule,
          page: ensureOptionalNumber(args.page, 'page'),
          per_page: ensureOptionalIntegerInRange(args.per_page, 'per_page', 1, 100),
        }),
        transform: payload => ({ success: true, results: payload }),
      }),

      this.createTool({
        name: 'freshsales_get_selector',
        description: 'Get configuration/picklist data such as deal stages, pipelines, currencies, territories, lead sources, business types, industry types, lifecycle stages, owners/users, etc.',
        inputSchema: {
          type: 'object',
          required: ['selector_type'],
          additionalProperties: false,
          properties: {
            selector_type: {
              type: 'string',
              enum: [
                'deal_stages', 'deal_pipelines', 'deal_types', 'deal_reasons',
                'deal_payment_statuses', 'currencies', 'territories', 'lead_sources',
                'business_types', 'industry_types', 'lifecycle_stages', 'owners',
                'contact_statuses', 'sales_activity_types', 'sales_activity_outcomes',
              ],
              description: 'Type of selector data to retrieve (required).',
            },
          },
        },
        method: 'GET',
        path: args => `/selector/${ensureString(args.selector_type, 'selector_type')}`,
        transform: payload => ({ success: true, data: payload }),
      }),

      this.createTool({
        name: 'freshsales_find_user',
        description: 'Find a CRM user by email. Useful for resolving owner_id values.',
        inputSchema: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', description: 'Email of the CRM user to find (required).' },
          },
        },
        method: 'GET',
        path: () => '/selector/owners',
        transform: payload => ({ success: true, users: payload?.users ?? payload }),
      }),
    ];

    // -----------------------------------------------------------------------
    // LISTS (MARKETING)
    // -----------------------------------------------------------------------
    const listTools: ToolConfig[] = [
      this.createTool({
        name: 'freshsales_list_lists',
        description: 'List all marketing lists.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
        method: 'GET',
        path: () => '/lists',
        transform: payload => ({ success: true, lists: payload?.lists ?? [] }),
      }),

      this.createTool({
        name: 'freshsales_create_list',
        description: 'Create a new marketing list.',
        inputSchema: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'List name (required).' },
          },
        },
        method: 'POST',
        path: () => '/lists',
        buildBody: args => ({
          list: { name: ensureString(args.name, 'name') },
        }),
        transform: payload => ({ success: true, list: payload?.list ?? payload }),
      }),

      this.createTool({
        name: 'freshsales_add_contacts_to_list',
        description: 'Add contacts to a marketing list.',
        inputSchema: {
          type: 'object',
          required: ['list_id', 'ids'],
          additionalProperties: false,
          properties: {
            list_id: idSchema('Marketing list ID.'),
            ids: { type: 'array', items: { type: 'number' }, description: 'Array of contact IDs to add.' },
          },
        },
        method: 'PUT',
        path: args => `/lists/${ensureId(args.list_id, 'list_id')}/add_contacts`,
        buildBody: args => ({ ids: args.ids }),
        transform: payload => ({ success: true, data: payload }),
      }),

      this.createTool({
        name: 'freshsales_remove_contacts_from_list',
        description: 'Remove contacts from a marketing list.',
        inputSchema: {
          type: 'object',
          required: ['list_id', 'ids'],
          additionalProperties: false,
          properties: {
            list_id: idSchema('Marketing list ID.'),
            ids: { type: 'array', items: { type: 'number' }, description: 'Array of contact IDs to remove.' },
          },
        },
        method: 'PUT',
        path: args => `/lists/${ensureId(args.list_id, 'list_id')}/remove_contacts`,
        buildBody: args => ({ ids: args.ids }),
        transform: payload => ({ success: true, data: payload }),
      }),
    ];

    return [
      ...contactTools,
      ...accountTools,
      ...dealTools,
      ...taskTools,
      ...appointmentTools,
      ...noteTools,
      ...salesActivityTools,
      ...searchTools,
      ...listTools,
    ];
  }

  private setupExpress() {
    this.app.set('trust proxy', 1);
    this.app.use(cors({
      origin: '*',
      exposedHeaders: ['Mcp-Session-Id'],
      allowedHeaders: ['content-type', 'authorization', 'mcp-session-id'],
    }));

    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: false }));

    // Log all incoming requests for debugging
    this.app.use((req, res, next) => {
      if (req.path !== '/health') {
        console.log(`[REQ] ${req.method} ${req.path}`, {
          query: Object.keys(req.query).length > 0 ? req.query : undefined,
          hasAuth: !!req.headers['authorization'],
          userAgent: req.headers['user-agent']?.substring(0, 80),
        });
      }
      next();
    });

    // Health check (public)
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', server: 'freshsales-mcp-server-http', version: '0.1.0' });
    });

    // SDK-provided OAuth routes: /.well-known/*, /authorize, /token, /register, /revoke
    const issuerUrl = new URL(process.env.ISSUER_URL || 'https://freshsales.ssc.one');
    this.app.use(mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl,
      scopesSupported: SCOPES.slice(),
    }));

    // Bearer auth middleware for the MCP endpoint
    const bearerAuth = requireBearerAuth({ verifier: oauthProvider });

    // MCP Streamable HTTP endpoint
    this.app.all('/mcp', bearerAuth, async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      try {
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
          transport = transports[sessionId];
        } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              console.log(`New MCP session initialized: ${sid}`);
              transports[sid] = transport;
            },
          });

          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && transports[sid]) {
              console.log(`Session closed: ${sid}`);
              delete transports[sid];
            }
          };

          const server = this.createServer();
          await server.connect(transport);
          console.log('Transport connected to server');
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: Invalid session or missing initialize request' },
            id: null,
          });
          return;
        }

        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        }
      }
    });
  }

  async start() {
    const port = parseInt(process.env.PORT || '8768');
    const host = process.env.HOST || '0.0.0.0';

    this.app.listen(port, host, () => {
      console.log(`Freshsales MCP Server HTTP v0.1.0 running on http://${host}:${port}`);
      console.log(`Health check: http://${host}:${port}/health`);
      console.log(`MCP endpoint: http://${host}:${port}/mcp`);
    });
  }
}

// Start the server
const mcpServer = new FreshsalesMCPServer();
mcpServer.start().catch(console.error);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  process.exit(0);
});
