// Configuração dos servidores STUN/TURN públicos
const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // Servidores TURN gratuitos adicionais
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    // Adicione esses servidores TURN gratuitos
    {
      urls: 'turn:relay.metered.ca:80',
      username: 'e8d34faf7cb62de234b299da',
      credential: 'uGP8+dMDCQIK+DRo'
    },
    {
      urls: 'turn:relay.metered.ca:443',
      username: 'e8d34faf7cb62de234b299da',
      credential: 'uGP8+dMDCQIK+DRo'
    },
    {
      urls: 'turn:relay.metered.ca:443?transport=tcp',
      username: 'e8d34faf7cb62de234b299da',
      credential: 'uGP8+dMDCQIK+DRo'
    }
  ]
};

// URL do servidor de sinalização (Cloudflare Worker)
const SIGNALING_SERVER = 'https://webrtc.mosaicoworkers.workers.dev';

// Variáveis globais
let peerConnections = {}; // Armazena conexões peer
let localStream;
let roomId;
let userId;
let username;
let isPolling = false;
let lastPollTime = 0;
const senderKinds = new WeakMap();
const signalQueues = new Map();

// Variável para armazenar status de áudio e vídeo
let audioStatus = true;
let videoStatus = true;

// Canal de dados para transmitir status do microfone/câmera entre participantes
let dataChannels = {};

// Log personalizado
function log(message) {
  console.log(`[WebRTC ${new Date().toLocaleTimeString()}] ${message}`);
}

// Gera um ID aleatório
function generateRandomId() {
  return Math.random().toString(36).substr(2, 9);
}

// Função para conectar à sala WebRTC
export async function connectToRoom(room, stream, addRemoteVideo) {
  roomId = normalizeRoomId(room);
  userId = generateRandomId();
  username = localStorage.getItem('userName') || 'Anônimo';
  localStream = stream;
  
  console.log(`Conectando à sala ${roomId} como ${username} (ID: ${userId})`);
  
  // Registrar na sala
  try {
    const response = await fetch(`${SIGNALING_SERVER}/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ room: roomId, id: userId, name: username })
    });
    
    const data = await response.json();
    
    if (data.success) {
      console.log(`Conectado ao servidor de sinalização`, data);
      publishParticipants(data.users);
      
      // Conectar com os usuários existentes - MODIFICAÇÃO AQUI
      // Ordene por ID para garantir que apenas um lado inicia
      const sortedUsers = [...data.users].sort((a, b) => a.id.localeCompare(b.id));
      
      sortedUsers.forEach(user => {
        if (user.id !== userId) {
          // Apenas o peer com ID "menor" alfabeticamente inicia a conexão
          const shouldInitiate = userId < user.id;
          console.log(`Detectado usuário: ${user.name} (${user.id}), iniciando: ${shouldInitiate}`);
          createPeerConnection(user.id, user.name, shouldInitiate, addRemoteVideo);
        }
      });
      
      // Começar a consultar o servidor em busca de atualizações
      startPolling(addRemoteVideo);
      
      return true;
    } else {
      console.error('Falha ao conectar ao servidor de sinalização');
      return false;
    }
  } catch (error) {
    console.error('Erro ao conectar ao servidor de sinalização:', error);
    return false;
  }
}

// Atualiza as tracks enviadas quando o usuário troca câmera ou microfone.
export async function replaceLocalStream(stream) {
  localStream = stream;
  const tracksByKind = new Map(stream.getTracks().map(track => [track.kind, track]));
  await Promise.all(Object.values(peerConnections).flatMap(pc =>
    pc.getSenders().map(sender => {
      const kind = senderKinds.get(sender) || sender.track?.kind;
      const replacement = kind === 'audio' && !audioStatus ? null : tracksByKind.get(kind);
      return sender.replaceTrack(replacement || null);
    })
  ));
}

// Desconecta a track de áudio dos RTCRtpSenders ao mutar. Isso interrompe o
// envio de RTP imediatamente, em vez de depender só de track.enabled.
export function setLocalAudioEnabled(enabled) {
  audioStatus = enabled;
  const audioTracks = localStream?.getAudioTracks() || [];
  audioTracks.forEach(track => {
    track.enabled = enabled;
  });
  const audioTrack = audioTracks[0] || null;

  return Promise.all(Object.values(peerConnections).flatMap(pc =>
    pc.getSenders()
      .filter(sender => (senderKinds.get(sender) || sender.track?.kind) === 'audio')
      .map(sender => sender.replaceTrack(enabled ? audioTrack : null))
  ));
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
  
  async function poll() {
    if (!isPolling) return;
    
    try {
      const response = await fetch(`${SIGNALING_SERVER}/poll?room=${roomId}&id=${userId}&last=${lastPollTime}`);
      const data = await response.json();
      
      if (data.success) {
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
        
        // Processar sinais recebidos
        if (data.signals && data.signals.length > 0) {
          console.log("Sinais recebidos:", data.signals);
          data.signals.forEach(signal => {
            handleSignal(signal, addRemoteVideo);
          });
        }
        
        lastPollTime = Date.now();
      }
    } catch (error) {
      console.error("Erro durante polling:", error);
    }
    
    // Sempre agendar próximo poll, mesmo com erro
    setTimeout(poll, 2000);
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
      await pc.setLocalDescription(answer);
      
      console.log(`Enviando resposta para ${sender}`);
      sendSignal(sender, 'answer', answer);
    } else if (type === 'answer') {
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
  }
}

  async function addPendingIceCandidates(pc) {
    if (!pc.pendingCandidates) return;

    const pendingCandidates = pc.pendingCandidates;
    pc.pendingCandidates = [];

    for (const candidate of pendingCandidates) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

// Envia um sinal para outro peer
async function sendSignal(target, type, data) {
  const send = async () => {
    log(`Enviando sinal ${type} para ${target}`);
    const response = await fetch(`${SIGNALING_SERVER}/signal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
          room: roomId,
        sender: userId,
        target,
        type,
        data
      })
    });
    
    const result = await response.json();
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
  } finally {
    if (signalQueues.get(target) === queued) {
      signalQueues.delete(target);
    }
  }
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
  
  // Adicionar tracks locais à conexão
  if (localStream) {
    console.log(`Adicionando ${localStream.getTracks().length} tracks locais à conexão`);
    localStream.getTracks().forEach(track => {
      const sender = pc.addTrack(track, localStream);
      senderKinds.set(sender, track.kind);
    });
  }
  
  // Lidar com candidatos ICE
  pc.onicecandidate = event => {
    if (event.candidate) {
      console.log(`Enviando candidato ICE para ${peerId}: ${event.candidate.candidate.substr(0, 50)}...`);
      sendSignal(peerId, 'candidate', event.candidate);
    } else {
      console.log(`Coleta de candidatos ICE para ${peerId} concluída`);
    }
  };
  
  // Monitorar o estado da conexão
  pc.oniceconnectionstatechange = () => {
    console.log(`Estado ICE para ${peerId}: ${pc.iceConnectionState}`);
    
    // Retry de conexão se falhar
    if (pc.iceConnectionState === 'failed') {
      console.log(`Conexão com ${peerId} falhou, tentando reiniciar ICE`);
      pc.restartIce();
      
      // Se for iniciador, tenta novamente a oferta
      if (initiator) {
        setTimeout(() => {
          console.log(`Tentando nova oferta para ${peerId} após falha`);
          createAndSendOffer(pc, peerId);
        }, 2000);
      }
    }
  };
  
  // Adicionar canal de dados para comunicação não-mídia
  if (initiator) {
    const dataChannel = pc.createDataChannel('status');
    dataChannel.onopen = () => {
      console.log(`Canal de dados aberto para ${peerId}`);
      // Enviar status atual imediatamente após conexão
      dataChannel.send(JSON.stringify({
        type: 'media-status',
        audio: audioStatus,
        video: videoStatus
      }));
    };
    pc.dataChannel = dataChannel;
  } else {
    pc.ondatachannel = (event) => {
      const dataChannel = event.channel;
      pc.dataChannel = dataChannel;
      
      dataChannel.onopen = () => {
        console.log(`Canal de dados aberto para ${peerId}`);
        // Enviar status atual imediatamente após conexão
        dataChannel.send(JSON.stringify({
          type: 'media-status',
          audio: audioStatus,
          video: videoStatus
        }));
      };
      
      dataChannel.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'media-status') {
            // Atualizar UI com status remoto
            updateRemoteMediaUI(peerId, data.audio, data.video);
          }
        } catch (e) {
          console.error('Erro ao processar mensagem de dados:', e);
        }
      };
    };
  }
  
  // Lidar com estado da conexão ICE
  pc.oniceconnectionstatechange = () => {
    log(`Conexão ICE com ${peerId} mudou para ${pc.iceConnectionState}`);
    
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      log(`Conexão estabelecida com ${peerId}!`);
    }
    
    if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
      log(`Conexão com ${peerId} encerrada ou falhou (${pc.iceConnectionState})`);
      if (peerConnections[peerId]) {
        pc.close();
        delete peerConnections[peerId];
        
        // Remover elemento de vídeo
        const videoElement = document.getElementById(`video-${peerId}`);
        if (videoElement && videoElement.parentNode) {
          videoElement.parentNode.remove();
        }
      }
    }
  };
  
  // Lidar com conexão de dados (quando estabelecida)
  pc.onconnectionstatechange = () => {
    log(`Estado da conexão com ${peerId}: ${pc.connectionState}`);
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
    log(`Definindo descrição local para ${peerId}`);
    await pc.setLocalDescription(offer);
    
    log(`Enviando oferta para ${peerId}`);
    sendSignal(peerId, 'offer', offer);
  } catch (error) {
    log(`Erro ao criar/enviar oferta para ${peerId}: ${error.message}`);
  }
}

// Parar conexões e limpar recursos
export function disconnect() {
  log("Desconectando de todas as chamadas");
  isPolling = false;

  if (roomId && userId) {
    const body = JSON.stringify({ room: roomId, id: userId });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(`${SIGNALING_SERVER}/leave`, new Blob([body], { type: 'application/json' }));
    } else {
      fetch(`${SIGNALING_SERVER}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true
      });
    }
  }
  
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
export function updateMediaStatus(audioEnabled, videoEnabled) {
  audioStatus = audioEnabled;
  videoStatus = videoEnabled;
  
  // Enviar status para todos os peers conectados
  for (const peerId in peerConnections) {
    if (peerConnections[peerId].dataChannel && 
        peerConnections[peerId].dataChannel.readyState === 'open') {
      peerConnections[peerId].dataChannel.send(JSON.stringify({
        type: 'media-status',
        audio: audioEnabled,
        video: videoEnabled
      }));
    }
  }
}

// Função para atualizar UI baseada no status remoto
export function updateRemoteMediaUI(userId, audioEnabled, videoEnabled) {
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
  }
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
