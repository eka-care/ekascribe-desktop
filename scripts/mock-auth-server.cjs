/**
 * Mock backend for the device-code login flow.
 *
 *   node mock-auth-server.cjs
 *
 * Then add to electron.env:  EKA_API_UPSTREAM=http://localhost:9099
 * and run the app. Paths/shapes here mirror the constants at the top of
 * src/main/managers/deviceLoginManager.ts — change both together.
 */
const http = require('node:http');

const PORT = 9099;
const PENDING_POLLS = 3; // polls that answer "not yet" before handing over tokens

let pollCount = 0;

function fakeJwt(sub) {
  const body = Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
  console.log(`  -> ${status} ${body}`);
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    console.log(`${req.method} ${url.pathname} ${raw || ''}`);

    // 1. Login click → issue the pair.
    if (url.pathname === '/connect-auth/v1/device/code') {
      pollCount = 0;
      return json(res, 200, {
        user_code: 'WXYZ-1234',
        long_code: 'long-code-abc-123',
        verification_uri: `http://localhost:${PORT}/auth/login?audience=scribe-web`,
        expires_in: 300,
        interval: 2,
      });
    }

    // 2. Polling → pending a few times, then tokens.
    if (url.pathname === '/connect-auth/v1/device/token') {
      pollCount += 1;
      if (pollCount <= PENDING_POLLS) {
        return json(res, 202, { detail: 'authorization_pending' });
      }
      return json(res, 200, {
        access_token: fakeJwt('mock-user-uuid'),
        refresh_token: 'mock-refresh-token-1',
      });
    }

    // 3. Refresh.
    if (url.pathname === '/connect-auth/v1/refresh') {
      return json(res, 200, {
        access_token: fakeJwt('mock-user-uuid'),
        refresh_token: `mock-refresh-token-${Date.now()}`,
      });
    }

    // 4. So the web app gets past its own loading screen after login.
    if (url.pathname === '/connect-auth/v1/account/whoami') {
      return json(res, 200, {
        uuid: 'mock-user-uuid',
        primary_oid: 'mock-oid',
        workspace_id: 'mock-workspace',
        identity: 'mock@eka.care',
        idp_id: 'mock-idp',
      });
    }

    // The page the user "opens in browser".
    if (url.pathname === '/auth/login') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(
        `<body style="font:16px system-ui;padding:48px">
           <h2>Mock sign-in page</h2>
           <p>Pretend you entered the code. The app is polling and will log in
           after ${PENDING_POLLS} more polls.</p>
         </body>`
      );
    }

    json(res, 404, { detail: 'not_found' });
  });
});

server.listen(PORT, () => console.log(`mock auth backend on http://localhost:${PORT}`));
