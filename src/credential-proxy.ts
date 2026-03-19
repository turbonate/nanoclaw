/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the LLM API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Supports both Anthropic Claude and OpenRouter APIs.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OPENROUTER_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY || secrets.OPENROUTER_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  // Determine which API to use
  const isOpenRouter = !!secrets.OPENROUTER_API_KEY;
  const apiKey = isOpenRouter ? secrets.OPENROUTER_API_KEY : secrets.ANTHROPIC_API_KEY;
  
  const upstreamUrl = new URL(
    secrets.OPENROUTER_BASE_URL || 
    secrets.ANTHROPIC_BASE_URL || 
    (isOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.anthropic.com'),
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject appropriate auth header based on provider
          delete headers['x-api-key'];
          if (isOpenRouter) {
            // OpenRouter uses Authorization header with Bearer token
            delete headers['authorization'];
            headers['authorization'] = `Bearer ${apiKey}`;
          } else {
            // Anthropic uses x-api-key header
            headers['x-api-key'] = apiKey;
          }
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']);
  return (secrets.ANTHROPIC_API_KEY || secrets.OPENROUTER_API_KEY) ? 'api-key' : 'oauth';
}

/** Detect which API provider is configured for. */
export function detectProvider(): 'anthropic' | 'openrouter' {
  const secrets = readEnvFile(['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY']);
  return secrets.OPENROUTER_API_KEY ? 'openrouter' : 'anthropic';
}
