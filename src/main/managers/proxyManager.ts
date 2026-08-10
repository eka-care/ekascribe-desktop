import { net, session } from 'electron';

function logRequest(method: string, url: string, statusCode?: number): void {
  const status = statusCode !== undefined ? ` -> ${statusCode}` : '';
  console.log(`[proxy] ${method} ${url}${status}`);
}

function buildCorsResponse(
  upstreamResponse: Response,
  requestOrigin: string | null,
): Response {
  const headers = new Headers();

  upstreamResponse.headers.forEach((value, key) => {
    if (!key.toLowerCase().startsWith('access-control-')) {
      headers.append(key, value);
    }
  });

  if (requestOrigin) {
    headers.set('Access-Control-Allow-Origin', requestOrigin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  } else {
    headers.set('Access-Control-Allow-Origin', '*');
  }

  headers.set(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD',
  );
  headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, auth, client-id, X-Requested-With, Accept, Accept-Language, Content-Language, Range, Cache-Control, Pragma, flavour',
  );
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

export function registerProxyProtocolHandler(): void {
  session.defaultSession.protocol.handle('https', async (request) => {
    logRequest(request.method, request.url);

    try {
      const response: Response = await (net.fetch as Function)(request, {
        bypassCustomProtocolHandlers: true,
      });

      logRequest(request.method, request.url, response.status);
      return buildCorsResponse(response, request.headers.get('origin'));
    } catch (error) {
      console.error(`[proxy] fetch error for ${request.url}:`, error);
      throw error;
    }
  });

  console.log('[proxy] HTTPS protocol handler registered');
}

export function unregisterProxyProtocolHandler(): void {
  try {
    session.defaultSession.protocol.unhandle('https');
    console.log('[proxy] HTTPS protocol handler unregistered');
  } catch {
    // already unregistered or session destroyed
  }
}
