'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let token       = localStorage.getItem('flux_token') || null;
let currentUser = JSON.parse(localStorage.getItem('flux_user') || 'null');
let ws          = null;
let wsReconnectTimer = null;

let currentChatId    = null;
let chats            = [];          // [{id, name, type, members, unread_count, last_message, …}]
let messagesByChatId = {};          // {chatId: [Message]}
let paginationState  = {};          // {chatId: {hasMore, nextCursor}}
let typingTimers     = {};          // {chatId+userId: timer}
let onlineUsers      = new Set();   // Set<userId>
let selectedGroupMembers = [];      // [{id, username, display_name}]

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const authScreen    = $('auth-screen');
const appScreen     = $('app-screen');
const chatList      = $('chat-list');
const messagesList  = $('messages-list');
const messagesArea  = $('messages-area');
const messageInput  = $('message-input');
const typingIndicator = $('typing-indicator');
const typingText    = $('typing-text');
const emptyState    = $('empty-state');
const chatView      = $('chat-view');
const loadMoreWrap  = $('load-more-btn-wrap');
const loadMoreBtn   = $('load-more-btn');

// ── Utils: UUID + Toast ────────────────────────────────────────────────────
function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for plain-HTTP / older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function showToast(message, type = 'error') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = message;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4000);
}

// ── API helper ─────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(`/api/v1${path}`, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data;
}

// ── Auth ───────────────────────────────────────────────────────────────────
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  $('login-error').textContent = '';
  try {
    const data = await api('POST', '/auth/login', { username, password });
    onLogin(data);
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username     = $('reg-username').value.trim();
  const display_name = $('reg-displayname').value.trim();
  const password     = $('reg-password').value;
  $('reg-error').textContent = '';
  try {
    const data = await api('POST', '/auth/register', { username, display_name, password });
    onLogin(data);
  } catch (err) {
    $('reg-error').textContent = err.message;
  }
});

function onLogin(data) {
  token       = data.token;
  currentUser = data.user;
  localStorage.setItem('flux_token', token);
  localStorage.setItem('flux_user', JSON.stringify(currentUser));
  showApp();
}

$('logout-btn').addEventListener('click', async () => {
  try { await api('POST', '/auth/logout', { refresh_token: '' }); } catch (_) {}
  localStorage.removeItem('flux_token');
  localStorage.removeItem('flux_user');
  token       = null;
  currentUser = null;
  if (ws) ws.close();
  location.reload();
});

// ── Tab switching ──────────────────────────────────────────────────────────
document.querySelectorAll('.auth-tabs .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.auth-tabs .tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $('login-form').classList.toggle('hidden', tab !== 'login');
    $('register-form').classList.toggle('hidden', tab !== 'register');
  });
});

document.querySelectorAll('.modal-tabs .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.modal-tabs .tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.modalTab;
    $('direct-tab').classList.toggle('hidden', tab !== 'direct');
    $('group-tab').classList.toggle('hidden', tab !== 'group');
  });
});

// ── App init ───────────────────────────────────────────────────────────────
async function showApp() {
  authScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');

  // Render own avatar/name
  $('my-name').textContent = currentUser.display_name;
  renderAvatar($('my-avatar'), currentUser);

  await loadChats();
  connectWS();
}

// ── Chat list ──────────────────────────────────────────────────────────────
async function loadChats() {
  const data = await api('GET', '/chats');
  chats = data.chats;
  renderChatList();
}

function renderChatList(filter = '') {
  const lc = filter.toLowerCase();
  const filtered = filter
    ? chats.filter((c) => chatDisplayName(c).toLowerCase().includes(lc))
    : chats;

  chatList.innerHTML = '';
  if (!filtered.length) {
    chatList.innerHTML = '<p style="color:var(--text-dim);text-align:center;padding:24px 16px;font-size:13px">Keine Chats gefunden</p>';
    return;
  }

  for (const chat of filtered) {
    const el = buildChatItem(chat);
    chatList.appendChild(el);
  }
}

function buildChatItem(chat) {
  const el = document.createElement('div');
  el.className = 'chat-item' + (chat.id === currentChatId ? ' active' : '');
  el.dataset.chatId = chat.id;

  const name = chatDisplayName(chat);
  const preview = chatPreview(chat);
  const time = chat.last_message ? fmtTime(chat.last_message.created_at) : '';
  const unread = chat.unread_count || 0;

  // Online dot for direct chats
  const otherMember = chat.type === 'direct'
    ? chat.members?.find((m) => m.id !== currentUser.id)
    : null;
  const isOnline = otherMember && onlineUsers.has(otherMember.id);

  el.innerHTML = `
    <div class="chat-item-avatar">
      <div class="chat-avatar" data-name="${esc(name)}"></div>
      ${isOnline ? '<div class="online-dot"></div>' : ''}
    </div>
    <div class="chat-item-info">
      <div class="chat-item-top">
        <span class="chat-item-name">${esc(name)}</span>
        <span class="chat-item-time">${esc(time)}</span>
      </div>
      <div class="chat-item-bottom">
        <span class="chat-item-preview">${esc(preview)}</span>
        ${unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
      </div>
    </div>`;

  renderAvatar(el.querySelector('.chat-avatar'), { display_name: name, avatar_url: chat.avatar_url || otherMember?.avatar_url });

  el.addEventListener('click', () => openChat(chat.id));
  return el;
}

$('chat-search').addEventListener('input', (e) => renderChatList(e.target.value));

// ── Open chat ──────────────────────────────────────────────────────────────
async function openChat(chatId) {
  currentChatId = chatId;
  const chat = chats.find((c) => c.id === chatId);

  // Sidebar highlight
  document.querySelectorAll('.chat-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.chatId === chatId);
  });

  // Show chat view
  emptyState.classList.add('hidden');
  chatView.classList.remove('hidden');

  // Header
  const name = chatDisplayName(chat);
  $('chat-header-name').textContent = name;
  renderAvatar($('chat-avatar'), { display_name: name, avatar_url: chat.avatar_url });
  updateChatSub(chat);

  // Load messages if not cached
  if (!messagesByChatId[chatId]) {
    await fetchMessages(chatId);
  } else {
    renderMessages(chatId);
    scrollToBottom();
  }

  // Mark as read
  const msgs = messagesByChatId[chatId];
  if (msgs && msgs.length) {
    markRead(chatId, msgs[msgs.length - 1].id);
  }

  // Mobile back button
  $('back-btn').classList.toggle('hidden', window.innerWidth > 640);
}

function updateChatSub(chat) {
  const otherMember = chat.type === 'direct'
    ? chat.members?.find((m) => m.id !== currentUser.id)
    : null;
  const sub = chat.type === 'group'
    ? `${chat.member_count} Mitglieder`
    : otherMember && onlineUsers.has(otherMember.id) ? 'Online' : '';
  $('chat-header-sub').textContent = sub;
}

// ── Messages ───────────────────────────────────────────────────────────────
async function fetchMessages(chatId, before = null) {
  const qs = before ? `?limit=50&before=${before}` : '?limit=50';
  const data = await api('GET', `/chats/${chatId}/messages${qs}`);

  if (!messagesByChatId[chatId]) messagesByChatId[chatId] = [];

  if (before) {
    messagesByChatId[chatId] = [...data.messages, ...messagesByChatId[chatId]];
  } else {
    messagesByChatId[chatId] = data.messages;
  }

  paginationState[chatId] = { hasMore: data.has_more, nextCursor: data.next_cursor };
  renderMessages(chatId);

  if (!before) scrollToBottom();
  else {
    // Restore scroll pos after prepend
    const firstEl = messagesList.firstElementChild;
    if (firstEl) firstEl.scrollIntoView();
  }

  loadMoreWrap.classList.toggle('hidden', !data.has_more);
}

loadMoreBtn.addEventListener('click', async () => {
  if (!currentChatId) return;
  const state = paginationState[currentChatId];
  if (state?.hasMore && state.nextCursor) {
    await fetchMessages(currentChatId, state.nextCursor);
  }
});

function renderMessages(chatId) {
  const msgs = messagesByChatId[chatId] || [];
  messagesList.innerHTML = '';

  let lastDate = null;
  let lastSenderId = null;
  let currentGroup = null;

  for (const msg of msgs) {
    const dateStr = fmtDate(msg.created_at);
    if (dateStr !== lastDate) {
      const sep = document.createElement('div');
      sep.className = 'date-separator';
      sep.innerHTML = `<span>${dateStr}</span>`;
      messagesList.appendChild(sep);
      lastDate = dateStr;
      lastSenderId = null;
      currentGroup = null;
    }

    const isMine = msg.sender_id === currentUser.id;

    if (msg.sender_id !== lastSenderId) {
      currentGroup = document.createElement('div');
      currentGroup.className = `message-group ${isMine ? 'mine' : 'theirs'}`;

      if (!isMine) {
        const senderName = document.createElement('div');
        senderName.className = 'message-sender-name';
        senderName.textContent = msg.sender?.display_name || '';
        currentGroup.appendChild(senderName);
      }

      messagesList.appendChild(currentGroup);
      lastSenderId = msg.sender_id;
    }

    currentGroup.appendChild(buildBubble(msg, isMine));
  }
}

function buildBubble(msg, isMine) {
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.dataset.msgId = msg.id;

  let content = '';

  // Reply preview
  if (msg.reply_to) {
    content += `<div class="reply-preview">${esc(msg.reply_to.sender?.display_name || '')}: ${esc(msg.reply_to.content)}</div>`;
  }

  // Content by type
  if (msg.type === 'image') {
    content += `<img src="${esc(msg.media_url || msg.content)}" alt="Bild" loading="lazy" />`;
  } else if (msg.type === 'voice') {
    content += `<audio controls src="${esc(msg.media_url || msg.content)}"></audio>`;
  } else {
    content += `<span>${escNl(msg.content)}</span>`;
  }

  // Meta
  const tick = isMine
    ? (msg.status === 'read' ? `<span class="read-tick">✓✓</span>` : `<span>✓</span>`)
    : '';
  content += `<div class="bubble-meta">${fmtTimeShort(msg.created_at)} ${tick}</div>`;

  bubble.innerHTML = content;
  return bubble;
}

// ── Send message ───────────────────────────────────────────────────────────
let typingSendTimer = null;

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

messageInput.addEventListener('input', () => {
  // Auto-resize
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';

  // Typing events
  if (!currentChatId || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'typing.start', chat_id: currentChatId }));
  clearTimeout(typingSendTimer);
  typingSendTimer = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'typing.stop', chat_id: currentChatId }));
  }, 2000);
});

$('send-btn').addEventListener('click', sendMessage);

async function sendMessage() {
  if (!currentChatId) return;
  const content = messageInput.value.trim();
  if (!content) return;

  const clientId = generateUUID();
  messageInput.value = '';
  messageInput.style.height = 'auto';

  // Optimistic message
  const optimistic = {
    id: clientId,
    chat_id: currentChatId,
    sender_id: currentUser.id,
    sender: currentUser,
    content,
    type: 'text',
    status: 'sent',
    media_url: null,
    duration_ms: null,
    reply_to_id: null,
    reply_to: null,
    reactions: [],
    created_at: new Date().toISOString(),
    client_id: clientId,
    _optimistic: true,
  };

  addMessage(currentChatId, optimistic);

  try {
    await api('POST', `/chats/${currentChatId}/messages`, {
      content,
      type: 'text',
      client_id: clientId,
    });
    // Server will broadcast message.new via WS; we'll replace optimistic then
  } catch (err) {
    // Remove optimistic on error
    removeOptimistic(currentChatId, clientId);
    showToast('Nachricht konnte nicht gesendet werden: ' + err.message);
  }
}

// ── File upload ────────────────────────────────────────────────────────────
$('attach-btn').addEventListener('click', () => $('file-input').click());

$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !currentChatId) return;
  e.target.value = '';

  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/v1/media', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'Upload fehlgeschlagen');

    const type = file.type.startsWith('image/') ? 'image' : 'voice';
    await api('POST', `/chats/${currentChatId}/messages`, {
      content: data.url,
      type,
      client_id: crypto.randomUUID(),
    });
  } catch (err) {
    showToast('Datei-Upload fehlgeschlagen: ' + err.message);
  }
});

// ── Mark read ──────────────────────────────────────────────────────────────
async function markRead(chatId, messageId) {
  try {
    await api('POST', `/chats/${chatId}/messages/read`, { message_id: messageId });
    // Reset unread locally
    const chat = chats.find((c) => c.id === chatId);
    if (chat) { chat.unread_count = 0; renderChatList($('chat-search').value); }
  } catch (_) {}
}

// ── Delete chat ────────────────────────────────────────────────────────────
$('delete-chat-btn').addEventListener('click', () => {
  if (!currentChatId) return;
  const chat = chats.find((c) => c.id === currentChatId);
  const name = chatDisplayName(chat);
  showConfirm(
    'Chat löschen',
    `"${name}" wirklich löschen? Alle Nachrichten werden entfernt.`,
    async () => {
      await api('DELETE', `/chats/${currentChatId}`);
      removeChatFromUI(currentChatId);
    },
  );
});

// ── WebSocket ──────────────────────────────────────────────────────────────
function connectWS() {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws?token=${token}`);

  ws.addEventListener('open', () => {
    console.log('[WS] connected');
  });

  ws.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleWSMessage(msg);
    } catch (_) {}
  });

  ws.addEventListener('close', () => {
    console.log('[WS] closed — reconnecting in 3s');
    wsReconnectTimer = setTimeout(connectWS, 3000);
  });

  ws.addEventListener('error', () => ws.close());

  // Ping keepalive
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, 25000);
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'pong': break;
    case 'message.new':       onMsgNew(msg.payload); break;
    case 'message.delivered': onMsgDelivered(msg.payload); break;
    case 'message.read':      onMsgRead(msg.payload); break;
    case 'message.reaction':  onMsgReaction(msg.payload); break;
    case 'message.deleted':   onMsgDeleted(msg.payload); break;
    case 'typing.start':      onTypingStart(msg.payload); break;
    case 'typing.stop':       onTypingStop(msg.payload); break;
    case 'chat.created':      onChatCreated(msg.payload); break;
    case 'chat.deleted':      onChatDeleted(msg.payload); break;
    case 'chat.cleared':      onChatCleared(msg.payload); break;
    case 'member.added':      onMemberAdded(msg.payload); break;
    case 'member.removed':    onMemberRemoved(msg.payload); break;
    case 'user.online':       onUserOnline(msg.payload); break;
    case 'user.offline':      onUserOffline(msg.payload); break;
  }
}

// ── WS handlers ───────────────────────────────────────────────────────────
function onMsgNew(payload) {
  const { message } = payload;
  const chatId = message.chat_id;

  // Replace optimistic if client_id matches
  if (message.client_id && messagesByChatId[chatId]) {
    const idx = messagesByChatId[chatId].findIndex(
      (m) => m._optimistic && m.client_id === message.client_id,
    );
    if (idx !== -1) {
      messagesByChatId[chatId][idx] = message;
      if (chatId === currentChatId) {
        renderMessages(chatId);
        scrollToBottom();
      }
    } else {
      addMessage(chatId, message);
    }
  } else {
    addMessage(chatId, message);
  }

  // Update last_message in chat list
  const chat = chats.find((c) => c.id === chatId);
  if (chat) {
    chat.last_message = message;
    if (chatId !== currentChatId || document.hidden) {
      if (message.sender_id !== currentUser.id) chat.unread_count = (chat.unread_count || 0) + 1;
    }
    chats.sort((a, b) => {
      const at = a.last_message ? new Date(a.last_message.created_at) : new Date(a.created_at);
      const bt = b.last_message ? new Date(b.last_message.created_at) : new Date(b.created_at);
      return bt - at;
    });
    renderChatList($('chat-search').value);
  }

  // Auto mark read if chat is open
  if (chatId === currentChatId && message.sender_id !== currentUser.id) {
    markRead(chatId, message.id);
  }
}

function onMsgDelivered(payload) {
  // Update status on optimistic/sent messages
  if (!messagesByChatId[payload.chat_id]) return;
  const msg = messagesByChatId[payload.chat_id].find((m) => m.id === payload.message_id || m.client_id === payload.client_id);
  if (msg) {
    msg.status = 'delivered';
    if (payload.chat_id === currentChatId) renderMessages(payload.chat_id);
  }
}

function onMsgRead(payload) {
  const { chat_id, reader_id, up_to_message_id } = payload;
  if (reader_id === currentUser.id) return;

  // Mark messages as read up to up_to_message_id
  const msgs = messagesByChatId[chat_id];
  if (!msgs) return;
  let found = false;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!found) msgs[i].status = 'read';
    if (msgs[i].id === up_to_message_id) found = true;
    if (found && msgs[i].status === 'read') break;
  }
  if (chat_id === currentChatId) renderMessages(chat_id);
}

function onMsgReaction(payload) {
  const msgs = messagesByChatId[payload.chat_id];
  if (!msgs) return;
  const msg = msgs.find((m) => m.id === payload.message_id);
  if (msg) {
    msg.reactions = payload.reactions;
    if (payload.chat_id === currentChatId) renderMessages(payload.chat_id);
  }
}

function onMsgDeleted(payload) {
  const { chat_id, message_id } = payload;
  if (!messagesByChatId[chat_id]) return;
  messagesByChatId[chat_id] = messagesByChatId[chat_id].filter((m) => m.id !== message_id);
  if (chat_id === currentChatId) renderMessages(chat_id);
}

function onTypingStart(payload) {
  const { chat_id, user } = payload;
  if (chat_id !== currentChatId || !user) return;
  if (user.id === currentUser.id) return;

  typingText.textContent = `${user.display_name} schreibt…`;
  typingIndicator.classList.remove('hidden');

  const key = chat_id + user.id;
  clearTimeout(typingTimers[key]);
  typingTimers[key] = setTimeout(() => {
    typingIndicator.classList.add('hidden');
  }, 5000);
}

function onTypingStop(payload) {
  const { chat_id, user_id } = payload;
  if (chat_id !== currentChatId) return;
  const key = chat_id + user_id;
  clearTimeout(typingTimers[key]);
  typingIndicator.classList.add('hidden');
}

function onChatCreated(payload) {
  const { chat } = payload;
  if (!chats.find((c) => c.id === chat.id)) {
    chats.unshift(chat);
    renderChatList($('chat-search').value);
  }
}

function onChatDeleted(payload) {
  removeChatFromUI(payload.chat_id);
}

function onChatCleared(payload) {
  const { chat_id } = payload;
  messagesByChatId[chat_id] = [];
  const chat = chats.find((c) => c.id === chat_id);
  if (chat) { chat.last_message = null; chat.unread_count = 0; }
  if (chat_id === currentChatId) {
    renderMessages(chat_id);
    loadMoreWrap.classList.add('hidden');
  }
  renderChatList($('chat-search').value);
}

function onMemberAdded(payload) {
  const chat = chats.find((c) => c.id === payload.chat_id);
  if (chat) {
    if (!chat.members) chat.members = [];
    if (!chat.members.find((m) => m.id === payload.user.id)) {
      chat.members.push(payload.user);
      chat.member_count = (chat.member_count || 0) + 1;
    }
  }
}

function onMemberRemoved(payload) {
  const chat = chats.find((c) => c.id === payload.chat_id);
  if (chat?.members) {
    chat.members = chat.members.filter((m) => m.id !== payload.user_id);
    chat.member_count = Math.max(0, (chat.member_count || 1) - 1);
    // If the current user was removed, close the chat
    if (payload.user_id === currentUser.id) removeChatFromUI(payload.chat_id);
  }
}

function onUserOnline(payload) {
  onlineUsers.add(payload.user_id);
  refreshOnlineStatus(payload.user_id);
}

function onUserOffline(payload) {
  onlineUsers.delete(payload.user_id);
  refreshOnlineStatus(payload.user_id);
}

function refreshOnlineStatus(userId) {
  // Update online dot in chat list
  for (const chat of chats) {
    if (chat.type === 'direct') {
      const other = chat.members?.find((m) => m.id === userId);
      if (other) renderChatList($('chat-search').value);
    }
  }
  // Update chat header sub
  if (currentChatId) {
    const chat = chats.find((c) => c.id === currentChatId);
    if (chat) updateChatSub(chat);
  }
}

// ── Helper: add/remove messages ────────────────────────────────────────────
function addMessage(chatId, msg) {
  if (!messagesByChatId[chatId]) messagesByChatId[chatId] = [];
  messagesByChatId[chatId].push(msg);
  if (chatId === currentChatId) {
    renderMessages(chatId);
    scrollToBottom();
  }
}

function removeOptimistic(chatId, clientId) {
  if (!messagesByChatId[chatId]) return;
  messagesByChatId[chatId] = messagesByChatId[chatId].filter((m) => m.client_id !== clientId);
  if (chatId === currentChatId) renderMessages(chatId);
}

function removeChatFromUI(chatId) {
  chats = chats.filter((c) => c.id !== chatId);
  delete messagesByChatId[chatId];
  if (currentChatId === chatId) {
    currentChatId = null;
    chatView.classList.add('hidden');
    emptyState.classList.remove('hidden');
  }
  renderChatList($('chat-search').value);
}

// ── New chat modal ─────────────────────────────────────────────────────────
$('new-chat-btn').addEventListener('click', () => {
  $('new-chat-modal').classList.remove('hidden');
  $('user-search-input').value = '';
  $('user-search-results').innerHTML = '';
  $('group-name-input').value = '';
  $('group-member-search').value = '';
  $('group-search-results').innerHTML = '';
  selectedGroupMembers = [];
  renderSelectedMembers();
});
$('close-modal-btn').addEventListener('click', () => $('new-chat-modal').classList.add('hidden'));
$('new-chat-modal').addEventListener('click', (e) => {
  if (e.target === $('new-chat-modal')) $('new-chat-modal').classList.add('hidden');
});

// Direct chat search
let userSearchTimer = null;
$('user-search-input').addEventListener('input', (e) => {
  clearTimeout(userSearchTimer);
  const q = e.target.value.trim();
  if (!q) { $('user-search-results').innerHTML = ''; return; }
  userSearchTimer = setTimeout(() => searchUsers(q, 'user-search-results', onDirectChatUser), 300);
});

async function searchUsers(q, containerId, onSelect) {
  try {
    const data = await api('GET', `/users/search?q=${encodeURIComponent(q)}&limit=10`);
    const container = $(containerId);
    container.innerHTML = '';
    if (!data.users.length) {
      container.innerHTML = '<p style="color:var(--text-dim);font-size:13px;padding:8px">Keine Nutzer gefunden</p>';
      return;
    }
    for (const user of data.users) {
      if (user.id === currentUser.id) continue;
      const el = document.createElement('div');
      el.className = 'user-result-item';
      el.innerHTML = `
        <div class="user-avatar">${initials(user.display_name)}</div>
        <div>
          <span>${esc(user.display_name)}</span><br/>
          <small>@${esc(user.username)}</small>
        </div>`;
      el.addEventListener('click', () => onSelect(user));
      container.appendChild(el);
    }
  } catch (_) {}
}

async function onDirectChatUser(user) {
  $('new-chat-modal').classList.add('hidden');
  try {
    const data = await api('POST', '/chats/direct', { user_id: user.id });
    const existing = chats.find((c) => c.id === data.chat.id);
    if (!existing) {
      chats.unshift(data.chat);
      renderChatList($('chat-search').value);
    }
    openChat(data.chat.id);
  } catch (err) {
    alert(err.message);
  }
}

// Group chat
let groupSearchTimer = null;
$('group-member-search').addEventListener('input', (e) => {
  clearTimeout(groupSearchTimer);
  const q = e.target.value.trim();
  if (!q) { $('group-search-results').innerHTML = ''; return; }
  groupSearchTimer = setTimeout(() => searchUsers(q, 'group-search-results', toggleGroupMember), 300);
});

function toggleGroupMember(user) {
  const idx = selectedGroupMembers.findIndex((m) => m.id === user.id);
  if (idx === -1) selectedGroupMembers.push(user);
  else selectedGroupMembers.splice(idx, 1);
  renderSelectedMembers();
}

function renderSelectedMembers() {
  $('selected-members').innerHTML = '';
  for (const member of selectedGroupMembers) {
    const chip = document.createElement('div');
    chip.className = 'member-chip';
    chip.innerHTML = `<div class="user-avatar" style="width:24px;height:24px;font-size:11px">${initials(member.display_name)}</div>
      <span>${esc(member.display_name)}</span>
      <button data-id="${member.id}">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      selectedGroupMembers = selectedGroupMembers.filter((m) => m.id !== member.id);
      renderSelectedMembers();
    });
    $('selected-members').appendChild(chip);
  }
}

$('create-group-btn').addEventListener('click', async () => {
  const name = $('group-name-input').value.trim();
  if (!name) { showToast('Gruppenname eingeben', 'info'); return; }
  if (!selectedGroupMembers.length) { showToast('Mindestens ein Mitglied auswählen', 'info'); return; }

  try {
    const data = await api('POST', '/chats/group', {
      name,
      member_ids: selectedGroupMembers.map((m) => m.id),
    });
    $('new-chat-modal').classList.add('hidden');
    const existing = chats.find((c) => c.id === data.chat.id);
    if (!existing) {
      chats.unshift(data.chat);
      renderChatList($('chat-search').value);
    }
    openChat(data.chat.id);
  } catch (err) {
    alert(err.message);
  }
});

// ── Confirm modal ──────────────────────────────────────────────────────────
let confirmCallback = null;

function showConfirm(title, text, onOk) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent  = text;
  confirmCallback = onOk;
  $('confirm-modal').classList.remove('hidden');
}

$('confirm-cancel').addEventListener('click', () => $('confirm-modal').classList.add('hidden'));
$('confirm-ok').addEventListener('click', async () => {
  $('confirm-modal').classList.add('hidden');
  if (confirmCallback) {
    try { await confirmCallback(); } catch (err) { alert(err.message); }
    confirmCallback = null;
  }
});

// ── Back button (mobile) ───────────────────────────────────────────────────
$('back-btn').addEventListener('click', () => {
  chatView.classList.add('hidden');
  emptyState.classList.remove('hidden');
  currentChatId = null;
  document.querySelectorAll('.chat-item').forEach((el) => el.classList.remove('active'));
});

// ── Utils ──────────────────────────────────────────────────────────────────
function chatDisplayName(chat) {
  if (!chat) return '';
  if (chat.type === 'group') return chat.name || 'Gruppe';
  const other = chat.members?.find((m) => m.id !== currentUser?.id);
  return other?.display_name || chat.name || 'Chat';
}

function chatPreview(chat) {
  const m = chat.last_message;
  if (!m) return 'Noch keine Nachrichten';
  if (m.type === 'image') return '📷 Bild';
  if (m.type === 'voice') return '🎤 Sprachnachricht';
  return m.content || '';
}

function renderAvatar(el, entity) {
  if (!el) return;
  if (entity?.avatar_url) {
    el.innerHTML = `<img src="${esc(entity.avatar_url)}" alt="avatar" />`;
  } else {
    el.textContent = initials(entity?.display_name || entity?.name || '?');
  }
}

function initials(name) {
  if (!name) return '?';
  return name.split(' ').slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escNl(s) {
  return esc(s).replace(/\n/g, '<br>');
}

function fmtDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Heute';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Gestern';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Gestern';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

function fmtTimeShort(iso) {
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function scrollToBottom() {
  requestAnimationFrame(() => { messagesArea.scrollTop = messagesArea.scrollHeight; });
}

// ── Boot ───────────────────────────────────────────────────────────────────
if (token && currentUser) {
  showApp();
} else {
  authScreen.classList.remove('hidden');
}
