'use strict';

(() => {
  const apiBase = String(window.ZACORD_API_URL || '').trim().replace(/\/+$/, '');
  const pagesNeedsApi = !apiBase && location.hostname.endsWith('.github.io');
  const app = document.getElementById('app');
  const list = document.getElementById('list');
  const main = document.getElementById('main');
  const overlay = document.getElementById('overlay');
  const toasts = document.getElementById('toasts');
  const state = {
    user: null,
    conversations: [],
    selectedId: '',
    messages: [],
    polling: false,
    call: null,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    emojis: [],
    conversationRenderKey: '',
  };
  let toastTimer;

  async function api(path, options = {}) {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      credentials: apiBase ? 'include' : 'same-origin',
      ...(apiBase ? { mode: 'cors' } : {}),
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    const result = await response.json().catch(() => {
      throw new Error('O backend retornou uma resposta inválida. Configure a API em config.js.');
    });
    if (!response.ok) {
      const error = new Error(result.error || 'Não foi possível concluir a solicitação.');
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function initials(value) {
    return (value || '?').trim().split(/\s+/).slice(0, 2)
      .map(part => part[0] || '').join('').toUpperCase() || '?';
  }

  function setAvatar(element, imageData, label, avatarUrl = '') {
    element.replaceChildren();
    const source = imageData || (avatarUrl ? `${apiBase}${avatarUrl}` : '');
    if (source) {
      const image = document.createElement('img');
      image.src = source;
      image.alt = '';
      image.title = label;
      element.append(image);
    } else {
      element.textContent = initials(label);
    }
  }

  async function prepareProfilePhoto(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      throw new Error('Escolha uma imagem JPEG, PNG ou WebP.');
    }
    if (file.size > 10 * 1024 * 1024) {
      throw new Error('A imagem original deve ter no máximo 10 MB.');
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('Não foi possível abrir essa imagem.'));
        image.src = objectUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 320;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Não foi possível processar essa imagem.');
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        image,
        (image.naturalWidth - side) / 2,
        (image.naturalHeight - side) / 2,
        side,
        side,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      for (let quality = 0.86; quality >= 0.5; quality -= 0.12) {
        const imageData = canvas.toDataURL('image/jpeg', quality);
        if (imageData.length * 0.75 <= 512 * 1024) return imageData;
      }
      throw new Error('Não foi possível reduzir a foto para o limite de 512 KB.');
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toasts.replaceChildren(toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.remove(), 3000);
  }

  function makeField(form, { label: labelText, name, placeholder, type = 'text', required = false, minLength }) {
    const label = document.createElement('label');
    label.textContent = labelText;
    const input = document.createElement('input');
    input.name = name;
    input.type = type;
    input.placeholder = placeholder;
    input.required = required;
    input.autocomplete = name === 'password'
      ? (form.dataset.mode === 'register' ? 'new-password' : 'current-password')
      : name === 'username' ? 'username' : 'name';
    if (minLength) input.minLength = minLength;
    label.append(input);
    form.append(label);
    return input;
  }

  function showAuth(mode = 'register') {
    const backdrop = document.createElement('div');
    backdrop.className = 'modalback';
    const form = document.createElement('form');
    form.className = 'modal';
    form.dataset.mode = mode;
    const title = document.createElement('h2');
    title.textContent = mode === 'register' ? 'Crie sua conta' : 'Entre no Zacord';
    const description = document.createElement('p');
    description.textContent = pagesNeedsApi
      ? 'O site está no GitHub Pages. Configure o endereço do backend em config.js para habilitar login e mensagens.'
      : mode === 'register'
        ? 'Cadastre-se para conversar com seus amigos.'
        : 'Entre com seu username e senha para ver suas conversas.';
    form.append(title, description);
    if (mode === 'register') {
      makeField(form, {
        label: 'Seu nome',
        name: 'displayName',
        placeholder: 'Como podemos te chamar?',
        required: true,
      });
    }
    const username = makeField(form, {
      label: 'Username',
      name: 'username',
      placeholder: 'ex.: ana_silva',
      required: true,
    });
    username.maxLength = 20;
    const password = makeField(form, {
      label: 'Senha',
      name: 'password',
      type: 'password',
      placeholder: 'Mínimo de 8 caracteres',
      required: true,
      minLength: 8,
    });
    password.maxLength = 128;
    const error = document.createElement('div');
    error.className = 'hint';
    error.setAttribute('role', 'alert');
    error.style.color = '#ff929e';
    form.append(error);

    const switchLine = document.createElement('p');
    switchLine.style.margin = '15px 0 0';
    switchLine.style.fontSize = '12px';
    const switchButton = document.createElement('button');
    switchButton.type = 'button';
    switchButton.className = 'icon';
    switchButton.style.fontSize = '12px';
    switchButton.textContent = mode === 'register' ? 'Já tem conta? Entrar' : 'Ainda não tem conta? Criar conta';
    switchButton.onclick = () => showAuth(mode === 'register' ? 'login' : 'register');
    switchLine.append(switchButton);

    const footer = document.createElement('div');
    footer.className = 'modalfoot';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary';
    submit.textContent = pagesNeedsApi
      ? 'Backend não configurado'
      : mode === 'register' ? 'Criar conta' : 'Entrar';
    submit.disabled = pagesNeedsApi;
    footer.append(submit);
    form.append(switchLine, footer);
    form.onsubmit = async event => {
      event.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      try {
        const values = Object.fromEntries(new FormData(form));
        const endpoint = mode === 'register' ? '/api/register' : '/api/login';
        const result = await api(endpoint, { method: 'POST', body: JSON.stringify(values) });
        state.user = result.user;
        backdrop.remove();
        await startApp();
      } catch (requestError) {
        error.textContent = requestError.message;
      } finally {
        submit.disabled = false;
      }
    };
    backdrop.append(form);
    overlay.replaceChildren(backdrop);
    (mode === 'register' ? form.elements.displayName : username).focus();
  }

  function updateProfile() {
    const backdrop = document.createElement('div');
    backdrop.className = 'modalback';
    const form = document.createElement('form');
    form.className = 'modal';
    const title = document.createElement('h2');
    title.textContent = 'Seu perfil';
    const description = document.createElement('p');
    description.textContent = 'Atualize seu nome e username.';
    form.append(title, description);
    const displayName = makeField(form, {
      label: 'Nome',
      name: 'displayName',
      placeholder: 'Seu nome',
      required: true,
    });
    displayName.value = state.user.displayName;
    const username = makeField(form, {
      label: 'Username',
      name: 'username',
      placeholder: 'ex.: ana_silva',
      required: true,
    });
    username.value = state.user.username;
    username.maxLength = 20;
    let avatarData = state.user.avatarData || '';
    const photoLabel = document.createElement('label');
    photoLabel.textContent = 'Foto de perfil';
    const photo = document.createElement('input');
    photo.type = 'file';
    photo.accept = 'image/jpeg,image/png,image/webp';
    photo.setAttribute('aria-label', 'Escolher foto de perfil');
    photoLabel.append(photo);
    const photoPreview = document.createElement('div');
    photoPreview.className = 'avatar profile-editor-avatar';
    setAvatar(photoPreview, avatarData, state.user.displayName);
    const error = document.createElement('div');
    error.className = 'hint';
    error.setAttribute('role', 'alert');
    error.style.color = '#ff929e';
    const removePhoto = document.createElement('button');
    removePhoto.type = 'button';
    removePhoto.className = 'secondary remove-avatar';
    removePhoto.textContent = 'Remover foto';
    removePhoto.disabled = !avatarData;
    removePhoto.onclick = () => {
      avatarData = '';
      photo.value = '';
      setAvatar(photoPreview, '', displayName.value);
      removePhoto.disabled = true;
    };
    photo.onchange = async () => {
      const file = photo.files?.[0];
      if (!file) return;
      try {
        avatarData = await prepareProfilePhoto(file);
        setAvatar(photoPreview, avatarData, displayName.value);
        removePhoto.disabled = false;
      } catch (requestError) {
        photo.value = '';
        error.textContent = requestError.message;
      }
    };
    form.append(photoLabel, photoPreview, removePhoto);
    form.append(error);

    const footer = document.createElement('div');
    footer.className = 'modalfoot';
    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'secondary';
    logout.textContent = 'Sair';
    logout.onclick = async () => {
      try {
        await finishCall({ sendSignal: true });
        await api('/api/logout', { method: 'POST' });
        clearInterval(state.pollingTimer);
        clearInterval(state.callPollingTimer);
        state.user = null;
        state.conversations = [];
        state.selectedId = '';
        state.messages = [];
        app.classList.remove('chat-open');
        backdrop.remove();
        render();
        showAuth('login');
      } catch (requestError) {
        error.textContent = requestError.message;
      }
    };
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.textContent = 'Cancelar';
    cancel.onclick = () => backdrop.remove();
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'primary';
    save.textContent = 'Salvar';
    footer.append(logout, cancel, save);
    form.append(footer);
    form.onsubmit = async event => {
      event.preventDefault();
      error.textContent = '';
      save.disabled = true;
      try {
        const result = await api('/api/me', {
          method: 'PATCH',
          body: JSON.stringify({
            ...Object.fromEntries(new FormData(form)),
            avatarData,
          }),
        });
        state.user = result.user;
        backdrop.remove();
        render();
        await refreshData();
        showToast('Perfil atualizado.');
      } catch (requestError) {
        error.textContent = requestError.message;
      } finally {
        save.disabled = false;
      }
    };
    backdrop.append(form);
    overlay.replaceChildren(backdrop);
    displayName.focus();
  }

  function selectedConversation() {
    return state.conversations.find(conversation => conversation.id === state.selectedId);
  }

  function renderList() {
    const query = document.getElementById('search').value.toLowerCase();
    const renderKey = JSON.stringify([
      query,
      state.selectedId,
      state.user?.username,
      state.conversations.map(({ id, name, username, avatarUrl, members, lastMessage }) => ({
        id,
        name,
        username,
        avatarUrl,
        members,
        lastMessage,
      })),
    ]);
    if (renderKey === state.conversationRenderKey) return;
    state.conversationRenderKey = renderKey;
    list.replaceChildren();
    const conversations = state.conversations.filter(conversation =>
      `${conversation.name} ${conversation.username} ${conversation.lastMessage?.text || ''}`
        .toLowerCase().includes(query));
    if (!conversations.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:20px 10px;color:var(--muted);font-size:12px;text-align:center';
      empty.textContent = query
        ? 'Nenhuma conversa encontrada.'
        : 'Adicione um contato ou crie seu primeiro grupo.';
      list.append(empty);
      return;
    }

    conversations.forEach(conversation => {
      const button = document.createElement('button');
      button.className = `chat${state.selectedId === conversation.id ? ' selected' : ''}`;
      button.onclick = () => selectConversation(conversation.id);
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      setAvatar(avatar, '', conversation.name, conversation.avatarUrl);
      const copy = document.createElement('div');
      copy.className = 'copy';
      const line = document.createElement('div');
      line.className = 'chatline';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = conversation.name;
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = conversation.lastMessage ? formatTime(conversation.lastMessage.time) : '';
      line.append(name, time);
      const preview = document.createElement('div');
      preview.className = 'preview';
      preview.textContent = conversation.lastMessage
        ? `${conversation.lastMessage.senderUsername.toLowerCase() === state.user.username.toLowerCase() ? 'Você: ' : ''}${conversation.lastMessage.text}`
        : conversation.isGroup ? `${conversation.members} participantes` : `@${conversation.username}`;
      copy.append(line, preview);
      button.append(avatar, copy);
      list.append(button);
    });
  }

  function formatTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  async function sendMessage(conversationId, message) {
    await api(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify(message),
    });
    await refreshData();
  }

  function showImagePreview(imageData) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modalback image-preview';
    const image = document.createElement('img');
    image.src = imageData;
    image.alt = 'Imagem ampliada';
    backdrop.append(image);
    backdrop.onclick = () => backdrop.remove();
    overlay.replaceChildren(backdrop);
  }

  function addCustomEmoji() {
    const backdrop = document.createElement('div');
    backdrop.className = 'modalback';
    const form = document.createElement('form');
    form.className = 'modal';
    const title = document.createElement('h2');
    title.textContent = 'Criar emoji personalizado';
    const description = document.createElement('p');
    description.textContent = 'Escolha uma imagem pequena para usar como emoji nas conversas.';
    form.append(title, description);
    const name = makeField(form, {
      label: 'Nome do emoji',
      name: 'name',
      placeholder: 'ex.: gatinho',
      required: true,
    });
    name.maxLength = 20;
    name.pattern = '[A-Za-z0-9_]{2,20}';
    const fileLabel = document.createElement('label');
    fileLabel.textContent = 'Imagem (máximo de 256 KB)';
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/jpeg,image/png,image/webp,image/gif';
    file.required = true;
    fileLabel.append(file);
    form.append(fileLabel);
    const error = document.createElement('div');
    error.className = 'hint';
    error.setAttribute('role', 'alert');
    error.style.color = '#ff929e';
    form.append(error);
    const footer = document.createElement('div');
    footer.className = 'modalfoot';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.textContent = 'Cancelar';
    cancel.onclick = () => backdrop.remove();
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'primary';
    save.textContent = 'Salvar emoji';
    footer.append(cancel, save);
    form.append(footer);
    form.onsubmit = async event => {
      event.preventDefault();
      const image = file.files?.[0];
      if (!image) return;
      if (image.size > 256 * 1024) {
        error.textContent = 'A imagem deve ter no máximo 256 KB.';
        return;
      }
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(image.type)) {
        error.textContent = 'Escolha uma imagem JPEG, PNG, WebP ou GIF.';
        return;
      }
      error.textContent = '';
      save.disabled = true;
      try {
        const imageData = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Não foi possível ler essa imagem.'));
          reader.readAsDataURL(image);
        });
        const result = await api('/api/emojis', {
          method: 'POST',
          body: JSON.stringify({ name: name.value.trim().toLowerCase(), imageData }),
        });
        state.emojis.push(result.emoji);
        backdrop.remove();
        render();
        showToast(`Emoji :${result.emoji.name}: adicionado.`);
      } catch (requestError) {
        error.textContent = requestError.message;
      } finally {
        save.disabled = false;
      }
    };
    backdrop.append(form);
    overlay.replaceChildren(backdrop);
    name.focus();
  }

  async function sendCallSignal(call, type, payload = {}) {
    await api('/api/calls/signals', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: call.conversation.id,
        toUsername: call.peerUsername,
        type,
        payload,
      }),
    });
  }

  function updateCallStatus(text) {
    const status = overlay.querySelector('.call-status');
    if (status) status.textContent = text;
  }

  async function toggleCallFullscreen(call, button) {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await call.card.requestFullscreen();
      }
    } catch (error) {
      showToast(`Não foi possível abrir a chamada em tela cheia: ${error.message}`);
    }
    if (call.fullscreenChangeHandler) call.fullscreenChangeHandler();
  }

  function updateFullscreenButton(call, button) {
    const isFullscreen = document.fullscreenElement === call.card;
    button.textContent = isFullscreen ? '⤢' : '⛶';
    button.title = isFullscreen ? 'Sair da tela cheia (Esc)' : 'Tela cheia (F11)';
    button.setAttribute('aria-label', button.title);
  }

  function playRemoteAudio(call) {
    if (!call.remoteAudio?.srcObject) return;
    call.remoteAudio.play().then(() => {
      call.audioPlaybackBlocked = false;
      call.controls?.enableAudio?.classList.remove('audio-needed');
    }).catch(() => {
      call.audioPlaybackBlocked = true;
      call.controls?.enableAudio?.classList.add('audio-needed');
    });
  }

  function renderCallPanel(call) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modalback callback';
    const card = document.createElement('section');
    card.className = 'modal call-card';
    call.card = card;
    const heading = document.createElement('header');
    heading.className = 'call-heading';
    const title = document.createElement('h2');
    title.textContent = call.peerDisplayName;
    const status = document.createElement('p');
    status.className = 'call-status';
    status.textContent = call.statusText;
    heading.append(title, status);
    card.append(heading);

    if (call.status !== 'incoming') {
      const videos = document.createElement('div');
      videos.className = 'call-videos';
      const remote = document.createElement('video');
      remote.className = 'remote-video';
      remote.autoplay = true;
      remote.playsInline = true;
      remote.muted = true;
      const remoteAudio = document.createElement('audio');
      remoteAudio.autoplay = true;
      remoteAudio.setAttribute('playsinline', '');
      const local = document.createElement('video');
      local.className = 'local-video';
      local.autoplay = true;
      local.playsInline = true;
      local.muted = true;
      videos.append(remote, remoteAudio, local);
      call.remoteVideo = remote;
      call.remoteAudio = remoteAudio;
      call.localVideo = local;
      if (call.remoteStream) {
        remote.srcObject = new MediaStream(call.remoteStream.getVideoTracks());
        remoteAudio.srcObject = new MediaStream(call.remoteStream.getAudioTracks());
      }
      if (call.localStream) local.srcObject = call.localStream;
      card.append(videos);

      const controls = document.createElement('div');
      controls.className = 'call-controls';
      const enableAudio = document.createElement('button');
      enableAudio.type = 'button';
      enableAudio.textContent = '🔊';
      enableAudio.title = 'Ativar áudio recebido';
      enableAudio.setAttribute('aria-label', enableAudio.title);
      enableAudio.onclick = () => playRemoteAudio(call);
      const mic = document.createElement('button');
      mic.type = 'button';
      mic.textContent = '🎙';
      mic.title = 'Silenciar ou ativar microfone';
      mic.setAttribute('aria-label', mic.title);
      mic.onclick = () => {
        const track = call.localStream?.getAudioTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        mic.classList.toggle('active', !track.enabled);
      };
      const camera = document.createElement('button');
      camera.type = 'button';
      camera.textContent = '▣';
      camera.title = 'Ativar ou desligar câmera';
      camera.setAttribute('aria-label', camera.title);
      camera.onclick = () => toggleCamera(call, camera);
      const share = document.createElement('button');
      share.type = 'button';
      share.textContent = '▤';
      share.title = 'Compartilhar tela';
      share.setAttribute('aria-label', share.title);
      share.onclick = () => toggleScreenShare(call, share);
      const enlarge = document.createElement('button');
      enlarge.type = 'button';
      enlarge.textContent = '⤢';
      enlarge.title = 'Aumentar ou diminuir o vídeo';
      enlarge.setAttribute('aria-label', enlarge.title);
      enlarge.onclick = () => {
        videos.classList.toggle('video-expanded');
        enlarge.classList.toggle('active', videos.classList.contains('video-expanded'));
      };
      const fullscreen = document.createElement('button');
      fullscreen.type = 'button';
      fullscreen.textContent = '⛶';
      fullscreen.title = 'Tela cheia (F11)';
      fullscreen.setAttribute('aria-label', fullscreen.title);
      fullscreen.onclick = () => toggleCallFullscreen(call, fullscreen);
      call.fullscreenButton = fullscreen;
      call.fullscreenChangeHandler = () => updateFullscreenButton(call, fullscreen);
      document.addEventListener('fullscreenchange', call.fullscreenChangeHandler);
      const end = document.createElement('button');
      end.type = 'button';
      end.className = 'end-call';
      end.textContent = '☎';
      end.title = 'Encerrar chamada';
      end.setAttribute('aria-label', end.title);
      end.onclick = () => finishCall({ sendSignal: true });
      controls.append(enableAudio, mic, camera, share, enlarge, fullscreen, end);
      card.append(controls);
      call.controls = { enableAudio, mic, camera, share, enlarge, fullscreen };
      if (call.remoteAudio) playRemoteAudio(call);
    } else {
      const incoming = document.createElement('div');
      incoming.className = 'call-incoming';
      const accept = document.createElement('button');
      accept.type = 'button';
      accept.className = 'primary';
      accept.textContent = 'Atender';
      accept.onclick = () => acceptCall(call);
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'secondary reject-call';
      reject.textContent = 'Recusar';
      reject.onclick = () => finishCall({ sendSignal: true, signalType: 'decline' });
      incoming.append(accept, reject);
      card.append(incoming);
    }

    backdrop.append(card);
    overlay.replaceChildren(backdrop);
  }

  function createPeerConnection(call) {
    const peer = new RTCPeerConnection({
      iceServers: state.iceServers,
    });
    call.peerConnection = peer;
    peer.onicecandidate = event => {
      if (!event.candidate) return;
      const candidate = event.candidate.toJSON();
      if (!call.signalReady) {
        call.pendingLocalIce.push(candidate);
        return;
      }
      sendCallSignal(call, 'ice', { candidate })
        .catch(error => showToast(`Falha na conexão: ${error.message}`));
    };
    peer.ontrack = event => {
      call.remoteStream ||= new MediaStream();
      if (!call.remoteStream.getTracks().some(track => track.id === event.track.id)) {
        call.remoteStream.addTrack(event.track);
      }
      if (event.track.kind === 'video' && call.remoteVideo) {
        call.remoteVideo.srcObject = new MediaStream([event.track]);
      }
      if (event.track.kind === 'audio' && call.remoteAudio) {
        call.remoteAudio.srcObject = new MediaStream([event.track]);
        playRemoteAudio(call);
      }
      event.track.onunmute = () => {
        if (event.track.kind === 'audio') playRemoteAudio(call);
      };
      event.track.onended = () => {
        call.statusText = event.track.kind === 'video'
          ? 'A outra câmera foi desligada.'
          : 'O áudio da outra pessoa foi desconectado.';
        updateCallStatus(call.statusText);
      };
    };
    peer.onconnectionstatechange = () => {
      if (state.call !== call) return;
      if (peer.connectionState === 'connected') {
        clearTimeout(call.disconnectTimeout);
        call.statusText = 'Conectado';
        updateCallStatus(call.statusText);
      } else if (peer.connectionState === 'failed') {
        finishCall();
        showToast('A rede bloqueou a chamada. Para conectar entre redes diferentes, o backend precisa de um servidor TURN.');
      } else if (peer.connectionState === 'disconnected') {
        call.statusText = 'Reconectando…';
        updateCallStatus(call.statusText);
        clearTimeout(call.disconnectTimeout);
        call.disconnectTimeout = setTimeout(() => {
          if (state.call !== call || peer.connectionState !== 'disconnected') return;
          finishCall();
          showToast('A conexão caiu. Confira a internet e tente novamente; redes restritivas podem exigir TURN.');
        }, 12_000);
      }
    };
    return peer;
  }

  async function flushLocalIce(call) {
    for (const candidate of call.pendingLocalIce.splice(0)) {
      await sendCallSignal(call, 'ice', { candidate });
    }
  }

  async function flushRemoteIce(call) {
    if (!call.peerConnection?.remoteDescription) return;
    for (const candidate of call.pendingRemoteIce.splice(0)) {
      await call.peerConnection.addIceCandidate(candidate);
    }
  }

  async function startCall(conversation, video) {
    if (conversation.isGroup) {
      showToast('Chamadas em grupo ainda não estão disponíveis.');
      return;
    }
    if (state.call) {
      showToast('Encerre a chamada atual antes de iniciar outra.');
      return;
    }
    if (!window.isSecureContext
      && !['localhost', '127.0.0.1'].includes(location.hostname)) {
      showToast('Chamadas precisam de HTTPS para acessar câmera e microfone.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      showToast('Este navegador não oferece suporte a chamadas de áudio e vídeo.');
      return;
    }
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
      } catch (error) {
        if (!video || error.name !== 'NotFoundError' && error.name !== 'NotAllowedError'
          && error.name !== 'OverconstrainedError') throw error;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        showToast('A câmera não foi liberada ou não foi encontrada. A chamada continuará só com áudio.');
      }
      const call = {
        conversation,
        peerUsername: conversation.username,
        peerDisplayName: conversation.name,
        status: 'outgoing',
        statusText: 'Chamando…',
        localStream: stream,
        remoteStream: null,
        pendingLocalIce: [],
        pendingRemoteIce: [],
        signalReady: false,
        videoSender: null,
      };
      call.timeout = setTimeout(() => {
        finishCall({ sendSignal: true });
        showToast('A chamada não foi atendida.');
      }, 45_000);
      state.call = call;
      const peer = createPeerConnection(call);
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) call.audioSender = peer.addTrack(audioTrack, stream);
      const videoTransceiver = peer.addTransceiver('video', { direction: 'sendrecv' });
      call.videoSender = videoTransceiver.sender;
      const cameraTrack = stream.getVideoTracks()[0];
      if (cameraTrack) await call.videoSender.replaceTrack(cameraTrack);
      renderCallPanel(call);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await sendCallSignal(call, 'offer', {
        description: peer.localDescription,
        video: Boolean(stream.getVideoTracks().length),
      });
      call.signalReady = true;
      await flushLocalIce(call);
    } catch (error) {
      if (state.call) finishCall();
      showToast(`Não foi possível iniciar a chamada: ${error.message}`);
    }
  }

  async function acceptCall(call) {
    if (state.call !== call) return;
    try {
      if (!window.isSecureContext
        && !['localhost', '127.0.0.1'].includes(location.hostname)) {
        throw new Error('Chamadas precisam de HTTPS para acessar câmera e microfone.');
      }
      clearTimeout(call.timeout);
      const wantsVideo = Boolean(call.offerVideo);
      try {
        call.localStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: wantsVideo,
        });
      } catch (error) {
        if (!wantsVideo || error.name !== 'NotFoundError' && error.name !== 'NotAllowedError'
          && error.name !== 'OverconstrainedError') throw error;
        call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        showToast('A câmera não foi liberada ou não foi encontrada. A chamada continuará só com áudio.');
      }
      call.status = 'connecting';
      call.statusText = 'Conectando…';
      const peer = createPeerConnection(call);
      await peer.setRemoteDescription(call.offerDescription);
      const audioTrack = call.localStream.getAudioTracks()[0];
      if (audioTrack) call.audioSender = peer.addTrack(audioTrack, call.localStream);
      let videoTransceiver = peer.getTransceivers()
        .find(transceiver => transceiver.receiver.track.kind === 'video');
      if (!videoTransceiver) videoTransceiver = peer.addTransceiver('video', { direction: 'sendrecv' });
      videoTransceiver.direction = 'sendrecv';
      call.videoSender = videoTransceiver.sender;
      const cameraTrack = call.localStream.getVideoTracks()[0];
      if (cameraTrack) await call.videoSender.replaceTrack(cameraTrack);
      renderCallPanel(call);
      await flushRemoteIce(call);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await sendCallSignal(call, 'answer', { description: peer.localDescription });
      call.signalReady = true;
      await flushLocalIce(call);
    } catch (error) {
      finishCall({ sendSignal: true, signalType: 'decline' });
      showToast(`Não foi possível atender a chamada: ${error.message}`);
    }
  }

  async function toggleCamera(call, button) {
    try {
      let track = call.localStream.getVideoTracks()[0];
      if (!track) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        track = stream.getVideoTracks()[0];
        call.localStream.addTrack(track);
        if (call.localVideo) call.localVideo.srcObject = call.localStream;
        await call.videoSender.replaceTrack(track);
      } else {
        track.enabled = !track.enabled;
      }
      button.classList.toggle('active', track.enabled);
    } catch (error) {
      showToast(`Não foi possível acessar a câmera: ${error.message}`);
    }
  }

  async function toggleScreenShare(call, button) {
    if (call.displayStream) {
      await stopScreenShare(call);
      button.classList.remove('active');
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      showToast('Este navegador não oferece suporte ao compartilhamento de tela.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const track = stream.getVideoTracks()[0];
      call.displayStream = stream;
      await call.videoSender.replaceTrack(track);
      const displayAudio = stream.getAudioTracks()[0];
      if (displayAudio && call.audioSender) {
        const audioContext = new AudioContext();
        const destination = audioContext.createMediaStreamDestination();
        audioContext.createMediaStreamSource(call.localStream).connect(destination);
        audioContext.createMediaStreamSource(new MediaStream([displayAudio])).connect(destination);
        call.audioContext = audioContext;
        await call.audioSender.replaceTrack(destination.stream.getAudioTracks()[0]);
      }
      button.classList.add('active');
      if (call.localVideo) call.localVideo.srcObject = stream;
      track.onended = async () => {
        await stopScreenShare(call);
        button.classList.remove('active');
      };
    } catch (error) {
      if (error.name !== 'NotAllowedError') showToast(`Não foi possível compartilhar a tela: ${error.message}`);
    }
  }

  async function stopScreenShare(call) {
    const display = call.displayStream;
    if (!display) return;
    call.displayStream = null;
    if (call.audioContext) {
      await call.audioSender.replaceTrack(call.localStream.getAudioTracks()[0]);
      await call.audioContext.close();
      call.audioContext = null;
    }
    const cameraTrack = call.localStream?.getVideoTracks()[0];
    await call.videoSender.replaceTrack(cameraTrack?.enabled ? cameraTrack : null);
    display.getTracks().forEach(track => track.stop());
    if (call.localVideo) call.localVideo.srcObject = call.localStream;
  }

  async function finishCall({ sendSignal = false, signalType = 'hangup' } = {}) {
    const call = state.call;
    if (!call) return;
    state.call = null;
    clearTimeout(call.timeout);
    clearTimeout(call.disconnectTimeout);
    if (sendSignal) {
      try {
        await sendCallSignal(call, signalType);
      } catch (error) {
        showToast(`Não foi possível avisar o outro usuário: ${error.message}`);
      }
    }
    if (document.fullscreenElement === call.card) {
      try {
        await document.exitFullscreen();
      } catch (error) {
        console.error('Não foi possível sair da tela cheia da chamada:', error);
      }
    }
    if (call.fullscreenChangeHandler) {
      document.removeEventListener('fullscreenchange', call.fullscreenChangeHandler);
    }
    call.peerConnection?.close();
    if (call.audioContext) await call.audioContext.close();
    call.displayStream?.getTracks().forEach(track => track.stop());
    call.localStream?.getTracks().forEach(track => track.stop());
    overlay.querySelector('.callback')?.remove();
  }

  async function processCallSignal(signal) {
    if (!state.conversations.some(item => item.id === signal.conversationId)) await refreshData();
    const conversation = state.conversations.find(item => item.id === signal.conversationId);
    if (!conversation || conversation.isGroup) return;
    if (signal.type === 'offer') {
      if (state.call) {
        const busyCall = {
          conversation,
          peerUsername: signal.fromUsername,
        };
        await sendCallSignal(busyCall, 'busy');
        return;
      }
      const call = {
        conversation,
        peerUsername: signal.fromUsername,
        peerDisplayName: signal.fromDisplayName,
        status: 'incoming',
        statusText: 'Chamada recebida',
        offerDescription: signal.payload.description,
        offerVideo: Boolean(signal.payload.video),
        pendingLocalIce: [],
        pendingRemoteIce: [],
        signalReady: false,
      };
      state.call = call;
      renderCallPanel(call);
      return;
    }
    const call = state.call;
    if (!call || call.conversation.id !== signal.conversationId
      || call.peerUsername.toLowerCase() !== signal.fromUsername.toLowerCase()) return;
    if (signal.type === 'ice') {
      if (call.peerConnection?.remoteDescription) {
        await call.peerConnection.addIceCandidate(signal.payload.candidate);
      } else {
        call.pendingRemoteIce.push(signal.payload.candidate);
      }
    } else if (signal.type === 'answer' && call.status === 'outgoing') {
      await call.peerConnection.setRemoteDescription(signal.payload.description);
      call.status = 'connecting';
      call.statusText = 'Conectando…';
      updateCallStatus(call.statusText);
      await flushRemoteIce(call);
    } else if (signal.type === 'hangup' || signal.type === 'decline' || signal.type === 'busy') {
      const message = signal.type === 'busy'
        ? 'A pessoa está em outra chamada.'
        : signal.type === 'decline' ? 'A chamada foi recusada.' : 'A chamada foi encerrada.';
      await finishCall();
      showToast(message);
    }
  }

  async function pollCallSignals() {
    if (!state.user || state.pollingCalls) return;
    state.pollingCalls = true;
    try {
      const { signals } = await api('/api/calls/inbox');
      for (const signal of signals) {
        try {
          await processCallSignal(signal);
        } catch (error) {
          showToast(`Erro na chamada: ${error.message}`);
        }
      }
    } catch (error) {
      if (error.status !== 401) console.error('Falha ao receber sinalização de chamadas:', error);
    } finally {
      state.pollingCalls = false;
    }
  }

  function renderMessageList(shouldScroll) {
    const messages = main.querySelector('.messages');
    if (!messages) return;
    const wasNearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
    const renderedCount = Number(messages.dataset.renderedCount || 0);
    if (renderedCount === 0) {
      const day = document.createElement('div');
      day.className = 'day';
      day.textContent = state.messages.length ? 'HISTÓRICO DA CONVERSA' : 'Esta conversa começa aqui';
      messages.replaceChildren(day);
    }
    state.messages.slice(renderedCount).forEach((message, index) => {
      const mine = message.username.toLowerCase() === state.user.username.toLowerCase();
      const row = document.createElement('article');
      row.className = `message${mine ? ' mine' : ''}${renderedCount + index > 0 ? ' message-new' : ''}`;
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      setAvatar(
        avatar,
        mine ? state.user.avatarData : '',
        message.displayName,
        message.avatarUrl,
      );
      const box = document.createElement('div');
      box.className = 'bubblebox';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const author = document.createElement('strong');
      author.textContent = mine ? state.user.displayName : message.displayName;
      const stamp = document.createElement('span');
      stamp.textContent = formatTime(message.time);
      meta.append(author, stamp);
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      if (message.type === 'image' && message.imageData) {
        const image = document.createElement('img');
        image.src = message.imageData;
        image.alt = message.text || 'Imagem recebida';
        image.loading = 'lazy';
        image.onclick = () => showImagePreview(message.imageData);
        bubble.append(image);
        if (message.text) {
          const caption = document.createElement('div');
          caption.textContent = message.text;
          bubble.append(caption);
        }
      } else if (message.type === 'emoji' && message.emojiData) {
        const image = document.createElement('img');
        image.className = 'custom-emoji';
        image.src = message.emojiData;
        image.alt = `:${message.emojiName}:`;
        image.title = `:${message.emojiName}:`;
        bubble.append(image);
      } else {
        bubble.textContent = message.text;
      }
      box.append(meta, bubble);
      row.append(avatar, box);
      messages.append(row);
    });
    messages.dataset.renderedCount = String(state.messages.length);
    messages.querySelectorAll('.message img').forEach(image => {
      image.onload = () => {
        if (messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120) {
          messages.scrollTop = messages.scrollHeight;
        }
      };
    });
    if (shouldScroll || wasNearBottom) messages.scrollTop = messages.scrollHeight;
  }

  function renderChat() {
    const conversation = selectedConversation();
    if (!conversation) {
      delete main.dataset.conversationId;
      main.innerHTML = '<section class="empty"><div class="emptybox"><div class="empty-icon">✦</div><h2>Converse do seu jeito</h2><p>Adicione contatos pelo username, crie grupos e mantenha tudo em um só lugar.</p><button class="primary" id="start">＋ Adicionar contato</button></div></section>';
      document.getElementById('start').onclick = addContact;
      return;
    }

    main.dataset.conversationId = conversation.id;
    main.replaceChildren();
    const header = document.createElement('header');
    header.className = 'topbar';
    const back = document.createElement('button');
    back.className = 'actions back';
    back.textContent = '‹';
    back.title = 'Voltar';
    back.onclick = () => app.classList.remove('chat-open');
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    setAvatar(avatar, '', conversation.name, conversation.avatarUrl);
    const copy = document.createElement('div');
    copy.className = 'topcopy';
    const title = document.createElement('div');
    title.className = 'topname';
    title.textContent = conversation.name;
    const status = document.createElement('div');
    status.className = 'status';
    status.textContent = conversation.isGroup
      ? `Grupo · ${conversation.members} participantes`
      : `@${conversation.username}`;
    copy.append(title, status);
    const actions = document.createElement('div');
    actions.className = 'actions';
    [['☎', 'Chamada de voz'], ['▣', 'Chamada de vídeo']].forEach(([symbol, label], index) => {
      const button = document.createElement('button');
      button.textContent = symbol;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.disabled = conversation.isGroup;
      button.onclick = () => startCall(conversation, index === 1);
      actions.append(button);
    });
    header.append(back, avatar, copy, actions);
    main.append(header);

    const messages = document.createElement('section');
    messages.className = 'messages';
    messages.setAttribute('aria-label', 'Mensagens');
    main.append(messages);
    renderMessageList(true);

    const area = document.createElement('div');
    area.className = 'composer-area';
    const form = document.createElement('form');
    form.className = 'composer';
    const emoji = document.createElement('button');
    emoji.type = 'button';
    emoji.textContent = '☺';
    emoji.title = 'Inserir emoji';
    emoji.className = 'emoji-toggle';
    emoji.setAttribute('aria-label', 'Abrir emojis');
    const emojiPicker = document.createElement('div');
    emojiPicker.className = 'emoji-picker';
    emojiPicker.hidden = true;
    const emojiOptions = [
      '😀', '😃', '😄', '😁', '😆', '🥹', '😂', '🤣',
      '😊', '😍', '🥰', '😘', '😎', '🤔', '🙃', '😉',
      '😭', '😡', '🥳', '😴', '🤗', '🤩', '😅', '😇',
      '👍', '👎', '👏', '🙌', '🤝', '🙏', '💪', '🫶',
      '❤️', '🧡', '💛', '💚', '💙', '💜', '💖', '💔',
      '🔥', '✨', '🎉', '🎂', '🌹', '☕', '⭐', '💯',
    ];
    const input = document.createElement('input');
    input.name = 'text';
    input.placeholder = 'Escreva uma mensagem...';
    input.maxLength = 2000;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Escreva uma mensagem');
    emojiOptions.forEach(symbol => {
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = symbol;
      option.title = `Inserir ${symbol}`;
      option.onclick = () => {
        const start = input.selectionStart;
        const end = input.selectionEnd;
        input.setRangeText(symbol, start, end, 'end');
        input.focus();
      };
      emojiPicker.append(option);
    });
    function renderCustomEmojiOptions() {
      emojiPicker.querySelectorAll('.custom-emoji-option, .add-custom-emoji')
        .forEach(option => option.remove());
      state.emojis.forEach(customEmoji => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'custom-emoji-option';
        option.title = `:${customEmoji.name}:`;
        option.setAttribute('aria-label', `Enviar emoji :${customEmoji.name}:`);
        const image = document.createElement('img');
        image.src = customEmoji.imageData;
        image.alt = '';
        option.append(image);
        option.onclick = async () => {
          emojiPicker.hidden = true;
          try {
            await sendMessage(conversation.id, { type: 'emoji', emojiName: customEmoji.name });
          } catch (error) {
            showToast(error.message);
          }
        };
        emojiPicker.append(option);
      });
      const addEmoji = document.createElement('button');
      addEmoji.type = 'button';
      addEmoji.className = 'add-custom-emoji';
      addEmoji.textContent = '＋';
      addEmoji.title = 'Criar emoji personalizado';
      addEmoji.setAttribute('aria-label', addEmoji.title);
      addEmoji.onclick = () => addCustomEmoji();
      emojiPicker.append(addEmoji);
    }
    renderCustomEmojiOptions();
    const closePicker = event => {
      if (!emojiPicker.contains(event.target) && event.target !== emoji) {
        emojiPicker.hidden = true;
        document.removeEventListener('pointerdown', closePicker);
      }
    };
    emoji.onclick = async () => {
      if (emojiPicker.hidden) {
        try {
          const result = await api('/api/emojis');
          state.emojis = result.emojis;
          renderCustomEmojiOptions();
        } catch (error) {
          showToast(error.message);
        }
      }
      emojiPicker.hidden = !emojiPicker.hidden;
      document.removeEventListener('pointerdown', closePicker);
      if (!emojiPicker.hidden) document.addEventListener('pointerdown', closePicker);
    };
    const attach = document.createElement('label');
    attach.className = 'attach';
    attach.title = 'Enviar imagem';
    attach.setAttribute('aria-label', 'Enviar imagem');
    attach.textContent = '＋';
    const imageInput = document.createElement('input');
    imageInput.type = 'file';
    imageInput.accept = 'image/jpeg,image/png,image/webp,image/gif';
    imageInput.setAttribute('aria-label', 'Selecionar imagem');
    attach.append(imageInput);
    imageInput.onchange = async () => {
      const file = imageInput.files?.[0];
      imageInput.value = '';
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) {
        showToast('A imagem deve ter no máximo 4 MB.');
        return;
      }
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
        showToast('Escolha uma imagem JPEG, PNG, WebP ou GIF.');
        return;
      }
      try {
        const imageData = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Não foi possível ler essa imagem.'));
          reader.readAsDataURL(file);
        });
        await sendMessage(conversation.id, { type: 'image', imageData, text: '' });
      } catch (error) {
        showToast(error.message);
      }
    };
    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'send';
    send.textContent = '➤';
    send.title = 'Enviar mensagem';
    form.append(emojiPicker, emoji, attach, input, send);
    form.onsubmit = async event => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      try {
        await sendMessage(conversation.id, { text });
        input.value = '';
        input.focus();
      } catch (error) {
        showToast(error.message);
      } finally {
        send.disabled = false;
      }
    };
    area.append(form);
    main.append(area);
  }

  function render() {
    const name = state.user?.displayName || 'Visitante';
    document.getElementById('profileName').textContent = name;
    setAvatar(document.getElementById('profileAvatar'), state.user?.avatarData, name);
    setAvatar(document.getElementById('myAvatar'), state.user?.avatarData, name);
    renderList();
    renderChat();
  }

  async function refreshData() {
    const { conversations } = await api('/api/conversations');
    state.conversations = conversations;
    if (state.selectedId && !conversations.some(item => item.id === state.selectedId)) {
      state.selectedId = '';
      state.messages = [];
    }
    renderList();
    if (state.selectedId) {
      if (main.dataset.conversationId !== state.selectedId) renderChat();
      const after = state.messages.at(-1)?.id;
      const suffix = after ? `?after=${encodeURIComponent(after)}` : '';
      const { messages } = await api(`/api/conversations/${state.selectedId}/messages${suffix}`);
      if (messages.length) {
        state.messages.push(...messages);
        renderMessageList(false);
      } else if (!after && !state.messages.length) {
        renderMessageList(false);
      }
    } else {
      renderChat();
    }
  }

  async function selectConversation(id) {
    state.selectedId = id;
    state.messages = [];
    render();
    app.classList.add('chat-open');
    try {
      const { messages } = await api(`/api/conversations/${id}/messages`);
      if (state.selectedId !== id) return;
      state.messages = messages;
      renderMessageList(true);
    } catch (error) {
      showToast(error.message);
    }
  }

  function showModal(titleText, descriptionText, fields, submitText, onSubmit) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modalback';
    const form = document.createElement('form');
    form.className = 'modal';
    const title = document.createElement('h2');
    title.textContent = titleText;
    const description = document.createElement('p');
    description.textContent = descriptionText;
    form.append(title, description);
    fields.forEach(field => {
      const input = makeField(form, field);
      input.maxLength = field.maxLength || 60;
      if (field.hint) {
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = field.hint;
        form.append(hint);
      }
      if (field.focus) input.focus();
    });
    const error = document.createElement('div');
    error.className = 'hint';
    error.setAttribute('role', 'alert');
    error.style.color = '#ff929e';
    form.append(error);
    const footer = document.createElement('div');
    footer.className = 'modalfoot';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.textContent = 'Cancelar';
    cancel.onclick = () => backdrop.remove();
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary';
    submit.textContent = submitText;
    footer.append(cancel, submit);
    form.append(footer);
    form.onsubmit = async event => {
      event.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      try {
        await onSubmit(Object.fromEntries(new FormData(form)));
        backdrop.remove();
      } catch (requestError) {
        error.textContent = requestError.message;
      } finally {
        submit.disabled = false;
      }
    };
    backdrop.onclick = event => {
      if (event.target === backdrop) backdrop.remove();
    };
    backdrop.append(form);
    overlay.replaceChildren(backdrop);
  }

  function addContact() {
    showModal(
      'Adicionar contato',
      'Encontre alguém pelo username.',
      [{
        label: 'Username',
        name: 'username',
        placeholder: 'ex.: maria_oliveira',
        required: true,
        maxLength: 20,
        focus: true,
      }],
      'Adicionar',
      async values => {
        const { conversation } = await api('/api/conversations', {
          method: 'POST',
          body: JSON.stringify({ username: values.username }),
        });
        state.selectedId = conversation.id;
        state.messages = [];
        await refreshData();
        app.classList.add('chat-open');
      },
    );
  }

  function makeGroup() {
    showModal(
      'Criar grupo',
      'Informe o nome do grupo e os usernames dos participantes.',
      [
        {
          label: 'Nome do grupo',
          name: 'name',
          placeholder: 'ex.: Amigos do bairro',
          required: true,
          maxLength: 40,
          focus: true,
        },
        {
          label: 'Participantes',
          name: 'usernames',
          placeholder: 'ana_silva, joao123',
          required: true,
          hint: 'Separe os usernames por vírgula. Você será adicionado automaticamente.',
        },
      ],
      'Criar grupo',
      async values => {
        const usernames = values.usernames.split(',').map(value => value.trim()).filter(Boolean);
        const { conversation } = await api('/api/groups', {
          method: 'POST',
          body: JSON.stringify({ name: values.name, usernames }),
        });
        state.selectedId = conversation.id;
        state.messages = [];
        await refreshData();
        app.classList.add('chat-open');
      },
    );
  }

  async function startApp() {
    const [config, customEmojis] = await Promise.all([
      api('/api/config'),
      api('/api/emojis'),
    ]);
    state.iceServers = config.iceServers;
    state.emojis = customEmojis.emojis;
    render();
    await refreshData();
    clearInterval(state.pollingTimer);
    state.pollingTimer = setInterval(async () => {
      if (state.polling) return;
      state.polling = true;
      try {
        await refreshData();
      } catch (error) {
        if (error.status === 401) {
          clearInterval(state.pollingTimer);
          state.user = null;
          showAuth('login');
        } else {
          showToast(error.message);
        }
      } finally {
        state.polling = false;
      }
    }, 2500);
    clearInterval(state.callPollingTimer);
    state.callPollingTimer = setInterval(pollCallSignals, 900);
  }

  document.getElementById('add').onclick = addContact;
  document.getElementById('add2').onclick = addContact;
  document.getElementById('groups').onclick = makeGroup;
  document.getElementById('settings').onclick = updateProfile;
  document.getElementById('search').oninput = renderList;

  if (pagesNeedsApi) {
    showAuth('register');
    return;
  }

  api('/api/me')
    .then(async ({ user }) => {
      state.user = user;
      await startApp();
    })
    .catch(error => {
      if (error.status === 401) {
        showAuth('register');
      } else {
        showToast(error.message);
        showAuth('register');
      }
    });
})();
