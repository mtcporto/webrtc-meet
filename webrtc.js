// Private relay credentials are issued for the current active room session.
const configuration = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };
let turnSession = null;
let turnRefreshTimer = null;
async function refreshTurnConfiguration() {
  if (!turnSession || hasDisconnected) return;
  const data = await signalingRequest(`${SIGNALING_SERVER}/ice`, {
    method: 'POST', headers: { Authorization: `Bearer ${turnSession}` },
  });
  configuration.iceServers = data.iceServers;
  for (const pc of Object.values(peerConnections)) {
    if (pc.signalingState !== 'closed') pc.setConfiguration({ ...pc.getConfiguration(), iceServers: data.iceServers });
  }
  clearTimeout(turnRefreshTimer);
  turnRefreshTimer = setTimeout(() => {
    refreshTurnConfiguration().catch(() => window.dispatchEvent(new CustomEvent('turn-unavailable')));
  }, Math.max(60000, data.expiresAt - Date.now() - 10 * 60 * 1000));
}

// Em produção a Vercel atua como proxy para evitar CORS/preflight e problemas
// de transporte entre navegadores móveis e o domínio workers.dev. Em ambiente
// local, onde a regra de rewrite não existe, acessamos o Worker diretamente.
const DIRECT_SIGNALING_SERVER = 'https://webrtc.mosaicoworkers.workers.dev';
const localDevelopmentHost = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i
  .test(window.location.hostname);
const SIGNALING_SERVER = localDevelopmentHost || window.location.protocol === 'file:'
  ? DIRECT_SIGNALING_SERVER
  : `${window.location.origin}/api/webrtc`;

// Variáveis globais
let peerConnections = {}; // Armazena conexões peer
let localStream;
let roomId;
let userId;
let participantId;
let previousConnectionId;
let connectionGeneration = 0;
let username;
let isPolling = false;
let hasDisconnected = false;
let lastPollTime = 0;
let lastSignalId = 0;
let usesSignalIdCursor = false;
const senderKinds = new WeakMap();
const signalQueues = new Map();
const activeSignalingControllers = new Set();
const SIGNALING_REQUEST_TIMEOUT_MS = 9000;
const JOIN_MAX_ATTEMPTS = 3;
let lastPublishedSignalingState = '';

// Variável para armazenar status de áudio e vídeo
let audioStatus = true;
let videoStatus = true;
let screenShareStatus = false;

// Canal de dados para transmitir status do microfone/câmera entre participantes
let dataChannels = {};

// Log personalizado
function log(message) {
  console.log(`[WebRTC ${new Date().toLocaleTimeString()}] ${message}`);
}

function publishSignalingState(state, detail = {}) {
  if (state === lastPublishedSignalingState && !detail.force) return;
  lastPublishedSignalingState = state;
  window.dispatchEvent(new CustomEvent('signaling-state', {
    detail: { state, ...detail }
  }));
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function signalingRequest(url, options = {}, timeoutMs = SIGNALING_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  activeSignalingControllers.add(controller);
  let requestTimedOut = false;
  const timeoutId = setTimeout(() => {
    requestTimedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let data;
    try {
      data = await response.json();
    } catch {
      const malformedResponseError = new Error('signaling_invalid_response');
      malformedResponseError.code = 'signaling_invalid_response';
      throw malformedResponseError;
    }

    if (response.ok === false) {
      const responseError = new Error(data?.error || `signaling_http_${response.status}`);
      responseError.code = data?.error || 'signaling_http_error';
      responseError.status = response.status;
      throw responseError;
    }

    return data;
  } catch (error) {
    if (requestTimedOut) {
      const timeoutError = new Error('signaling_timeout');
      timeoutError.name = 'TimeoutError';
      timeoutError.code = 'signaling_timeout';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    activeSignalingControllers.delete(controller);
  }
}

async function configureVideoSender(sender, track) {
  if (!sender || track?.kind !== 'video') return;

  const isDetailedContent = track.contentHint === 'detail' || track.contentHint === 'text';
  if (!track.contentHint) {
    track.contentHint = 'motion';
  }

  try {
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) return;

    parameters.encodings[0].maxBitrate = isDetailedContent ? 4_000_000 : 2_500_000;
    parameters.encodings[0].maxFramerate = 30;
    parameters.degradationPreference = isDetailedContent ? 'maintain-resolution' : 'balanced';
    await sender.setParameters(parameters);
  } catch (error) {
    console.warn('Não foi possível aplicar os parâmetros de qualidade do vídeo:', error);
  }
}

// Gera um ID aleatório
function generateRandomId() {
  return globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 11);
}

function createParticipantIdentity(room, preferredParticipantId = '', minimumGeneration = 0) {
  const idKey = `webrtc-participant-id:${room}`;
  const generationKey = `webrtc-participant-generation:${room}`;
  const connectionKey = `webrtc-participant-connection:${room}`;
  let stableParticipantId = preferredParticipantId || generateRandomId();
  const connectionId = generateRandomId();
  let previousConnection = null;
  let generation = 1;

  try {
    const navigationEntry = performance.getEntriesByType?.('navigation')?.[0];
    const isReload = navigationEntry
      ? navigationEntry.type === 'reload'
      : performance.navigation?.type === 1;
    const storedId = sessionStorage.getItem(idKey);

    if (preferredParticipantId || (isReload && storedId)) {
      stableParticipantId = preferredParticipantId || storedId;
      previousConnection = sessionStorage.getItem(connectionKey);
      sessionStorage.setItem(idKey, stableParticipantId);
    } else {
      sessionStorage.setItem(idKey, stableParticipantId);
      sessionStorage.setItem(generationKey, '0');
    }

    const previousGeneration = Number(sessionStorage.getItem(generationKey));
    generation = Number.isSafeInteger(previousGeneration) && previousGeneration >= 0
      ? previousGeneration + 1
      : 1;
    sessionStorage.setItem(generationKey, String(generation));
    sessionStorage.setItem(connectionKey, connectionId);
  } catch (error) {
    console.warn('Nao foi possivel persistir a identidade desta aba:', error);
  }

  // Mantém a ordem das gerações também quando o armazenamento do navegador
  // está indisponível (modo privado restritivo, quota ou política corporativa).
  if (preferredParticipantId && generation <= minimumGeneration) {
    generation = minimumGeneration + 1;
    try {
      sessionStorage.setItem(generationKey, String(generation));
    } catch {
      // A geração em memória ainda protege esta sessão.
    }
  }

  return {
    participantId: stableParticipantId,
    connectionId,
    previousConnectionId: previousConnection,
    generation
  };
}

// Função para conectar à sala WebRTC
export async function connectToRoom(room, stream, addRemoteVideo) {
  if (hasDisconnected) return false;

  const nextRoomId = normalizeRoomId(room);
  const stableIdentityForRetry = roomId === nextRoomId ? participantId : '';
  const previousUserIdForRetry = stableIdentityForRetry ? userId : '';
  roomId = nextRoomId;
  const identity = createParticipantIdentity(
    roomId,
    stableIdentityForRetry,
    stableIdentityForRetry ? connectionGeneration : 0
  );
  participantId = identity.participantId;
  userId = identity.connectionId;
  previousConnectionId = identity.previousConnectionId || previousUserIdForRetry;
  connectionGeneration = identity.generation;
  username = localStorage.getItem('userName') || 'Anônimo';
  localStream = stream;
  
  console.log(`Conectando à sala ${roomId} como ${username} (ID: ${userId})`);
  
  // As tentativas reutilizam a mesma identidade. O UPSERT de presença no
  // Worker continua idempotente mesmo se uma resposta se perder no caminho.
  for (let attempt = 1; attempt <= JOIN_MAX_ATTEMPTS; attempt += 1) {
    publishSignalingState(attempt === 1 ? 'connecting' : 'reconnecting', {
      attempt,
      force: true
    });

    try {
      const data = await signalingRequest(`${SIGNALING_SERVER}/join`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          room: roomId,
          id: userId,
          participantId,
          previousConnectionId,
          name: username,
          generation: connectionGeneration
        })
      });

      // Se a página saiu enquanto o join estava em voo, uma segunda saída após
      // a resposta garante que um join tardio não recrie presença fantasma.
      if (hasDisconnected) {
        notifyLeave();
        return false;
      }

      if (!data.success) {
        const joinError = new Error(data.error || 'signaling_join_failed');
        joinError.code = data.error || 'signaling_join_failed';
        throw joinError;
      }

      turnSession = data.turnSession;
      if (turnSession) {
        try { await refreshTurnConfiguration(); }
        catch { window.dispatchEvent(new CustomEvent('turn-unavailable')); }
      }
      console.log('Conectado ao servidor de sinalização');
      const initialSignalCursor = Number(data.signalCursor);
      usesSignalIdCursor = Number.isSafeInteger(initialSignalCursor) && initialSignalCursor >= 0;
      lastSignalId = usesSignalIdCursor ? initialSignalCursor : 0;
      publishParticipants(data.users);

      // Apenas um lado inicia a negociação, escolhido pela ordem dos IDs.
      const sortedUsers = [...data.users].sort((a, b) => a.id.localeCompare(b.id));
      sortedUsers.forEach(user => {
        if (user.id !== userId) {
          const shouldInitiate = userId < user.id;
          console.log(`Detectado usuário: ${user.name} (${user.id}), iniciando: ${shouldInitiate}`);
          createPeerConnection(user.id, user.name, shouldInitiate, addRemoteVideo);
        }
      });

      publishSignalingState('connected');
      startPolling(addRemoteVideo);
      return true;
    } catch (error) {
      if (hasDisconnected) return false;
      console.warn(`Tentativa ${attempt}/${JOIN_MAX_ATTEMPTS} de entrar na sala falhou:`, error);
      if (attempt < JOIN_MAX_ATTEMPTS) {
        publishSignalingState('reconnecting', { attempt: attempt + 1, force: true });
        await wait(attempt * 900);
      }
    }
  }

  // Se algum join expirado ainda chegar ao banco, o tombstone desta mesma
  // geração impede que ele volte como participante fantasma.
  notifyLeave();
  publishSignalingState('unavailable', { force: true });
  return false;
}

// Atualiza as tracks enviadas quando o usuário troca câmera ou microfone.
export async function replaceLocalStream(stream) {
  localStream = stream;
  const tracksByKind = new Map(stream.getTracks().map(track => [track.kind, track]));
  await Promise.all(Object.values(peerConnections).flatMap(pc =>
    pc.getSenders().map(async sender => {
      const kind = senderKinds.get(sender) || sender.track?.kind;
      const replacement = kind === 'audio' && !audioStatus ? null : tracksByKind.get(kind);
      await sender.replaceTrack(replacement || null);
      if (kind === 'video' && replacement) {
        await configureVideoSender(sender, replacement);
      }
    })
  ));
}

// Troca somente a fonte de vídeo, preservando o microfone e o transceiver.
// O MediaStream também é atualizado para que participantes que entrarem depois
// recebam a fonte atual (câmera ou apresentação).
export async function replaceLocalVideoTrack(track) {
  if (track && track.kind !== 'video') {
    throw new TypeError('A faixa substituta precisa ser de vídeo.');
  }
  if (!localStream) {
    throw new Error('O stream local ainda não foi inicializado.');
  }

  const previousVideoTracks = localStream.getVideoTracks();
  const previousTrack = previousVideoTracks[0] || null;
  previousVideoTracks.forEach(videoTrack => localStream.removeTrack(videoTrack));
  if (track) localStream.addTrack(track);

  const getCurrentVideoSenders = () => Object.values(peerConnections).flatMap(pc =>
    pc.getSenders().filter(sender => (senderKinds.get(sender) || sender.track?.kind) === 'video')
  );
  const videoSenders = getCurrentVideoSenders();

  try {
    await Promise.all(videoSenders.map(async sender => {
      await sender.replaceTrack(track || null);
      if (track) await configureVideoSender(sender, track);
    }));
  } catch (error) {
    if (track) localStream.removeTrack(track);
    previousVideoTracks.forEach(videoTrack => localStream.addTrack(videoTrack));
    // Um peer pode ter sido criado enquanto os replaces estavam em voo. Refazer
    // a consulta garante que o rollback tambem alcance esses senders novos.
    const rollbackVideoSenders = getCurrentVideoSenders();
    await Promise.allSettled(
      rollbackVideoSenders.map(sender => sender.replaceTrack(previousTrack))
    );
    throw error;
  }

  return previousTrack;
}

// Desconecta a track de áudio dos RTCRtpSenders ao mutar. Isso interrompe o
// envio de RTP imediatamente, em vez de depender só de track.enabled.
export async function setLocalAudioEnabled(enabled) {
  const previousAudioStatus = audioStatus;
  const audioTracks = localStream?.getAudioTracks() || [];
  const previousTrackStates = new Map(audioTracks.map(track => [track, track.enabled]));
  const audioTrack = audioTracks[0] || null;
  if (enabled && !audioTrack) {
    throw new Error('Nenhuma faixa de microfone está disponível.');
  }

  audioStatus = enabled;
  audioTracks.forEach(track => {
    track.enabled = enabled;
  });
  const getCurrentAudioSenders = () => Object.values(peerConnections).flatMap(pc =>
    pc.getSenders().filter(sender => (
      (senderKinds.get(sender) || sender.track?.kind) === 'audio'
    ))
  );

  try {
    await Promise.all(
      getCurrentAudioSenders().map(sender => sender.replaceTrack(enabled ? audioTrack : null))
    );
  } catch (error) {
    audioStatus = previousAudioStatus;
    previousTrackStates.forEach((trackWasEnabled, track) => {
      track.enabled = trackWasEnabled;
    });
    await Promise.allSettled(
      getCurrentAudioSenders().map(sender => (
        sender.replaceTrack(previousAudioStatus ? audioTrack : null)
      ))
    );
    throw error;
  }
}

function normalizeRoomId(room) {
  return String(room).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Função para iniciar polling melhorada
function startPolling(addRemoteVideo) {
  if (isPolling) return;
  
  console.log("Iniciando polling para atualizações");
  isPolling = true;
  lastPollTime = Date.now() - 30000; // Pegue os últimos 30 segundos de sinais para garantir
  let consecutivePollFailures = 0;
  
  async function poll() {
    if (!isPolling) return;
    
    try {
      const pollUrl = new URL(`${SIGNALING_SERVER}/poll`);
      const pollParams = new URLSearchParams({
        room: roomId,
        id: userId,
        participantId,
        previousConnectionId: previousConnectionId || '',
        name: username,
        generation: String(connectionGeneration),
        last: String(lastPollTime)
      });
      if (usesSignalIdCursor) {
        pollParams.set('lastId', String(lastSignalId));
      }
      pollUrl.search = pollParams;
      const data = await signalingRequest(pollUrl);

      if (!data.success) {
        const pollError = new Error(data.error || 'signaling_poll_failed');
        pollError.code = data.error || 'signaling_poll_failed';
        throw pollError;
      }
      
      if (data.success) {
        if (data.presenceProtocol === 2 && data.sessionActive === false) {
          isPolling = false;
          if (!hasDisconnected) window.location.reload();
          return;
        }
        console.log(`Poll: ${data.users.length} usuários, ${data.signals?.length || 0} sinais`);
        console.log("Usuários na sala:", data.users);
        publishParticipants(data.users);
        
        // Processar novos usuários
        data.users.forEach(user => {
          if (user.id !== userId && !peerConnections[user.id]) {
            console.log(`Novo usuário: ${user.name} (${user.id})`);
              const shouldInitiate = userId < user.id;
              createPeerConnection(user.id, user.name, shouldInitiate, addRemoteVideo);
          }
        });

        // A lista do servidor e a fonte de verdade da presenca. Remover peers
        // ausentes evita manter video/conexao fantasma apos reload ou saida.
        const activePeerIds = new Set(
          data.users.filter(user => user.id !== userId).map(user => user.id)
        );
        Object.entries(peerConnections).forEach(([peerId, pc]) => {
          if (!activePeerIds.has(peerId)) {
            log(`Peer ${peerId} nao esta mais na sala; removendo conexao local`);
            removePeerConnection(peerId, pc);
          }
        });
        
        // Processar sinais recebidos
        if (data.signals && data.signals.length > 0) {
          console.log("Sinais recebidos:", data.signals);
          for (const signal of data.signals) {
            await handleSignal(signal, addRemoteVideo);
            const processedSignalId = Number(signal.id);
            if (Number.isFinite(processedSignalId)) {
              lastSignalId = Math.max(lastSignalId, processedSignalId);
            }
          }
        }

        const serverTime = Number(data.serverTime);
        lastPollTime = Number.isFinite(serverTime) ? serverTime : Date.now();
        if (consecutivePollFailures > 0) publishSignalingState('connected');
        consecutivePollFailures = 0;
      }
    } catch (error) {
      if (!isPolling || hasDisconnected) return;
      consecutivePollFailures += 1;
      publishSignalingState('reconnecting');
      console.error("Erro durante polling:", error);
    }
    
    // Backoff limitado: recupera automaticamente sem martelar um backend que
    // esteja indisponível.
    const nextPollDelay = consecutivePollFailures > 0
      ? Math.min(2000 * (2 ** Math.min(consecutivePollFailures - 1, 2)), 10000)
      : 2000;
    setTimeout(poll, nextPollDelay);
  }
  
  // Iniciar o polling
  poll();
}

function publishParticipants(users) {
  window.dispatchEvent(new CustomEvent('room-participants', { detail: { users } }));
}

// Processa sinais recebidos
async function handleSignal(signal, addRemoteVideo) {
  const { type, sender, data: signalData } = signal;
  
  console.log(`Processando sinal ${type} de ${sender}`);
  
  if (!peerConnections[sender]) {
    console.log(`Criando nova conexão para ${sender} após receber sinal`);
    // Importante: se receber uma oferta, NÃO devemos iniciar nossa própria oferta
    const initiator = type !== 'offer';
    createPeerConnection(sender, null, initiator, addRemoteVideo);
  }
  
  const pc = peerConnections[sender];
  
  try {
    if (type === 'offer') {
      console.log(`Recebeu oferta, configurando conexão remota`);
      
      // Se já tiver uma oferta pendente, verificamos quem tem prioridade
      if (pc.signalingState === 'have-local-offer') {
        // Regra de desempate: ID menor alfabeticamente vence
        if (userId < sender) {
          console.log("Colisão de ofertas, ignorando a oferta remota (temos prioridade)");
          return; // Ignoramos a oferta recebida
        } else {
          console.log("Colisão de ofertas, rolando de volta nossa oferta");
          await pc.setLocalDescription({type: "rollback"});
        }
      }
      
      await pc.setRemoteDescription(new RTCSessionDescription(signalData));
      await addPendingIceCandidates(pc);
      
      console.log("Criando resposta");
      const answer = await pc.createAnswer();
      console.log(`Resposta criada, definindo descrição local`);
      console.log(`Enviando resposta para ${sender}`);
      await setLocalDescriptionAndSignal(pc, sender, 'answer', answer);
    } else if (type === 'answer') {
      if (pc.signalingState !== 'have-local-offer') {
        console.log(`Ignorando resposta obsoleta de ${sender} no estado ${pc.signalingState}`);
        return;
      }
      console.log(`Recebeu resposta, definindo descrição remota`);
      await pc.setRemoteDescription(new RTCSessionDescription(signalData));
        await addPendingIceCandidates(pc);
    } else if (type === 'candidate') {
      console.log(`Recebeu candidato ICE`);
      try {
        await pc.addIceCandidate(new RTCIceCandidate(signalData));
      } catch (e) {
        if (pc.remoteDescription) {
          console.error(`Erro ao adicionar candidato ICE: ${e.message}`);
        } else {
          console.log("Armazenando candidato ICE para mais tarde");
          if (!pc.pendingCandidates) pc.pendingCandidates = [];
          pc.pendingCandidates.push(signalData);
        }
      }
    }
  } catch (error) {
    console.error(`Erro ao processar sinal ${type}: ${error.message}`);

    // O remetente pode sair entre a leitura da oferta e o envio da resposta.
    // Esse sinal ficou obsoleto: consumi-lo impede que ele bloqueie o cursor e
    // todos os sinais posteriores ate expirar no servidor.
    if (error.message === 'participant_not_in_room') {
      removePeerConnection(sender, pc);
      return;
    }

    if (type === 'offer') {
      removePeerConnection(sender, pc);
    } else if (type === 'answer') {
      removePeerConnection(sender, pc);
      if (!hasDisconnected) {
        createPeerConnection(sender, null, true, addRemoteVideo);
      }
      return;
    }

    throw error;
  }
}

  async function addPendingIceCandidates(pc) {
    if (!pc.pendingCandidates) return;

    const pendingCandidates = pc.pendingCandidates;
    pc.pendingCandidates = [];

    for (const candidate of pendingCandidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.warn(`Candidato ICE pendente inválido ignorado: ${error.message}`);
      }
    }
  }

// Envia um sinal para outro peer
async function sendSignal(target, type, data) {
  const send = async () => {
    log(`Enviando sinal ${type} para ${target}`);
    const result = await signalingRequest(`${SIGNALING_SERVER}/signal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
          room: roomId,
        sender: userId,
        participantId,
        generation: connectionGeneration,
        target,
        type,
        data
      })
    });

    if (result.success) {
      log(`Sinal ${type} enviado com sucesso para ${target}`);
    } else {
      throw new Error(result.error || `Falha ao enviar sinal ${type}`);
    }
  };

  // Ofertas/respostas precisam chegar antes dos candidatos ICE. Sem esta fila,
  // requisições concorrentes podem ser persistidas fora de ordem e o polling
  // avança o cursor sem nunca entregar a descrição SDP atrasada.
  const previous = signalQueues.get(target) || Promise.resolve();
  const queued = previous.catch(() => {}).then(send);
  signalQueues.set(target, queued);

  try {
    await queued;
  } catch (error) {
    log(`Erro ao enviar sinal ${type} para ${target}: ${error.message}`);
    throw error;
  } finally {
    if (signalQueues.get(target) === queued) {
      signalQueues.delete(target);
    }
  }
}

async function setLocalDescriptionAndSignal(pc, peerId, type, description) {
  pc.localDescriptionSignaled = false;
  await pc.setLocalDescription(description);
  await sendSignal(peerId, type, pc.localDescription || description);
  pc.localDescriptionSignaled = true;

  const pendingCandidates = pc.pendingLocalCandidates.splice(0);
  for (const candidate of pendingCandidates) {
    await sendSignal(peerId, 'candidate', candidate);
  }
}

function configureStatusDataChannel(pc, dataChannel, peerId) {
  pc.dataChannel = dataChannel;

  dataChannel.onopen = () => {
    console.log(`Canal de dados aberto para ${peerId}`);
    dataChannel.send(JSON.stringify({
      type: 'media-status',
      audio: audioStatus,
      video: videoStatus,
      screenSharing: screenShareStatus
    }));
  };

  dataChannel.onmessage = event => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'media-status') {
        updateRemoteMediaUI(peerId, data.audio, data.video, Boolean(data.screenSharing));
      }
    } catch (error) {
      console.error('Erro ao processar mensagem de dados:', error);
    }
  };
}

function removePeerConnection(peerId, pc) {
  if (peerConnections[peerId] !== pc) return;

  clearTimeout(pc.disconnectCleanupTimer);
  clearTimeout(pc.iceRestartOfferTimer);
  clearTimeout(pc.offerRetryTimer);
  delete peerConnections[peerId];
  pc.close();

  const videoElement = document.getElementById(`video-${peerId}`);
  if (videoElement?.parentNode) {
    videoElement.parentNode.remove();
  }

  window.dispatchEvent(new CustomEvent('remote-peer-removed', { detail: { peerId } }));
}

// Cria uma conexão peer para um usuário específico
function createPeerConnection(peerId, peerName, initiator, addRemoteVideo) {
  console.log(`Criando conexão com peer ${peerId}${initiator ? ' (como iniciador)' : ''}`);
  
  // Criar nova RTCPeerConnection com iceTransportPolicy forceTurn para atravessar NAT
  const pc = new RTCPeerConnection({
    ...configuration,
    iceTransportPolicy: 'all' // tenta usar relay apenas se necesário
  });
  peerConnections[peerId] = pc;
  pc.localDescriptionSignaled = false;
  pc.pendingLocalCandidates = [];
  
  // Adicionar tracks locais à conexão
  if (localStream) {
    console.log(`Adicionando ${localStream.getTracks().length} tracks locais à conexão`);
    localStream.getTracks().forEach(track => {
      const sender = pc.addTrack(track, localStream);
      senderKinds.set(sender, track.kind);
      if (track.kind === 'video') {
        void configureVideoSender(sender, track);
      }
    });
  }
  
  // Lidar com candidatos ICE
  pc.onicecandidate = event => {
    if (event.candidate) {
      if (!pc.localDescriptionSignaled) {
        console.log(`Armazenando candidato ICE local para ${peerId} até enviar a descrição`);
        pc.pendingLocalCandidates.push(event.candidate);
      } else {
        console.log(`Enviando candidato ICE para ${peerId}: ${event.candidate.candidate.substr(0, 50)}...`);
        void sendSignal(peerId, 'candidate', event.candidate).catch(() => {});
      }
    } else {
      console.log(`Coleta de candidatos ICE para ${peerId} concluída`);
    }
  };
  
  // Adicionar canal de dados para comunicação não-mídia
  if (initiator) {
    configureStatusDataChannel(pc, pc.createDataChannel('status'), peerId);
  } else {
    pc.ondatachannel = event => configureStatusDataChannel(pc, event.channel, peerId);
  }
  
  // Lidar com estado da conexão ICE
  pc.oniceconnectionstatechange = () => {
    log(`Conexão ICE com ${peerId} mudou para ${pc.iceConnectionState}`);
    
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      clearTimeout(pc.disconnectCleanupTimer);
      clearTimeout(pc.iceRestartOfferTimer);
      log(`Conexão estabelecida com ${peerId}!`);
      return;
    }

    if (pc.iceConnectionState === 'failed') {
      clearTimeout(pc.disconnectCleanupTimer);
      clearTimeout(pc.iceRestartOfferTimer);
      log(`Conexão com ${peerId} falhou; reiniciando ICE`);
      pc.restartIce();

      // Ambos os lados recebem uma janela para recuperar. Se o peer remoto
      // realmente saiu, a conexao nao fica presa para sempre em `failed`.
      pc.disconnectCleanupTimer = setTimeout(() => {
        const recovered = pc.iceConnectionState === 'connected' ||
          pc.iceConnectionState === 'completed';
        if (peerConnections[peerId] === pc && !recovered) {
          log(`Conexao com ${peerId} nao se recuperou apos falha ICE`);
          removePeerConnection(peerId, pc);
        }
      }, 12000);

      if (initiator) {
        pc.iceRestartOfferTimer = setTimeout(() => {
          const recovered = pc.iceConnectionState === 'connected' ||
            pc.iceConnectionState === 'completed';
          if (peerConnections[peerId] === pc && !recovered && pc.signalingState === 'stable') {
            log(`Criando nova oferta para ${peerId} após reinício ICE`);
            void createAndSendOffer(pc, peerId);
          }
        }, 2000);
      }
      return;
    }

    if (pc.iceConnectionState === 'disconnected') {
      clearTimeout(pc.disconnectCleanupTimer);
      pc.disconnectCleanupTimer = setTimeout(() => {
        const recovered = pc.iceConnectionState === 'connected' ||
          pc.iceConnectionState === 'completed';
        if (peerConnections[peerId] === pc && !recovered) {
          log(`Conexão com ${peerId} permaneceu desconectada`);
          removePeerConnection(peerId, pc);
        }
      }, 8000);
      return;
    }

    if (pc.iceConnectionState === 'closed') {
      removePeerConnection(peerId, pc);
    }
  };
  
  // Lidar com conexão de dados (quando estabelecida)
  pc.onconnectionstatechange = () => {
    log(`Estado da conexão com ${peerId}: ${pc.connectionState}`);
    if (pc.connectionState === 'connected') {
      pc.getSenders().forEach(sender => {
        if ((senderKinds.get(sender) || sender.track?.kind) === 'video' && sender.track) {
          void configureVideoSender(sender, sender.track);
        }
      });
    }
  };
  
  // Lidar com streams remotos
  pc.ontrack = event => {
    console.log(`[WebRTC ${new Date().toLocaleTimeString()}] Recebeu track de ${peerId}`);
    if (!event.streams || !event.streams[0]) {
      console.log(`[WebRTC ${new Date().toLocaleTimeString()}] Recebeu track sem stream associado`);
      return;
    }
    
    const remoteStream = event.streams[0];
    console.log(`[WebRTC ${new Date().toLocaleTimeString()}] Processando stream remoto de ${peerId}`);
    
    // Chamar a função de callback para adicionar vídeo
    if (addRemoteVideo && typeof addRemoteVideo === 'function') {
      addRemoteVideo(remoteStream, peerId, peerName);
    }
  };
  
  // Se for o iniciador, criar e enviar oferta (com pequeno atraso)
  if (initiator) {
    setTimeout(() => {
      log(`Iniciando oferta para ${peerId} após atraso`);
      createAndSendOffer(pc, peerId);
    }, 1000); // Pequeno atraso para garantir que tudo esteja configurado
  }
  
  return pc;
}

// Cria e envia uma oferta para outro peer
async function createAndSendOffer(pc, peerId) {
  try {
    log(`Criando oferta para ${peerId}`);
    const offer = await pc.createOffer();
    log(`Definindo e enviando descrição local para ${peerId}`);
    await setLocalDescriptionAndSignal(pc, peerId, 'offer', offer);
    clearTimeout(pc.offerRetryTimer);
  } catch (error) {
    log(`Erro ao criar/enviar oferta para ${peerId}: ${error.message}`);

    if (peerConnections[peerId] !== pc) return;
    if (error.message === 'participant_not_in_room') {
      removePeerConnection(peerId, pc);
      return;
    }

    pc.pendingLocalCandidates = [];
    pc.localDescriptionSignaled = false;
    try {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setLocalDescription({ type: 'rollback' });
      }
    } catch (rollbackError) {
      log(`Não foi possível desfazer a oferta para ${peerId}: ${rollbackError.message}`);
      removePeerConnection(peerId, pc);
      return;
    }

    clearTimeout(pc.offerRetryTimer);
    pc.offerRetryTimer = setTimeout(() => {
      if (peerConnections[peerId] === pc && pc.signalingState === 'stable') {
        void createAndSendOffer(pc, peerId);
      }
    }, 2000);
  }
}

// Parar conexões e limpar recursos
function notifyLeave() {
  if (!roomId || !userId) return;

  const body = JSON.stringify({
    room: roomId,
    id: userId,
    participantId,
    previousConnectionId,
    name: username,
    generation: connectionGeneration
  });
  let leaveQueued = false;

  if (typeof navigator.sendBeacon === 'function') {
    try {
      // text/plain é CORS-safelisted e evita um preflight durante o unload.
      const payload = new Blob([body], { type: 'text/plain;charset=UTF-8' });
      leaveQueued = navigator.sendBeacon(`${SIGNALING_SERVER}/leave`, payload);
    } catch (error) {
      log(`Não foi possível enfileirar a saída: ${error.message}`);
    }
  }

  if (!leaveQueued) {
    void fetch(`${SIGNALING_SERVER}/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body,
      keepalive: true
    }).catch(error => log(`Não foi possível avisar a saída: ${error.message}`));
  }
}

export function disconnect() {
  clearTimeout(turnRefreshTimer);
  turnSession = null;
  if (hasDisconnected) return;
  hasDisconnected = true;

  log("Desconectando de todas as chamadas");
  isPolling = false;
  activeSignalingControllers.forEach(controller => controller.abort());
  activeSignalingControllers.clear();
  notifyLeave();
  
  // Fechar todas as conexões peer
  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};
  
  // Parar todas as tracks do stream local
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
  
  log("Desconectado");
}

// Adicionar função para garantir que o vídeo remoto seja exibido
function ensureVideoIsVisible(videoElement, peerId) {
  // Verificar periodicamente se o vídeo está realmente reproduzindo
  let attempts = 0;
  const checkInterval = setInterval(() => {
    if (attempts > 10) {
      clearInterval(checkInterval);
      return;
    }
    attempts++;
    
    if (videoElement.paused || videoElement.videoWidth === 0) {
      console.log(`Tentativa ${attempts} de reproduzir vídeo do peer ${peerId}`);
      videoElement.play().catch(e => console.log('Erro ao forçar play:', e));
    } else {
      console.log(`Vídeo do peer ${peerId} está reproduzindo!`);
      clearInterval(checkInterval);
      
      // Disparar um evento para notificar que o vídeo está ativo
      const event = new CustomEvent('video-active', { 
        detail: { peerId: peerId } 
      });
      window.dispatchEvent(event);
    }
  }, 1000);
}

export function addStreamToVideoElement(stream, videoElement, peerId) {
  log("Adicionando stream a elemento de vídeo");
  videoElement.srcObject = stream;
  videoElement.autoplay = true;
  videoElement.playsInline = true;
  videoElement.muted = true; // Adicionar esta linha para garantir que possa autoplay
  
  // Forçar play com tratamento de erro
  const playPromise = videoElement.play();
  
  if (playPromise !== undefined) {
    playPromise.catch(error => {
      console.warn('Erro ao reproduzir vídeo automaticamente:', error);
      // Mostrar botão de play se autoplay falhar
      const container = videoElement.parentElement;
      if (container) {
        const playButton = document.createElement('button');
        playButton.className = 'video-play-button';
        playButton.innerHTML = '<i class="fas fa-play"></i>';
        playButton.onclick = () => {
          videoElement.play()
            .then(() => playButton.remove())
            .catch(e => console.log('Erro ao forçar play:', e));
        };
        container.appendChild(playButton);
      }
    });
  }
  
  // Registrar evento loadedmetadata para garantir reprodução
  videoElement.addEventListener('loadedmetadata', () => {
    videoElement.play().catch(e => console.log('Erro no loadedmetadata:', e));
  });
}

// Adicione esta função de exportação para debug
export function getDebugInfo() {
  const debugInfo = {
    connections: {},
    network: navigator.onLine,
    webRTCSupport: !!window.RTCPeerConnection,
    mediaDevices: !!navigator.mediaDevices
  };
  
  // Obtenha estado das conexões
  for (const peerId in peerConnections) {
    const pc = peerConnections[peerId];
    debugInfo.connections[peerId] = {
      iceConnectionState: pc.iceConnectionState,
      connectionState: pc.connectionState,
      signalingState: pc.signalingState,
      iceCandidates: pc.remoteDescription ? 'Sim' : 'Não'
    };
  }
  
  return debugInfo;
}

// Função para enviar estado de mídia para outros participantes
export function updateMediaStatus(audioEnabled, videoEnabled, screenSharing = false) {
  audioStatus = audioEnabled;
  videoStatus = videoEnabled;
  screenShareStatus = screenSharing;
  
  // Enviar status para todos os peers conectados
  for (const peerId in peerConnections) {
    if (peerConnections[peerId].dataChannel && 
        peerConnections[peerId].dataChannel.readyState === 'open') {
      try {
        peerConnections[peerId].dataChannel.send(JSON.stringify({
          type: 'media-status',
          audio: audioEnabled,
          video: videoEnabled,
          screenSharing
        }));
      } catch (error) {
        log(`Não foi possível enviar o status de mídia para ${peerId}: ${error.message}`);
      }
    }
  }
}

// Função para atualizar UI baseada no status remoto
export function updateRemoteMediaUI(userId, audioEnabled, videoEnabled, screenSharing = false) {
  // Atualizar ícone de microfone
  const micStatus = document.querySelector(`#container-${userId} .mic-status`);
  if (micStatus) {
    micStatus.innerHTML = audioEnabled ? 
      '<i class="fas fa-microphone"></i>' : 
      '<i class="fas fa-microphone-slash"></i>';
    micStatus.classList.toggle('disabled', !audioEnabled);
  }
  
  // Marcar container de vídeo como desligado se necessário
  const container = document.getElementById(`container-${userId}`);
  if (container) {
    container.classList.toggle('video-off', !videoEnabled);
    container.classList.toggle('screen-sharing', screenSharing);
  }

  window.dispatchEvent(new CustomEvent('remote-media-status', {
    detail: {
      peerId: userId,
      audio: audioEnabled,
      video: videoEnabled,
      screenSharing
    }
  }));
}

// Modificar o handler de novos usuários para criar conexões
function handleNewUser(user) {
  if (user.id === myId) return; // Não conectar a si mesmo
  
  console.log(`Novo usuário detectado: ${user.name} (${user.id})`);
  
  // Iniciar conexão como initiator
  createPeerConnection(user.id, user.name, true);
  
  // Criar e enviar oferta
  const pc = peerConnections[user.id];
  if (pc) {
    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        sendSignal(user.id, {
          type: 'offer',
          sdp: pc.localDescription
        });
        console.log(`Oferta enviada para ${user.name}`);
      })
      .catch(err => console.error('Erro ao criar oferta:', err));
  }
}

// Garantir que o processamento de sinais esteja correto
// Adicionar um conjunto para rastrear sinais já processados
const processedSignals = new Set();

function processSignals(signals) {
  signals.forEach(signal => {
    const { from, data, id } = signal;
    
    // Verificar se este sinal já foi processado (usando ID único)
    const signalId = id || `${from}-${data.type}-${Date.now()}`;
    if (processedSignals.has(signalId)) {
      console.log(`Sinal duplicado ignorado: ${data.type} de ${from}`);
      return;
    }
    
    // Marcar sinal como processado
    processedSignals.add(signalId);
    
    // Limitar tamanho do conjunto para evitar crescimento infinito
    if (processedSignals.size > 1000) {
      const iterator = processedSignals.values();
      processedSignals.delete(iterator.next().value);
    }
    
    console.log(`Processando sinal ${data.type} de ${from}`);
    
    // Resto do código de processamento existente...
    // ...
    
    // Para sinais 'answer', verificar o estado atual antes de aplicar
    if (data.type === 'answer') {
      const pc = peerConnections[from];
      if (pc && pc.signalingState === 'have-local-offer') {
        // Só aplicar resposta se estivermos no estado correto
        pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
          .catch(err => console.error('Erro ao processar resposta:', err));
      } else {
        console.log(`Ignorando resposta de ${from}, estado atual: ${pc ? pc.signalingState : 'conexão não encontrada'}`);
      }
    }
    
    // ...resto do código existente...
  });
}
