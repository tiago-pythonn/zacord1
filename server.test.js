import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from './server.js';

async function startServer(dataFile, options = {}) {
  const server = createServer({ dataFile, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function request(baseUrl, route, { method = 'GET', body, cookie, origin } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  return {
    response,
    value,
    cookie: response.headers.get('Set-Cookie')?.split(';')[0],
  };
}

test('users can exchange messages and conversations persist after restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zacord-test-'));
  const dataFile = path.join(directory, 'data.json');
  let running = await startServer(dataFile);
  t.after(async () => {
    await running.close();
    if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
    fs.rmdirSync(directory);
  });

  const homepage = await fetch(`${running.baseUrl}/`);
  assert.equal(homepage.status, 200);
  assert.match(await homepage.text(), /href="style\.css"/);
  assert.equal((await fetch(`${running.baseUrl}/config.js`)).status, 200);
  const loginPage = await fetch(`${running.baseUrl}/login_zacord.html`);
  assert.match(await loginPage.text(), /href="login_zacord\.css"/);
  assert.equal((await fetch(`${running.baseUrl}/login_zacord.css`)).status, 200);
  assert.equal((await fetch(`${running.baseUrl}/style.css`)).status, 200);
  assert.equal((await fetch(`${running.baseUrl}/zacord_index.html`)).status, 404);
  const alice = await request(running.baseUrl, '/api/register', {
    method: 'POST',
    body: { displayName: 'Alice', username: 'alice', password: 'password-a' },
  });

  const bob = await request(running.baseUrl, '/api/register', {
    method: 'POST',
    body: { displayName: 'Bob', username: 'bob', password: 'password-b' },
  });
  assert.equal(alice.response.status, 201);
  assert.equal(bob.response.status, 201);
  assert.equal((await request(running.baseUrl, '/api/config', { cookie: alice.cookie })).response.status, 200);
  assert.equal((await request(running.baseUrl, '/api/config')).response.status, 401);

  const profilePhoto = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=';
  const updatedProfile = await request(running.baseUrl, '/api/me', {
    method: 'PATCH',
    body: { displayName: 'Alice', username: 'alice', avatarData: profilePhoto },
    cookie: alice.cookie,
  });
  assert.equal(updatedProfile.response.status, 200);
  assert.equal(updatedProfile.value.user.avatarData, profilePhoto);
  const rejectedProfile = await request(running.baseUrl, '/api/me', {
    method: 'PATCH',
    body: { displayName: 'Changed name', username: 'alice', avatarData: 'not-an-image' },
    cookie: alice.cookie,
  });
  assert.equal(rejectedProfile.response.status, 400);
  const unchangedProfile = await request(running.baseUrl, '/api/me', { cookie: alice.cookie });
  assert.equal(unchangedProfile.value.user.displayName, 'Alice');

  const { response: conversationResponse, value: conversationResult } = await request(
    running.baseUrl,
    '/api/conversations',
    { method: 'POST', body: { username: 'bob' }, cookie: alice.cookie },
  );
  assert.equal(conversationResponse.status, 200);
  const conversationId = conversationResult.conversation.id;
  const bobConversationsBeforeMessage = await request(running.baseUrl, '/api/conversations', {
    cookie: bob.cookie,
  });
  const aliceAvatarUrl = bobConversationsBeforeMessage.value.conversations
    .find(conversation => conversation.id === conversationId).avatarUrl;
  assert.match(aliceAvatarUrl, /^\/api\/users\/[a-f0-9-]+\/avatar\?v=/i);
  const avatarResponse = await fetch(`${running.baseUrl}${aliceAvatarUrl}`, {
    headers: { Cookie: bob.cookie },
  });
  assert.equal(avatarResponse.status, 200);
  assert.equal(avatarResponse.headers.get('content-type'), 'image/png');
  assert.equal(await avatarResponse.text(), Buffer.from(profilePhoto.split(',')[1], 'base64').toString());
  const privateAvatar = await fetch(`${running.baseUrl}${aliceAvatarUrl}`);
  assert.equal(privateAvatar.status, 401);
  const sent = await request(running.baseUrl, `/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { text: 'Olá, Bob!' },
    cookie: alice.cookie,
  });
  assert.equal(sent.response.status, 201);

  const inbox = await request(
    running.baseUrl,
    `/api/conversations/${conversationId}/messages`,
    { cookie: bob.cookie },
  );
  assert.equal(inbox.value.messages[0].text, 'Olá, Bob!');
  assert.equal(inbox.value.messages[0].username, 'alice');
  assert.equal(inbox.value.messages[0].avatarUrl, aliceAvatarUrl);

  const image = await request(running.baseUrl, `/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: {
      type: 'image',
      text: '',
      imageData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=',
    },
    cookie: alice.cookie,
  });
  assert.equal(image.response.status, 201);
  const imageInbox = await request(
    running.baseUrl,
    `/api/conversations/${conversationId}/messages`,
    { cookie: bob.cookie },
  );
  assert.equal(imageInbox.value.messages.at(-1).type, 'image');
  assert.equal(imageInbox.value.messages.at(-1).imageData, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=');
  const recentMessages = await request(
    running.baseUrl,
    `/api/conversations/${conversationId}/messages?after=${sent.value.message.id}`,
    { cookie: bob.cookie },
  );
  assert.equal(recentMessages.value.messages.length, 1);
  assert.equal(recentMessages.value.messages[0].type, 'image');
  const customEmoji = await request(running.baseUrl, '/api/emojis', {
    method: 'POST',
    body: {
      name: 'gatinho',
      imageData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=',
    },
    cookie: alice.cookie,
  });
  assert.equal(customEmoji.response.status, 201);
  const sharedEmojis = await request(running.baseUrl, '/api/emojis', { cookie: bob.cookie });
  assert.equal(sharedEmojis.value.emojis[0].name, 'gatinho');
  const sentEmoji = await request(running.baseUrl, `/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { type: 'emoji', emojiName: 'gatinho' },
    cookie: alice.cookie,
  });
  assert.equal(sentEmoji.response.status, 201);
  const emojiInbox = await request(
    running.baseUrl,
    `/api/conversations/${conversationId}/messages?after=${imageInbox.value.messages.at(0).id}`,
    { cookie: bob.cookie },
  );
  assert.equal(emojiInbox.value.messages.at(-1).type, 'emoji');
  assert.equal(emojiInbox.value.messages.at(-1).emojiName, 'gatinho');
  assert.equal(emojiInbox.value.messages.at(-1).emojiData, customEmoji.value.emoji.imageData);

  const callOffer = await request(running.baseUrl, '/api/calls/signals', {
    method: 'POST',
    body: {
      conversationId,
      toUsername: 'bob',
      type: 'offer',
      payload: { description: { type: 'offer', sdp: 'v=0\r\n' }, video: true },
    },
    cookie: alice.cookie,
  });
  assert.equal(callOffer.response.status, 202);
  const callInbox = await request(running.baseUrl, '/api/calls/inbox', { cookie: bob.cookie });
  assert.equal(callInbox.value.signals[0].type, 'offer');
  assert.equal(callInbox.value.signals[0].fromUsername, 'alice');
  assert.equal((await request(running.baseUrl, '/api/calls/inbox', { cookie: bob.cookie }))
    .value.signals.length, 0);

  const group = await request(running.baseUrl, '/api/groups', {
    method: 'POST',
    body: { name: 'Amigos', usernames: ['bob'] },
    cookie: alice.cookie,
  });
  assert.equal(group.response.status, 201);
  const groupCall = await request(running.baseUrl, '/api/calls/signals', {
    method: 'POST',
    body: {
      conversationId: group.value.conversation.id,
      toUsername: 'bob',
      type: 'offer',
      payload: { description: { type: 'offer', sdp: 'v=0\r\n' } },
    },
    cookie: alice.cookie,
  });
  assert.equal(groupCall.response.status, 400);
  const bobConversations = await request(running.baseUrl, '/api/conversations', {
    cookie: bob.cookie,
  });
  assert.equal(bobConversations.value.conversations.length, 2);

  const invalidLogin = await request(running.baseUrl, '/api/login', {
    method: 'POST',
    body: { username: 'alice', password: 'incorrect' },
  });
  assert.equal(invalidLogin.response.status, 401);
  assert.equal((await request(running.baseUrl, '/api/conversations')).response.status, 401);

  await running.close();
  running = await startServer(dataFile);
  const login = await request(running.baseUrl, '/api/login', {
    method: 'POST',
    body: { username: 'alice', password: 'password-a' },
  });
  assert.equal(login.response.status, 200);
  const restoredProfile = await request(running.baseUrl, '/api/me', { cookie: login.cookie });
  assert.equal(restoredProfile.value.user.avatarData, profilePhoto);
  const persisted = await request(running.baseUrl, '/api/conversations', {
    cookie: login.cookie,
  });
  assert.equal(persisted.value.conversations.length, 2);
});

test('a separately hosted GitHub Pages frontend can use an explicitly allowed API origin', async t => {
  const previousOrigins = process.env.ZACORD_ALLOWED_ORIGINS;
  process.env.ZACORD_ALLOWED_ORIGINS = 'https://owner.github.io';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zacord-cors-test-'));
  let running;
  try {
    running = await startServer(path.join(directory, 'data.json'));
  } finally {
    if (previousOrigins === undefined) delete process.env.ZACORD_ALLOWED_ORIGINS;
    else process.env.ZACORD_ALLOWED_ORIGINS = previousOrigins;
  }
  t.after(async () => {
    await running.close();
    const dataFile = path.join(directory, 'data.json');
    if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
    fs.rmdirSync(directory);
  });

  const account = await request(running.baseUrl, '/api/register', {
    method: 'POST',
    body: { displayName: 'Pages User', username: 'pagesuser', password: 'pages-password' },
    origin: 'https://owner.github.io',
  });
  assert.equal(account.response.status, 201);
  assert.match(account.response.headers.get('access-control-allow-origin'), /owner\.github\.io/);
  assert.match(account.response.headers.get('set-cookie'), /SameSite=None; Secure/);

  const config = await request(running.baseUrl, '/api/config', {
    cookie: account.cookie,
    origin: 'https://owner.github.io',
  });
  assert.equal(config.response.status, 200);
  assert.equal(config.response.headers.get('access-control-allow-credentials'), 'true');

  const preflight = await fetch(`${running.baseUrl}/api/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://owner.github.io',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 204);

  const denied = await request(running.baseUrl, '/api/login', {
    method: 'POST',
    body: { username: 'pagesuser', password: 'pages-password' },
    origin: 'https://untrusted.example',
  });
  assert.equal(denied.response.status, 403);
});

test('a local frontend can use the local API with credentialed CORS', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zacord-local-cors-test-'));
  const running = await startServer(path.join(directory, 'data.json'));
  t.after(async () => {
    await running.close();
    const dataFile = path.join(directory, 'data.json');
    if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
    fs.rmdirSync(directory);
  });

  const origin = 'http://localhost:5500';
  const account = await request(running.baseUrl, '/api/register', {
    method: 'POST',
    body: { displayName: 'Local User', username: 'localuser', password: 'local-password' },
    origin,
  });
  assert.equal(account.response.status, 201);
  assert.equal(account.response.headers.get('access-control-allow-origin'), origin);
  assert.match(account.response.headers.get('set-cookie'), /SameSite=Strict/);

  const config = await request(running.baseUrl, '/api/config', {
    cookie: account.cookie,
    origin,
  });
  assert.equal(config.response.status, 200);
  assert.equal(config.response.headers.get('access-control-allow-credentials'), 'true');

  const preflight = await fetch(`${running.baseUrl}/api/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 204);

  const denied = await request(running.baseUrl, '/api/login', {
    method: 'POST',
    body: { username: 'localuser', password: 'local-password' },
    origin: 'https://untrusted.example',
  });
  assert.equal(denied.response.status, 403);
});

test('TURN credentials are fetched by the backend and cached for call configuration', async t => {
  const previousUrl = process.env.ZACORD_TURN_CREDENTIALS_URL;
  process.env.ZACORD_TURN_CREDENTIALS_URL =
    'https://zacord-test.metered.live/api/v1/turn/credentials?apiKey=private-test-key';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zacord-turn-test-'));
  let fetchCount = 0;
  let running;
  try {
    running = await startServer(path.join(directory, 'data.json'), {
      fetchImpl: async (url, options) => {
        fetchCount += 1;
        assert.equal(url, 'https://zacord-test.metered.live/api/v1/turn/credentials?apiKey=private-test-key');
        assert.ok(options.signal);
        return new Response(JSON.stringify([
          { urls: 'stun:stun.example.com:3478' },
          {
            urls: 'turns:relay.example.com:443?transport=tcp',
            username: 'temporary-user',
            credential: 'temporary-password',
          },
        ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });
  } finally {
    if (previousUrl === undefined) delete process.env.ZACORD_TURN_CREDENTIALS_URL;
    else process.env.ZACORD_TURN_CREDENTIALS_URL = previousUrl;
  }
  t.after(async () => {
    await running.close();
    const dataFile = path.join(directory, 'data.json');
    if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
    fs.rmdirSync(directory);
  });

  const account = await request(running.baseUrl, '/api/register', {
    method: 'POST',
    body: { displayName: 'Turn User', username: 'turnuser', password: 'turn-password' },
  });
  const firstConfig = await request(running.baseUrl, '/api/config', { cookie: account.cookie });
  const secondConfig = await request(running.baseUrl, '/api/config', { cookie: account.cookie });
  assert.equal(firstConfig.response.status, 200);
  assert.equal(firstConfig.value.iceServers[1].urls, 'turns:relay.example.com:443?transport=tcp');
  assert.equal(firstConfig.value.iceServers[1].credential, 'temporary-password');
  assert.equal(secondConfig.response.status, 200);
  assert.equal(fetchCount, 1);
});
