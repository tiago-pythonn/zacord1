'use strict';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SESSION_COOKIE = 'zacord_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PROFILE_IMAGE_BYTES = 512 * 1024;
const MAX_PROFILE_BODY_BYTES = Math.ceil(MAX_PROFILE_IMAGE_BYTES * 4 / 3) + 1024;
const MAX_CUSTOM_EMOJI_BYTES = 256 * 1024;
const MAX_SIGNAL_BYTES = 64 * 1024;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;
const STATIC_FILES = new Set([
  'app.js',
  'chat.css',
  'config.js',
  'index.html',
  'loginreal.css',
  'loginreal.html',
  'login_zacord.css',
  'login_zacord.html',
  'style.css',
]);
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createServer({
  dataFile = process.env.ZACORD_DATA_FILE || path.join(ROOT, 'data.json'),
  fetchImpl = fetch,
} = {}) {
  const sessions = new Map();
  const callSignals = [];
  const signalRates = new Map();
  const turnCredentialsUrl = process.env.ZACORD_TURN_CREDENTIALS_URL || '';
  let fetchedIceServers;
  let fetchedIceServersExpiresAt = 0;
  const allowedOrigins = (process.env.ZACORD_ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let store;

  if (turnCredentialsUrl) {
    let parsed;
    try {
      parsed = new URL(turnCredentialsUrl);
    } catch {
      throw new Error('ZACORD_TURN_CREDENTIALS_URL precisa ser uma URL HTTPS válida.');
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('ZACORD_TURN_CREDENTIALS_URL precisa usar HTTPS.');
    }
  }

  for (const origin of allowedOrigins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Origem inválida em ZACORD_ALLOWED_ORIGINS: ${origin}`);
    }
    if (parsed.origin !== origin || (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost')) {
      throw new Error(`Origem inválida em ZACORD_ALLOWED_ORIGINS: ${origin}`);
    }
  }

  function isAllowedOrigin(origin) {
    if (allowedOrigins.includes(origin)) return true;
    try {
      const parsed = new URL(origin);
      return parsed.origin === origin
        && parsed.protocol === 'http:'
        && ['localhost', '127.0.0.1'].includes(parsed.hostname);
    } catch {
      return false;
    }
  }

  if (process.env.ZACORD_ICE_SERVERS) {
    try {
      iceServers = JSON.parse(process.env.ZACORD_ICE_SERVERS);
      if (!Array.isArray(iceServers) || iceServers.length === 0
        || iceServers.some(server => !server || typeof server.urls !== 'string'
          && (!Array.isArray(server.urls) || server.urls.some(url => typeof url !== 'string')))) {
        throw new Error('A lista de servidores ICE está inválida.');
      }
    } catch (error) {
      throw new Error(`ZACORD_ICE_SERVERS inválido: ${error.message}`);
    }
  }

  async function getIceServers() {
    if (!turnCredentialsUrl) return iceServers;
    if (fetchedIceServers && fetchedIceServersExpiresAt > Date.now()) return fetchedIceServers;

    let response;
    let servers;
    try {
      response = await fetchImpl(turnCredentialsUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`TURN provider returned ${response.status}.`);
      servers = await response.json();
    } catch {
      throw new ApiError(502, 'Não foi possível obter servidores TURN. Confira a configuração do backend.');
    }

    if (!Array.isArray(servers) || servers.length === 0
      || servers.some(server => !server || typeof server.urls !== 'string'
        && (!Array.isArray(server.urls) || server.urls.some(url => typeof url !== 'string')))
      || !servers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls])
        .some(url => /^turns?:/i.test(url)))) {
      throw new ApiError(502, 'O provedor não retornou servidores TURN válidos.');
    }
    fetchedIceServers = servers;
    fetchedIceServersExpiresAt = Date.now() + 5 * 60 * 1000;
    return fetchedIceServers;
  }

  try {
    store = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (!Array.isArray(store.users) || !Array.isArray(store.conversations)) {
      throw new Error('O arquivo de dados não possui um formato válido.');
    }
    if (!Array.isArray(store.emojis)) store.emojis = [];
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Não foi possível carregar os dados do Zacord: ${error.message}`);
    }
    store = { users: [], conversations: [], emojis: [] };
  }

  function persist() {
    const temporaryFile = `${dataFile}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    try {
      fs.writeFileSync(temporaryFile, JSON.stringify(store, null, 2), { mode: 0o600 });
      fs.renameSync(temporaryFile, dataFile);
    } catch (error) {
      if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
      throw error;
    }
  }

  function sendJson(response, status, value, headers = {}) {
    response.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    response.end(JSON.stringify(value));
  }

  function requestOrigin(request) {
    const protocol = request.headers['x-forwarded-proto']?.split(',')[0].trim()
      || (request.socket.encrypted ? 'https' : 'http');
    return `${protocol}://${request.headers.host}`;
  }

  function corsHeaders(request) {
    const origin = request.headers.origin;
    if (!origin || !isAllowedOrigin(origin)) return {};
    return {
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin',
    };
  }

  function validateRequestOrigin(request) {
    const origin = request.headers.origin;
    if (origin && origin !== requestOrigin(request) && !isAllowedOrigin(origin)) {
      throw new ApiError(403, 'Origem não autorizada.');
    }
  }

  function readJson(request, maxBytes = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
      let body = '';
      let tooLarge = false;
      request.setEncoding('utf8');
      request.on('data', chunk => {
        if (tooLarge) return;
        body += chunk;
        if (Buffer.byteLength(body, 'utf8') > maxBytes) {
          tooLarge = true;
          body = '';
        }
      });
      request.on('end', () => {
        if (tooLarge) {
          reject(new ApiError(413, 'A solicitação excede o limite permitido.'));
          return;
        }
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new ApiError(400, 'Envie um JSON válido.'));
        }
      });
      request.on('error', reject);
    });
  }

  function currentUser(request) {
    const cookie = request.headers.cookie || '';
    const token = cookie.split(';').map(part => part.trim())
      .find(part => part.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    const session = token && sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return undefined;
    }
    return store.users.find(user => user.id === session.userId);
  }

  function requireUser(request) {
    const user = currentUser(request);
    if (!user) throw new ApiError(401, 'Faça login para continuar.');
    return user;
  }

  function safeUser(user) {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarData: user.avatarData || '',
    };
  }

  function createSession(user, request, response) {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, {
      userId: user.id,
      expiresAt: Date.now() + SESSION_MAX_AGE * 1000,
    });
    const crossOrigin = allowedOrigins.includes(request.headers.origin);
    const cookieAttributes = crossOrigin
      ? 'SameSite=None; Secure'
      : 'SameSite=Strict';
    response.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${token}; HttpOnly; ${cookieAttributes}; Path=/; Max-Age=${SESSION_MAX_AGE}`,
    );
  }

  function validateUsername(value) {
    const username = typeof value === 'string' ? value.trim().replace(/^@/, '') : '';
    if (!USERNAME_PATTERN.test(username)) {
      throw new ApiError(400, 'Username deve ter de 3 a 20 caracteres (letras, números ou _).');
    }
    return username;
  }

  function findConversation(id, userId) {
    const conversation = store.conversations.find(item => item.id === id);
    if (!conversation || !conversation.participants.includes(userId)) {
      throw new ApiError(404, 'Conversa não encontrada.');
    }
    return conversation;
  }

  function conversationSummary(conversation, user) {
    const otherUser = conversation.isGroup
      ? null
      : store.users.find(item => item.id !== user.id && conversation.participants.includes(item.id));
    const lastMessage = conversation.messages.at(-1);
    return {
      id: conversation.id,
      isGroup: conversation.isGroup,
      name: conversation.isGroup ? conversation.name : otherUser.displayName,
      username: otherUser?.username || '',
      avatarUrl: otherUser?.avatarData
        ? `/api/users/${otherUser.id}/avatar?v=${encodeURIComponent(otherUser.avatarRevision || '0')}`
        : '',
      members: conversation.participants.length,
      lastMessage: lastMessage ? {
        text: lastMessage.type === 'image' ? '📷 Foto'
          : lastMessage.type === 'emoji' ? `:${lastMessage.emojiName}:`
            : lastMessage.text,
        senderUsername: store.users.find(item => item.id === lastMessage.senderId)?.username || '',
        time: lastMessage.time,
      } : null,
    };
  }

  async function handleApi(request, response, url) {
    const { pathname } = url;
    const method = request.method;

    if (method === 'POST' && pathname === '/api/register') {
      const body = await readJson(request);
      const username = validateUsername(body.username);
      const displayName = typeof body.displayName === 'string'
        ? body.displayName.trim().slice(0, 40)
        : '';
      if (!displayName) throw new ApiError(400, 'Informe seu nome para exibição.');
      if (typeof body.password !== 'string' || Buffer.byteLength(body.password, 'utf8') < 8
        || Buffer.byteLength(body.password, 'utf8') > 128) {
        throw new ApiError(400, 'A senha deve ter entre 8 e 128 bytes.');
      }
      if (store.users.some(user => user.username.toLowerCase() === username.toLowerCase())) {
        throw new ApiError(409, 'Esse username já está em uso.');
      }
      const salt = randomBytes(16).toString('hex');
      const user = {
        id: randomUUID(),
        username,
        displayName,
        passwordSalt: salt,
        passwordHash: scryptSync(body.password, salt, 64).toString('hex'),
      };
      store.users.push(user);
      persist();
      createSession(user, request, response);
      sendJson(response, 201, { user: safeUser(user) });
      return;
    }

    if (method === 'POST' && pathname === '/api/login') {
      const body = await readJson(request);
      const username = validateUsername(body.username);
      const user = store.users.find(item => item.username.toLowerCase() === username.toLowerCase());
      const password = typeof body.password === 'string' ? body.password : '';
      const candidate = scryptSync(password, user?.passwordSalt || 'zacord-invalid-user', 64);
      const valid = user
        && timingSafeEqual(candidate, Buffer.from(user.passwordHash, 'hex'));
      if (!valid) throw new ApiError(401, 'Username ou senha incorretos.');
      createSession(user, request, response);
      sendJson(response, 200, { user: safeUser(user) });
      return;
    }

    if (method === 'POST' && pathname === '/api/logout') {
      const cookie = request.headers.cookie || '';
      const token = cookie.split(';').map(part => part.trim())
        .find(part => part.startsWith(`${SESSION_COOKIE}=`))
        ?.slice(SESSION_COOKIE.length + 1);
      if (token) sessions.delete(token);
      const crossOrigin = allowedOrigins.includes(request.headers.origin);
      const cookieAttributes = crossOrigin
        ? 'SameSite=None; Secure'
        : 'SameSite=Strict';
      sendJson(response, 200, { ok: true }, {
        'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; ${cookieAttributes}; Path=/; Max-Age=0`,
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/me') {
      sendJson(response, 200, { user: safeUser(requireUser(request)) });
      return;
    }

    const avatarMatch = pathname.match(/^\/api\/users\/([a-f0-9-]+)\/avatar$/i);
    if (method === 'GET' && avatarMatch) {
      const requester = requireUser(request);
      const profile = store.users.find(item => item.id === avatarMatch[1]);
      const canView = profile && (profile.id === requester.id
        || store.conversations.some(conversation =>
          conversation.participants.includes(requester.id)
          && conversation.participants.includes(profile.id)));
      if (!canView || !profile.avatarData) {
        throw new ApiError(404, 'Foto de perfil não encontrada.');
      }
      const match = profile.avatarData.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) throw new Error('A foto de perfil salva está inválida.');
      const image = Buffer.from(match[2], 'base64');
      const etag = `"${profile.id}-${profile.avatarRevision || '0'}"`;
      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304, {
          'Cache-Control': 'private, max-age=300',
          ETag: etag,
          'X-Content-Type-Options': 'nosniff',
        });
        response.end();
        return;
      }
      response.writeHead(200, {
        'Cache-Control': 'private, max-age=300',
        'Content-Length': image.length,
        'Content-Type': `image/${match[1]}`,
        ETag: etag,
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(image);
      return;
    }

    if (method === 'GET' && pathname === '/api/config') {
      requireUser(request);
      sendJson(response, 200, { iceServers: await getIceServers() });
      return;
    }

    if (method === 'GET' && pathname === '/api/emojis') {
      requireUser(request);
      sendJson(response, 200, {
        emojis: store.emojis.map(({ name, imageData }) => ({ name, imageData })),
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/emojis') {
      const user = requireUser(request);
      const body = await readJson(request, MAX_CUSTOM_EMOJI_BYTES * 2);
      const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
      if (!/^[a-z0-9_]{2,20}$/.test(name)) {
        throw new ApiError(400, 'O nome do emoji deve ter de 2 a 20 caracteres (letras, números ou _).');
      }
      if (store.emojis.filter(emoji => emoji.creatorId === user.id).length >= 20) {
        throw new ApiError(400, 'Você já cadastrou o limite de 20 emojis personalizados.');
      }
      if (store.emojis.some(emoji => emoji.name.toLowerCase() === name)) {
        throw new ApiError(409, 'Esse nome de emoji já está em uso.');
      }
      const match = typeof body.imageData === 'string'
        && body.imageData.match(/^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) throw new ApiError(400, 'Envie uma imagem JPEG, PNG, WebP ou GIF válida.');
      const imageBytes = Buffer.from(match[2], 'base64');
      if (imageBytes.length > MAX_CUSTOM_EMOJI_BYTES || imageBytes.toString('base64') !== match[2]) {
        throw new ApiError(413, 'Emojis personalizados devem ter no máximo 256 KB.');
      }
      store.emojis.push({
        id: randomUUID(),
        creatorId: user.id,
        name,
        imageData: body.imageData,
      });
      persist();
      sendJson(response, 201, { emoji: { name, imageData: body.imageData } });
      return;
    }

    if (method === 'PATCH' && pathname === '/api/me') {
      const user = requireUser(request);
      const body = await readJson(request, MAX_PROFILE_BODY_BYTES);
      const username = validateUsername(body.username);
      const displayName = typeof body.displayName === 'string'
        ? body.displayName.trim().slice(0, 40)
        : '';
      if (!displayName) throw new ApiError(400, 'Informe seu nome para exibição.');
      if (store.users.some(item => item.id !== user.id
        && item.username.toLowerCase() === username.toLowerCase())) {
        throw new ApiError(409, 'Esse username já está em uso.');
      }
      let avatarData = user.avatarData;
      if (body.avatarData !== undefined) {
        if (body.avatarData === '') {
          avatarData = undefined;
        } else {
          const match = typeof body.avatarData === 'string'
            && body.avatarData.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
          if (!match) {
            throw new ApiError(400, 'Escolha uma foto JPEG, PNG ou WebP válida.');
          }
          const imageBytes = Buffer.from(match[2], 'base64');
          if (imageBytes.length > MAX_PROFILE_IMAGE_BYTES
            || imageBytes.toString('base64') !== match[2]) {
            throw new ApiError(413, 'A foto de perfil deve ter no máximo 512 KB.');
          }
          avatarData = body.avatarData;
        }
      }
      user.username = username;
      user.displayName = displayName;
      if (avatarData) user.avatarData = avatarData;
      else delete user.avatarData;
      if (body.avatarData !== undefined) user.avatarRevision = randomUUID();
      persist();
      sendJson(response, 200, { user: safeUser(user) });
      return;
    }

    if (method === 'GET' && pathname === '/api/conversations') {
      const user = requireUser(request);
      const conversations = store.conversations
        .filter(item => item.participants.includes(user.id))
        .map(item => conversationSummary(item, user))
        .sort((a, b) => (b.lastMessage?.time || '').localeCompare(a.lastMessage?.time || ''));
      sendJson(response, 200, { conversations });
      return;
    }

    if (method === 'POST' && pathname === '/api/conversations') {
      const user = requireUser(request);
      const body = await readJson(request);
      const username = validateUsername(body.username);
      const recipient = store.users.find(item => item.username.toLowerCase() === username.toLowerCase());
      if (!recipient) throw new ApiError(404, 'Não encontramos esse username.');
      if (recipient.id === user.id) throw new ApiError(400, 'Você não pode iniciar uma conversa consigo.');
      let conversation = store.conversations.find(item => !item.isGroup
        && item.participants.length === 2
        && item.participants.includes(user.id)
        && item.participants.includes(recipient.id));
      if (!conversation) {
        conversation = {
          id: randomUUID(),
          isGroup: false,
          name: '',
          participants: [user.id, recipient.id],
          messages: [],
        };
        store.conversations.push(conversation);
        persist();
      }
      sendJson(response, 200, { conversation: conversationSummary(conversation, user) });
      return;
    }

    if (method === 'POST' && pathname === '/api/groups') {
      const user = requireUser(request);
      const body = await readJson(request);
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
      if (!name) throw new ApiError(400, 'Informe o nome do grupo.');
      if (!Array.isArray(body.usernames) || body.usernames.length < 1 || body.usernames.length > 49) {
        throw new ApiError(400, 'Informe entre 1 e 49 participantes pelo username.');
      }
      const usernames = [...new Set(body.usernames.map(validateUsername)
        .map(username => username.toLowerCase()))];
      const participants = [user.id];
      for (const username of usernames) {
        const member = store.users.find(item => item.username.toLowerCase() === username);
        if (!member) throw new ApiError(404, `Não encontramos o username @${username}.`);
        if (!participants.includes(member.id)) participants.push(member.id);
      }
      if (participants.length < 2) throw new ApiError(400, 'Adicione ao menos outra pessoa ao grupo.');
      const conversation = {
        id: randomUUID(),
        isGroup: true,
        name,
        participants,
        messages: [],
      };
      store.conversations.push(conversation);
      persist();
      sendJson(response, 201, { conversation: conversationSummary(conversation, user) });
      return;
    }

    if (method === 'GET' && pathname === '/api/calls/inbox') {
      const user = requireUser(request);
      const now = Date.now();
      for (let index = callSignals.length - 1; index >= 0; index -= 1) {
        if (callSignals[index].expiresAt <= now) callSignals.splice(index, 1);
      }
      const incoming = [];
      for (let index = callSignals.length - 1; index >= 0; index -= 1) {
        if (callSignals[index].toUserId === user.id) {
          incoming.unshift(callSignals.splice(index, 1)[0].signal);
        }
      }
      sendJson(response, 200, { signals: incoming });
      return;
    }

    if (method === 'POST' && pathname === '/api/calls/signals') {
      const user = requireUser(request);
      const body = await readJson(request, MAX_SIGNAL_BYTES);
      const conversation = findConversation(body.conversationId, user.id);
      if (conversation.isGroup || conversation.participants.length !== 2) {
        throw new ApiError(400, 'Chamadas estão disponíveis em conversas individuais.');
      }
      const recipient = store.users.find(item =>
        item.username.toLowerCase() === String(body.toUsername || '').trim().replace(/^@/, '').toLowerCase());
      if (!recipient || recipient.id === user.id || !conversation.participants.includes(recipient.id)) {
        throw new ApiError(400, 'Destinatário da chamada inválido.');
      }
      const allowedTypes = new Set(['offer', 'answer', 'ice', 'hangup', 'decline', 'busy']);
      if (!allowedTypes.has(body.type)) throw new ApiError(400, 'Sinal de chamada inválido.');
      if (body.type === 'ice' && (!body.payload || typeof body.payload.candidate !== 'string')) {
        throw new ApiError(400, 'Candidato de conexão inválido.');
      }
      if ((body.type === 'offer' || body.type === 'answer')
        && (!body.payload?.description || typeof body.payload.description.sdp !== 'string'
          || body.payload.description.sdp.length > MAX_SIGNAL_BYTES)) {
        throw new ApiError(400, 'Descrição da chamada inválida.');
      }
      if (callSignals.length >= 2000) throw new ApiError(503, 'Sinalização ocupada. Tente novamente.');
      const now = Date.now();
      const rate = (signalRates.get(user.id) || []).filter(time => now - time < 60_000);
      if (rate.length >= 120) throw new ApiError(429, 'Muitas atualizações de chamada. Tente novamente.');
      rate.push(now);
      signalRates.set(user.id, rate);
      callSignals.push({
        toUserId: recipient.id,
        expiresAt: now + 3 * 60 * 1000,
        signal: {
          id: randomUUID(),
          conversationId: conversation.id,
          type: body.type,
          payload: body.payload || {},
          fromUsername: user.username,
          fromDisplayName: user.displayName,
        },
      });
      sendJson(response, 202, { ok: true });
      return;
    }

    const messagesMatch = pathname.match(/^\/api\/conversations\/([a-f0-9-]+)\/messages$/i);
    if (messagesMatch && method === 'GET') {
      const user = requireUser(request);
      const conversation = findConversation(messagesMatch[1], user.id);
      const afterId = url.searchParams.get('after');
      const afterIndex = afterId
        ? conversation.messages.findIndex(message => message.id === afterId)
        : -1;
      const visibleMessages = conversation.messages.slice(afterIndex + 1);
      const messages = visibleMessages.map(message => {
        const sender = store.users.find(item => item.id === message.senderId);
        return {
          id: message.id,
          id: message.id,
          text: message.text,
          username: sender?.username || '',
          displayName: sender?.displayName || 'Usuário',
          avatarUrl: sender?.avatarData
            ? `/api/users/${sender.id}/avatar?v=${encodeURIComponent(sender.avatarRevision || '0')}`
            : '',
          type: message.type || 'text',
          time: message.time,
          ...(message.type === 'image' ? { imageData: message.imageData } : {}),
          ...(message.type === 'emoji' ? {
            emojiName: message.emojiName,
            emojiData: store.emojis.find(emoji => emoji.name === message.emojiName)?.imageData,
          } : {}),
        };
      });
      sendJson(response, 200, { messages });
      return;
    }

    if (messagesMatch && method === 'POST') {
      const user = requireUser(request);
      const conversation = findConversation(messagesMatch[1], user.id);
      const body = await readJson(request, MAX_IMAGE_BYTES * 2);
      let text = typeof body.text === 'string' ? body.text.trim() : '';
      let type = 'text';
      let imageData;
      let emojiName;
      if (body.type === 'image') {
        const match = typeof body.imageData === 'string'
          && body.imageData.match(/^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/);
        if (!match) throw new ApiError(400, 'Envie uma imagem JPEG, PNG, WebP ou GIF válida.');
        imageData = body.imageData;
        const imageBytes = Buffer.from(match[2], 'base64');
        if (imageBytes.length > MAX_IMAGE_BYTES || imageBytes.toString('base64') !== match[2]) {
          throw new ApiError(413, 'As imagens devem ter no máximo 4 MB.');
        }
        if (text.length > 500) throw new ApiError(400, 'A legenda deve ter até 500 caracteres.');
        type = 'image';
      } else if (body.type === 'emoji') {
        emojiName = typeof body.emojiName === 'string' ? body.emojiName.toLowerCase() : '';
        if (!store.emojis.some(emoji => emoji.name === emojiName)) {
          throw new ApiError(404, 'Emoji personalizado não encontrado.');
        }
        text = `:${emojiName}:`;
        type = 'emoji';
      } else if (!text || text.length > 2000) {
        throw new ApiError(400, 'A mensagem deve ter entre 1 e 2000 caracteres.');
      }
      const message = {
        id: randomUUID(),
        senderId: user.id,
        type,
        text,
        time: new Date().toISOString(),
        ...(imageData ? { imageData } : {}),
        ...(emojiName ? { emojiName } : {}),
      };
      conversation.messages.push(message);
      persist();
      sendJson(response, 201, {
        message: {
          id: message.id,
          text: message.text,
          username: user.username,
          displayName: user.displayName,
          type: message.type,
          time: message.time,
          ...(message.emojiName ? { emojiName: message.emojiName } : {}),
        },
      });
      return;
    }

    throw new ApiError(404, 'Endpoint não encontrado.');
  }

  function serveStatic(request, response, url) {
    let requested;
    try {
      requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    } catch {
      throw new ApiError(400, 'Caminho inválido.');
    }
    const fileName = requested.replace(/^\/+/, '');
    if (!STATIC_FILES.has(fileName)) throw new ApiError(404, 'Arquivo não encontrado.');
    const filePath = path.join(ROOT, fileName);
    const contents = fs.readFileSync(filePath);
    response.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Length': contents.length,
      'Content-Type': CONTENT_TYPES[path.extname(filePath)],
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const headers = corsHeaders(request);
        for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
        validateRequestOrigin(request);
        if (request.method === 'OPTIONS') {
          if (!isAllowedOrigin(request.headers.origin)) {
            throw new ApiError(403, 'Origem não autorizada.');
          }
          response.writeHead(204, headers);
          response.end();
          return;
        }
        await handleApi(request, response, url);
      } else if (request.method === 'GET' || request.method === 'HEAD') {
        serveStatic(request, response, url);
      } else {
        throw new ApiError(404, 'Endpoint não encontrado.');
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof ApiError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      console.error('Erro ao processar solicitação:', error);
      sendJson(response, 500, { error: 'Erro interno do servidor.' });
    }
  });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.ZACORD_HOST || '127.0.0.1';
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`Zacord disponível em http://${host}:${port}`);
  });
}

export { createServer };
