import {
  connectToRoom,
  disconnect,
  replaceLocalStream,
  replaceLocalVideoTrack,
  setLocalAudioEnabled,
  updateMediaStatus
} from './webrtc.js';

// Adicione isso no topo do arquivo para verificar importações

console.log('Calls.js carregado');

// Verificar se as funções do webrtc.js estão sendo importadas corretamente
console.log('Funções importadas de webrtc.js:', {
  connectToRoom: typeof connectToRoom,
  disconnect: typeof disconnect,
  replaceLocalVideoTrack: typeof replaceLocalVideoTrack
});

// Adicionar no início do arquivo, após as importações

// Log detalhado para diagnóstico
console.log('==== AGORAONE ====');
console.log('Versão: 2.0.0');
console.log('Data: ' + new Date().toISOString());
console.log('User Agent: ' + navigator.userAgent);
console.log('Suporte ao WebRTC:', 
  'RTCPeerConnection' in window ? 'Sim' : 'Não',
  'getUserMedia' in navigator.mediaDevices ? 'Sim' : 'Não',
  'RTCDataChannel' in window ? 'Sim' : 'Não'
);
console.log('================================');

// Log de erro global para capturar erros não tratados
window.addEventListener('error', function(event) {
  console.error('ERRO GLOBAL:', event.message, 'em', event.filename, 'linha', event.lineno);
});

// Variáveis
let localStream;
let audioEnabled = true;
let videoEnabled = true;
const userName = localStorage.getItem('userName') || 'Anônimo';
let localVideoContainer = null;
let remoteAudioEnabled = true;
let cameraVideoTrack = null;
let displayVideoTrack = null;
let isScreenSharing = false;
let screenShareTransition = false;
let screenShareFeedbackTimer = null;
let callEnding = false;
let mediaRequestGeneration = 0;
let deviceChangeTimer = null;
let mediaRecoveryTimer = null;
let mediaRecoveryInProgress = false;
let mediaRecoveryAttempts = 0;
let pageInactiveAt = 0;
let captureDeviceChangeGeneration = 0;
let lastSuccessfulCaptureAt = 0;
let mediaInitialized = false;
const remoteMediaStates = new Map();
const supportsAudioOutputSelection = typeof HTMLMediaElement !== 'undefined'
  && typeof HTMLMediaElement.prototype.setSinkId === 'function';

// Elementos DOM
const toggleAudioButton = document.getElementById('toggle-audio');
const toggleVideoButton = document.getElementById('toggle-video');
const leaveButton = document.getElementById('leave-button');
const cameraSelect = document.getElementById('camera-select');
const microphoneSelect = document.getElementById('microphone-select');
const speakerSelect = document.getElementById('speaker-select');
const enableRemoteAudioButton = document.getElementById('enable-remote-audio');
const mainVideoContainer = document.getElementById('main-video-container');
const pipContainer = document.getElementById('pip-container');
const audioSettingsButton = document.getElementById('audio-settings');
const videoSettingsButton = document.getElementById('video-settings');
const audioSettingsMenu = document.getElementById('audio-settings-menu');
const videoSettingsMenu = document.getElementById('video-settings-menu');
const shareButton = document.getElementById('share-button');
const shareDialog = document.getElementById('share-dialog');
const meetingLinkInput = document.getElementById('meeting-link');
const copyLinkButton = document.getElementById('copy-link');
const closeShareButton = document.getElementById('close-share');
const roomCodeElement = document.getElementById('room-code');
const participantCountElement = document.getElementById('participant-count');
const screenShareButton = document.getElementById('screen-share-button');
const screenShareStatus = document.getElementById('screen-share-status');
const screenShareStatusText = document.getElementById('screen-share-status-text');
const stopScreenShareButton = document.getElementById('stop-screen-share');
const closeShareIconButton = document.getElementById('close-share-icon');
const copyFeedback = document.getElementById('copy-feedback');
const meetContainer = document.querySelector('.meet-container');
const connectionStatus = document.getElementById('connection-status');
const connectionStatusText = document.getElementById('connection-status-text');
const connectionStatusIcon = connectionStatus?.querySelector('i');

// Obter código da sala a partir da URL
const urlParams = new URLSearchParams(window.location.search);
const roomCode = normalizeRoomCode(urlParams.get('room') || '');

// Verificar se temos um código de sala
if (!roomCode) {
  alert('Código de sala inválido. Redirecionando para a página inicial.');
  window.location.href = 'index.html';
}

// Atualizar UI com informações da sala
roomCodeElement.textContent = formatRoomCode(roomCode);
document.title = `${formatRoomCode(roomCode)} · AgoraOne`;
const meetingUrl = new URL('calls.html', window.location.href);
meetingUrl.search = '';
meetingUrl.searchParams.set('room', roomCode);
meetingLinkInput.value = meetingUrl.href;

// Atualizar relógio
function updateClock() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('current-time').textContent = timeStr;
}
updateClock();
setInterval(updateClock, 60000);

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function connectWithRecovery() {
  let failedRounds = 0;

  while (!callEnding) {
    const connected = await connectToRoom(roomCode, localStream, handleRemoteStream);
    if (connected || callEnding) return connected;

    failedRounds += 1;
    const retryDelay = Math.min(2500 + (failedRounds * 1500), 10000);
    await delay(retryDelay);
  }

  return false;
}

// Inicializar
async function init() {
  try {
    // Inicializar o stream local
    await startLocalStream();
    if (callEnding || !localStream) return;
    
    await updateDeviceList();
    if (callEnding || !localStream) return;

    // Criar container para vídeo local
    localVideoContainer = createVideoContainer('local', userName + ' (Você)', localStream);
    localVideoContainer.classList.add('local-video');
    
    // Adicionar ao container principal primeiro
    mainVideoContainer.appendChild(localVideoContainer);
    updateVideoContainerPlacement(localVideoContainer, true);
    mediaInitialized = true;
    updateCallMediaControls();
    
    // Conectar à sala WebRTC
    await connectWithRecovery();
    
  } catch (error) {
    mediaInitialized = false;
    updateCallMediaControls();
    if (callEnding) return;
    console.error('Erro ao inicializar:', error);
    alert(`Erro ao acessar câmera/microfone: ${error.message}`);
  }
}

// Criar container de vídeo
function createVideoContainer(id, name, stream) {
  const container = document.createElement('div');
  container.className = `video-container ${id === 'local' ? 'local-video' : 'remote-video'}`;
  container.id = `container-${id}`;
  container.dataset.participantId = id;
  container.dataset.participantName = name;
  
  const video = document.createElement('video');
  video.id = `video-${id}`;
  video.autoplay = true;
  video.playsInline = true;
  if (id === 'local') video.muted = true;
  video.addEventListener('loadedmetadata', () => updateVideoShape(video));
  video.addEventListener('resize', () => updateVideoShape(video));
  
  const nameTag = document.createElement('div');
  nameTag.className = 'participant-name';
  nameTag.textContent = name;
  
  // Adicionar indicadores de status (microfone/câmera)
  const statusIcons = document.createElement('div');
  statusIcons.className = 'status-icons';
  
  const micIcon = document.createElement('span');
  micIcon.className = 'status-icon mic-status';
  micIcon.innerHTML = '<i class="fas fa-microphone"></i>';
  
  statusIcons.appendChild(micIcon);
  
  // Adicionar todos os elementos ao container
  container.appendChild(video);
  container.appendChild(nameTag);
  container.appendChild(statusIcons);
  
  // Anexar o stream ao vídeo
  if (stream) {
    video.srcObject = stream;
  }
  
  const promoteVideo = () => toggleMainVideo(id);
  container.addEventListener('click', promoteVideo);
  container.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      promoteVideo();
    }
  });
  
  return container;
}

function updateVideoContainerPlacement(container, isMain) {
  if (isMain) {
    container.removeAttribute('role');
    container.removeAttribute('tabindex');
    container.removeAttribute('aria-label');
    return;
  }

  container.tabIndex = 0;
  container.setAttribute('role', 'button');
  container.setAttribute(
    'aria-label',
    `Colocar ${container.dataset.participantName || 'participante'} no vídeo principal`
  );
}

function updateVideoShape(video) {
  const container = video.closest('.video-container');
  if (!container || container.classList.contains('screen-sharing')) return;
  const isPortrait = video.videoHeight > video.videoWidth && video.videoWidth > 0;
  container.classList.toggle('portrait-video', isPortrait);
}

// Alternar vídeo principal
function toggleMainVideo(id) {
  const container = document.getElementById(`container-${id}`);
  if (!container) return;
  
  // Se este container já está no main, não fazer nada
  if (container.parentElement === mainVideoContainer) return;
  if (container.parentElement !== pipContainer) return;
  
  // Recuperar o container que está no main atualmente
  const mainVideo = mainVideoContainer.querySelector('.video-container');
  
  if (mainVideo) {
    // Mover o vídeo principal atual para o PIP
    mainVideoContainer.removeChild(mainVideo);
    pipContainer.appendChild(mainVideo);
    mainVideo.classList.remove('main-video');
    mainVideo.classList.add('pip-video');
    updateVideoContainerPlacement(mainVideo, false);
  }
  
  // Mover o container clicado para o main
  pipContainer.removeChild(container);
  mainVideoContainer.appendChild(container);
  container.classList.remove('pip-video');
  container.classList.add('main-video');
  updateVideoContainerPlacement(container, true);
  
}

function handleRemoteStream(stream, userId, userName) {
  console.log('Handle remote stream called for', userId);
  
  // Verificar se o container já existe
  const existingContainer = document.getElementById(`container-${userId}`);
  if (existingContainer) {
    const video = document.getElementById(`video-${userId}`);
    if (video) {
      attachRemoteStream(stream, video, userId);
    }
    const state = remoteMediaStates.get(userId);
    if (state) applyRemoteMediaState(existingContainer, state);
    return;
  }
  
  // Criar novo container de vídeo
  const container = createVideoContainer(userId, userName, stream);
  
  // O primeiro participante remoto ocupa o palco; a câmera local vai para o PiP.
  if (mainVideoContainer.querySelector('.video-container')) {
    pipContainer.appendChild(container);
    updateVideoContainerPlacement(container, false);
  } else {
    mainVideoContainer.appendChild(container);
    updateVideoContainerPlacement(container, true);
  }

  const state = remoteMediaStates.get(userId);
  if (state) applyRemoteMediaState(container, state);
  promoteFirstRemoteIfNeeded(userId);
  
  // Forçar reprodução do vídeo
  const video = document.getElementById(`video-${userId}`);
  if (video) {
    attachRemoteStream(stream, video, userId);
  }
}

async function applySelectedAudioOutput(video, sinkId = speakerSelect.value) {
  if (typeof video.setSinkId !== 'function' || !sinkId) return true;

  try {
    if (video.sinkId !== sinkId) {
      await video.setSinkId(sinkId);
    }
    return true;
  } catch (error) {
    console.warn('Não foi possível aplicar a saída de áudio selecionada:', error);
    return false;
  }
}

function promoteFirstRemoteIfNeeded(userId) {
  const mainVideo = mainVideoContainer.querySelector('.video-container');
  if (!mainVideo || mainVideo.classList.contains('local-video')) {
    toggleMainVideo(userId);
  }
}

function ensureStageVideo() {
  if (mainVideoContainer.querySelector('.video-container')) return;

  const nextVideo = pipContainer.querySelector('.remote-video')
    || pipContainer.querySelector('.local-video');
  if (nextVideo) {
    toggleMainVideo(nextVideo.dataset.participantId);
  }
}

function applyRemoteMediaState(container, state) {
  const micStatus = container.querySelector('.mic-status');
  if (micStatus) {
    micStatus.innerHTML = state.audio
      ? '<i class="fas fa-microphone" aria-hidden="true"></i>'
      : '<i class="fas fa-microphone-slash" aria-hidden="true"></i>';
    micStatus.classList.toggle('disabled', !state.audio);
  }
  container.classList.toggle('video-off', !state.video);
  container.classList.toggle('screen-sharing', state.screenSharing);
  if (state.screenSharing) {
    container.classList.remove('portrait-video');
    if (container.parentElement === pipContainer) {
      toggleMainVideo(container.dataset.participantId);
    }
  } else {
    const video = container.querySelector('video');
    if (video) updateVideoShape(video);
  }
}

function updateRemoteAudioPrompt() {
  const hasMutedRemoteVideo = Array.from(
    document.querySelectorAll('video[data-remote-video="true"]')
  ).some(video => video.muted);

  enableRemoteAudioButton.classList.toggle('hidden', !hasMutedRemoteVideo);
}

async function playRemoteStream(video, userId) {
  video.muted = !remoteAudioEnabled;
  video.volume = 1;
  const playPromise = video.play();
  void applySelectedAudioOutput(video);

  try {
    await playPromise;
    updateRemoteAudioPrompt();
  } catch (error) {
    if (error.name === 'AbortError') return;

    if (!video.muted && error.name === 'NotAllowedError') {
      // Alguns navegadores ainda exigem um gesto explícito. Mantemos o vídeo
      // rodando e mostramos um controle visível para liberar o som.
      video.muted = true;
      updateRemoteAudioPrompt();
      try {
        await video.play();
      } catch (mutedError) {
        console.warn(`Não foi possível reproduzir o vídeo de ${userId}:`, mutedError);
      }
      return;
    }

    console.warn(`Não foi possível reproduzir a mídia de ${userId}:`, error);
  }
}

function attachRemoteStream(stream, video, userId) {
  // ontrack pode disparar uma vez para áudio e outra para vídeo. Não atribuir
  // novamente o mesmo stream evita AbortError e botões de play falsos.
  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }
  video.autoplay = true;
  video.playsInline = true;
  video.dataset.remoteVideo = 'true';

  void playRemoteStream(video, userId);
}

async function enableRemoteAudio() {
  remoteAudioEnabled = true;
  const remoteVideos = Array.from(document.querySelectorAll('video[data-remote-video="true"]'));

  await Promise.all(remoteVideos.map(async video => {
    video.muted = false;
    video.volume = 1;
    // Chamar play() antes de qualquer await preserva a ativação transitória
    // fornecida pelo toque/clique que disparou esta função.
    const playPromise = video.play();
    void applySelectedAudioOutput(video);

    try {
      await playPromise;
    } catch (error) {
      if (error.name === 'AbortError') return;
      console.warn('Não foi possível ativar áudio remoto:', error);
      video.muted = true;
    }
  }));

  updateRemoteAudioPrompt();
}

function getCameraVideoConstraints(videoDeviceId) {
  const portrait = isMobileDevice() && window.matchMedia?.('(orientation: portrait)').matches;
  const idealWidth = portrait ? 720 : 1280;
  const idealHeight = portrait ? 1280 : 720;
  return {
    width: { ideal: idealWidth },
    height: { ideal: idealHeight },
    frameRate: { ideal: 30, max: 30 },
    ...(videoDeviceId
      ? { deviceId: { exact: videoDeviceId } }
      : { facingMode: { ideal: 'user' } })
  };
}

function monitorLocalTracks(stream) {
  stream.getTracks().forEach(track => {
    track.addEventListener('mute', () => scheduleMediaRecovery(1200));
    track.addEventListener('ended', () => scheduleMediaRecovery(350), { once: true });
    track.addEventListener('unmute', () => {
      if (localStream?.getTracks().includes(track)) mediaRecoveryAttempts = 0;
    });
  });
}

// Função para iniciar stream local
async function startLocalStream(videoDeviceId, audioDeviceId) {
  if (isScreenSharing || screenShareTransition || callEnding) return localStream;

  const requestGeneration = ++mediaRequestGeneration;
  const constraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {})
    },
    video: getCameraVideoConstraints(videoDeviceId)
  };
  
  const previousStream = localStream;
  const previousCameraTrack = cameraVideoTrack;
  const nextStream = await navigator.mediaDevices.getUserMedia(constraints);
  if (
    requestGeneration !== mediaRequestGeneration
    || callEnding
    || isScreenSharing
    || screenShareTransition
  ) {
    nextStream.getTracks().forEach(track => track.stop());
    return localStream;
  }

  cameraVideoTrack = nextStream.getVideoTracks()[0] || null;
  if (cameraVideoTrack) cameraVideoTrack.contentHint = 'motion';
  nextStream.getAudioTracks().forEach(track => { track.enabled = audioEnabled; });
  nextStream.getVideoTracks().forEach(track => { track.enabled = videoEnabled; });
  localStream = nextStream;
  try {
    await replaceLocalStream(nextStream);
  } catch (error) {
    nextStream.getTracks().forEach(track => track.stop());
    if (callEnding) {
      previousStream?.getTracks().forEach(track => track.stop());
      localStream = undefined;
      cameraVideoTrack = null;
      return undefined;
    }
    localStream = previousStream;
    cameraVideoTrack = previousCameraTrack;
    if (previousStream) {
      try {
        await replaceLocalStream(previousStream);
      } catch (rollbackError) {
        console.error('Não foi possível restaurar a captura anterior:', rollbackError);
      }
    }
    throw error;
  }
  if (callEnding) {
    nextStream.getTracks().forEach(track => track.stop());
    previousStream?.getTracks().forEach(track => track.stop());
    localStream = undefined;
    cameraVideoTrack = null;
    return undefined;
  }
  monitorLocalTracks(nextStream);
  lastSuccessfulCaptureAt = Date.now();
  if (previousStream) previousStream.getTracks().forEach(track => track.stop());
  
  // Se já temos um container de vídeo, atualizar o stream
  const localVideo = document.getElementById('video-local');
  if (localVideo) {
    localVideo.srcObject = localStream;
    void localVideo.play().catch(() => {});
  }
  
  return nextStream;
}

async function updateDeviceList(applyPreferredRoute = true) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(device => device.kind === 'videoinput');
    const microphones = devices.filter(device => device.kind === 'audioinput');
    const speakers = devices.filter(device => device.kind === 'audiooutput');

    const activeVideoDeviceId = localStream?.getVideoTracks()[0]?.getSettings().deviceId;
    const activeAudioDeviceId = localStream?.getAudioTracks()[0]?.getSettings().deviceId;
    const storedCameraId = localStorage.getItem('agoraone:camera-id');
    const storedMicrophoneId = localStorage.getItem('agoraone:microphone-id');
    const storedSpeakerId = localStorage.getItem('agoraone:speaker-id');
    const findById = (list, id) => list.find(device => device.deviceId === id);

    // O Chromium expõe o auricular interno de alguns celulares Samsung como
    // "Headset earpiece". Ele não é um headset conectado e não deve ganhar
    // prioridade sobre o viva-voz nem sobre uma escolha persistida do usuário.
    const earpiecePattern = /earpiece|receiver|auricular interno|receptor/i;
    const accessoryPattern = /headset|headphone|wired|bluetooth|usb|fone|auricular|buds|airpods/i;
    const speakerphonePattern = /speaker\s?phone|viva.?voz|alto.?falante/i;
    const accessoryMicrophone = microphones.find(device => (
      accessoryPattern.test(device.label) && !earpiecePattern.test(device.label)
    ));
    const speakerphoneMicrophone = microphones.find(device => speakerphonePattern.test(device.label));
    const storedMicrophone = findById(microphones, storedMicrophoneId);
    const storedMicrophoneIsGeneric = storedMicrophone
      && (storedMicrophone.deviceId === 'default' || /default|padrão/i.test(storedMicrophone.label));
    const automaticMobileMicrophone = applyPreferredRoute && isMobileDevice()
      ? accessoryMicrophone || speakerphoneMicrophone
      : null;

    const preferredCamera = findById(cameras, storedCameraId)
      || findById(cameras, activeVideoDeviceId)
      || cameras.find(device => /facing front|front|user|frontal/i.test(device.label))
      || cameras[0];
    const preferredMicrophone = (!storedMicrophoneIsGeneric ? storedMicrophone : null)
      || automaticMobileMicrophone
      || storedMicrophone
      || findById(microphones, activeAudioDeviceId)
      || microphones[0];
    const preferredSpeaker = findById(speakers, storedSpeakerId)
      || speakers.find(device => device.deviceId === 'default')
      || speakers[0];

    cameraSelect.replaceChildren(...cameras.map((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Câmera ${index + 1}`;
      option.selected = device === preferredCamera;
      return option;
    }));

    microphoneSelect.replaceChildren(...microphones.map((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Microfone ${index + 1}`;
      option.selected = device === preferredMicrophone;
      return option;
    }));

    if (speakers.length) {
      speakerSelect.replaceChildren(...speakers.map((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Alto-falante ${index + 1}`;
        option.selected = device === preferredSpeaker;
        return option;
      }));
      speakerSelect.disabled = speakers.length < 2 || !supportsAudioOutputSelection;
    } else {
      const option = new Option('Alto-falante padrão', '');
      speakerSelect.replaceChildren(option);
      speakerSelect.disabled = true;
    }

    const preferredRouteIsDifferent = preferredMicrophone?.deviceId
      && preferredMicrophone.deviceId !== activeAudioDeviceId;
    const preferredCameraIsDifferent = preferredCamera?.deviceId
      && preferredCamera.deviceId !== activeVideoDeviceId;

    if (applyPreferredRoute && (preferredRouteIsDifferent || preferredCameraIsDifferent)) {
      try {
        await startLocalStream(preferredCamera?.deviceId, preferredMicrophone?.deviceId);
      } catch (error) {
        console.warn('Não foi possível aplicar o dispositivo preferido; mantendo o padrão:', error);
      }
    }
  } catch (error) {
    console.error('Erro ao listar dispositivos:', error);
  }
}

// Formatar código de sala para exibição
function formatRoomCode(code) {
  if (code.includes('-')) return code;
  
  if (code.length === 10) {
    return `${code.substr(0, 3)}-${code.substr(3, 4)}-${code.substr(7, 3)}`;
  }
  
  return code;
}

function normalizeRoomCode(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isMobileDevice() {
  return navigator.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function localCaptureNeedsRecovery() {
  const audioTrack = localStream?.getAudioTracks()[0];
  const videoTrack = cameraVideoTrack || localStream?.getVideoTracks()[0];
  const audioUnavailable = !audioTrack || audioTrack.readyState === 'ended' || audioTrack.muted;
  const videoUnavailable = !videoTrack || videoTrack.readyState === 'ended' || videoTrack.muted;
  return audioUnavailable || videoUnavailable;
}

async function resumeRemotePlayback() {
  const remoteVideos = document.querySelectorAll('video[data-remote-video="true"]');
  await Promise.all(Array.from(remoteVideos, video => {
    const peerId = video.closest('.video-container')?.dataset.participantId || 'remoto';
    return playRemoteStream(video, peerId);
  }));
}

function scheduleMediaRecovery(delay = 800, force = false) {
  clearTimeout(mediaRecoveryTimer);
  if (!mediaInitialized || callEnding || document.visibilityState === 'hidden') return;

  mediaRecoveryTimer = setTimeout(() => {
    void recoverLocalMediaAfterInterruption(force);
  }, delay);
}

async function recoverLocalMediaAfterInterruption(force = false) {
  if (
    callEnding
    || !mediaInitialized
    || mediaRecoveryInProgress
    || document.visibilityState === 'hidden'
    || screenShareTransition
  ) return;

  mediaRecoveryInProgress = true;
  try {
    await resumeRemotePlayback();
    const captureWasJustRefreshed = Date.now() - lastSuccessfulCaptureAt < 2000;
    if (
      isScreenSharing
      || (force && captureWasJustRefreshed)
      || (!force && !localCaptureNeedsRecovery())
    ) return;

    await startLocalStream(
      cameraSelect.value || undefined,
      microphoneSelect.value || undefined
    );
    if (callEnding) return;
    await updateDeviceList(false);
    mediaRecoveryAttempts = 0;
  } catch (error) {
    mediaRecoveryAttempts += 1;
    console.warn('A captura foi interrompida e ainda não pôde ser retomada:', error);
    if (mediaRecoveryAttempts < 3) {
      scheduleMediaRecovery(1200 * mediaRecoveryAttempts, true);
    }
  } finally {
    mediaRecoveryInProgress = false;
  }
}

function setCaptureControlsLocked(locked) {
  const unavailable = locked || !mediaInitialized || callEnding;
  toggleVideoButton.disabled = unavailable;
  videoSettingsButton.disabled = unavailable;
  cameraSelect.disabled = unavailable;
  microphoneSelect.disabled = unavailable;
}

function updateCallMediaControls() {
  toggleAudioButton.disabled = !mediaInitialized || callEnding;
  audioSettingsButton.disabled = !mediaInitialized || callEnding;
  setCaptureControlsLocked(isScreenSharing || screenShareTransition);
  screenShareButton.disabled = !mediaInitialized
    || callEnding
    || screenShareTransition
    || !navigator.mediaDevices?.getDisplayMedia;
}

function setScreenShareUi(active) {
  clearTimeout(screenShareFeedbackTimer);
  screenShareButton.classList.toggle('active', active);
  screenShareButton.setAttribute('aria-pressed', String(active));
  screenShareButton.setAttribute('aria-label', active ? 'Parar compartilhamento de tela' : 'Compartilhar tela');
  screenShareButton.title = active ? 'Parar compartilhamento de tela' : 'Compartilhar tela';
  screenShareButton.innerHTML = active
    ? '<i class="fas fa-stop" aria-hidden="true"></i>'
    : '<i class="fas fa-desktop" aria-hidden="true"></i>';
  screenShareStatusText.textContent = 'Você está apresentando';
  stopScreenShareButton.classList.remove('hidden');
  screenShareStatus.classList.toggle('hidden', !active);

  setCaptureControlsLocked(active || screenShareTransition);

  const localContainer = document.getElementById('container-local');
  if (localContainer) {
    localContainer.classList.toggle('screen-sharing', active);
    localContainer.classList.remove('portrait-video');
    localContainer.classList.toggle('video-off', !active && !videoEnabled);
    const nameTag = localContainer.querySelector('.participant-name');
    if (nameTag) {
      nameTag.textContent = active ? 'Você está apresentando' : `${userName} (Você)`;
    }
  }
}

function showScreenShareFeedback(message, duration = 0) {
  clearTimeout(screenShareFeedbackTimer);
  screenShareStatusText.textContent = message;
  stopScreenShareButton.classList.add('hidden');
  screenShareStatus.classList.remove('hidden');

  if (duration > 0) {
    screenShareFeedbackTimer = setTimeout(() => {
      if (!isScreenSharing) screenShareStatus.classList.add('hidden');
    }, duration);
  }
}

async function startScreenShare() {
  if (!mediaInitialized || !localStream || isScreenSharing || screenShareTransition || callEnding) return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    alert('O compartilhamento de tela não é suportado neste navegador.');
    return;
  }

  mediaRequestGeneration += 1;
  screenShareTransition = true;
  screenShareButton.disabled = true;
  setCaptureControlsLocked(true);
  showScreenShareFeedback('Escolha uma tela ou janela no navegador…');
  let displayTrackInstalled = false;

  try {
    // Precisa ser a primeira chamada assíncrona do clique para preservar a
    // ativação do usuário exigida pelo navegador.
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { max: 1920 },
        height: { max: 1080 },
        frameRate: { ideal: 15, max: 30 }
      },
      audio: false
    });

    if (callEnding) {
      displayStream.getTracks().forEach(track => track.stop());
      return;
    }

    const nextDisplayTrack = displayStream.getVideoTracks()[0];
    if (!nextDisplayTrack) {
      throw new Error('O navegador não retornou uma faixa de tela.');
    }

    cameraVideoTrack = cameraVideoTrack || localStream?.getVideoTracks()[0] || null;
    displayVideoTrack = nextDisplayTrack;
    displayVideoTrack.contentHint = 'detail';
    displayVideoTrack.addEventListener('ended', () => {
      const restoreCamera = () => {
        if (callEnding) return;
        if (screenShareTransition) {
          setTimeout(restoreCamera, 100);
          return;
        }
        void stopScreenShare();
      };
      restoreCamera();
    }, { once: true });

    await replaceLocalVideoTrack(displayVideoTrack);
    displayTrackInstalled = true;
    if (callEnding) {
      displayVideoTrack.stop();
      displayVideoTrack = null;
      return;
    }
    isScreenSharing = true;

    const localVideo = document.getElementById('video-local');
    if (localVideo) {
      localVideo.srcObject = localStream;
      void localVideo.play().catch(() => {});
    }

    setScreenShareUi(true);
    updateMediaStatus(audioEnabled, true, true);
  } catch (error) {
    if (displayTrackInstalled && !callEnding) {
      try {
        await replaceLocalVideoTrack(cameraVideoTrack);
      } catch (rollbackError) {
        console.error('Não foi possível restaurar a câmera após a falha da apresentação:', rollbackError);
        try {
          await replaceLocalVideoTrack(null);
        } catch (removeError) {
          console.error('Não foi possível remover a faixa de tela após a falha:', removeError);
        }
        cameraVideoTrack?.stop();
        cameraVideoTrack = null;
        videoEnabled = false;
        updateVideoButtonUi();
      }
    }
    displayVideoTrack?.stop();
    displayVideoTrack = null;
    isScreenSharing = false;
    if (!callEnding) {
      setScreenShareUi(false);
      updateMediaStatus(audioEnabled, videoEnabled, false);
      const localVideo = document.getElementById('video-local');
      if (localVideo) {
        localVideo.srcObject = localStream;
        void localVideo.play().catch(() => {});
      }
    }
    if (!callEnding) {
      console.warn('Compartilhamento de tela não iniciado:', error.name, error.message);
      const selectionWasCancelled = error.name === 'NotAllowedError' || error.name === 'AbortError';
      showScreenShareFeedback(
        selectionWasCancelled
          ? 'Compartilhamento não iniciado.'
          : 'Não foi possível compartilhar. Verifique a permissão do navegador.',
        3600
      );
    }
  } finally {
    screenShareTransition = false;
    updateCallMediaControls();
  }
}

async function acquireCameraStreamForRestore() {
  const selectedCameraId = cameraSelect.value || undefined;
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: getCameraVideoConstraints(selectedCameraId),
      audio: false
    });
  } catch (error) {
    const selectedDeviceUnavailable = selectedCameraId
      && (error.name === 'NotFoundError' || error.name === 'OverconstrainedError');
    if (!selectedDeviceUnavailable) throw error;

    return navigator.mediaDevices.getUserMedia({
      video: getCameraVideoConstraints(),
      audio: false
    });
  }
}

async function stopScreenShare() {
  if (callEnding) {
    displayVideoTrack?.stop();
    displayVideoTrack = null;
    isScreenSharing = false;
    return;
  }
  if ((!isScreenSharing && !displayVideoTrack) || screenShareTransition) return;

  screenShareTransition = true;
  screenShareButton.disabled = true;
  setCaptureControlsLocked(true);
  const trackToStop = displayVideoTrack;
  let acquiredCameraStream = null;
  let trackToRestore = cameraVideoTrack;

  try {
    if (!trackToRestore || trackToRestore.readyState === 'ended') {
      acquiredCameraStream = await acquireCameraStreamForRestore();
      if (callEnding) {
        acquiredCameraStream.getTracks().forEach(track => track.stop());
        return;
      }
      trackToRestore = acquiredCameraStream.getVideoTracks()[0] || null;
      if (trackToRestore) trackToRestore.contentHint = 'motion';
    }

    if (callEnding) {
      acquiredCameraStream?.getTracks().forEach(track => track.stop());
      return;
    }
    if (trackToRestore) trackToRestore.enabled = videoEnabled;
    await replaceLocalVideoTrack(trackToRestore);
    if (callEnding) {
      trackToRestore?.stop();
      trackToStop?.stop();
      return;
    }
    cameraVideoTrack = trackToRestore;
    isScreenSharing = false;
    displayVideoTrack = null;
    trackToStop?.stop();

    const localVideo = document.getElementById('video-local');
    if (localVideo) {
      localVideo.srcObject = localStream;
      void localVideo.play().catch(() => {});
    }

    setScreenShareUi(false);
    updateMediaStatus(audioEnabled, videoEnabled, false);
  } catch (error) {
    if (acquiredCameraStream && !localStream?.getTracks().includes(trackToRestore)) {
      acquiredCameraStream.getTracks().forEach(track => track.stop());
    }
    if (callEnding) {
      trackToStop?.stop();
      return;
    }
    console.error('Não foi possível restaurar a câmera após a apresentação:', error);
    try {
      await replaceLocalVideoTrack(null);
    } catch (replaceError) {
      console.error('Não foi possível remover a faixa de apresentação:', replaceError);
    }
    isScreenSharing = false;
    displayVideoTrack = null;
    videoEnabled = false;
    trackToStop?.stop();
    setScreenShareUi(false);
    updateVideoButtonUi();
    updateMediaStatus(audioEnabled, false, false);
    alert('A apresentação terminou, mas a câmera não pôde ser restaurada.');
  } finally {
    screenShareTransition = false;
    updateCallMediaControls();
  }
}

function updateVideoButtonUi() {
  toggleVideoButton.innerHTML = videoEnabled
    ? '<i class="fas fa-video" aria-hidden="true"></i>'
    : '<i class="fas fa-video-slash" aria-hidden="true"></i>';
  toggleVideoButton.classList.toggle('disabled', !videoEnabled);
  toggleVideoButton.setAttribute('aria-pressed', String(videoEnabled));
  toggleVideoButton.setAttribute('aria-label', 'Câmera');
  toggleVideoButton.title = videoEnabled ? 'Desativar câmera' : 'Ativar câmera';
}

// Event Listeners
toggleAudioButton.addEventListener('click', async () => {
  if (!mediaInitialized || !localStream || callEnding) return;
  const nextAudioEnabled = !audioEnabled;

  try {
    await setLocalAudioEnabled(nextAudioEnabled);
    audioEnabled = nextAudioEnabled;
  } catch (error) {
    console.error('Não foi possível atualizar o envio de áudio:', error);
    return;
  }

  toggleAudioButton.innerHTML = audioEnabled
    ? '<i class="fas fa-microphone" aria-hidden="true"></i>'
    : '<i class="fas fa-microphone-slash" aria-hidden="true"></i>';
  toggleAudioButton.classList.toggle('disabled', !audioEnabled);
  toggleAudioButton.setAttribute('aria-pressed', String(audioEnabled));
  toggleAudioButton.setAttribute('aria-label', 'Microfone');
  toggleAudioButton.title = audioEnabled ? 'Desativar microfone' : 'Ativar microfone';
  
  // Atualizar status no container de vídeo local
  const micStatus = document.querySelector('#container-local .mic-status');
  if (micStatus) {
    micStatus.innerHTML = audioEnabled
      ? '<i class="fas fa-microphone" aria-hidden="true"></i>'
      : '<i class="fas fa-microphone-slash" aria-hidden="true"></i>';
    micStatus.classList.toggle('disabled', !audioEnabled);
  }
  
  // Enviar status atualizado para outros participantes
  updateMediaStatus(audioEnabled, isScreenSharing || videoEnabled, isScreenSharing);
});

toggleVideoButton.addEventListener('click', () => {
  if (!mediaInitialized || !localStream || isScreenSharing || screenShareTransition || callEnding) return;
  videoEnabled = !videoEnabled;
  if (cameraVideoTrack) cameraVideoTrack.enabled = videoEnabled;
  localStream.getVideoTracks().forEach(track => { track.enabled = videoEnabled; });
  updateVideoButtonUi();
  
  // Atualizar visual do container de vídeo local
  const container = document.getElementById('container-local');
  if (container) {
    container.classList.toggle('video-off', !videoEnabled);
  }
  
  // Enviar status atualizado para outros participantes
  updateMediaStatus(audioEnabled, videoEnabled, false);
});

function endLocalCall() {
  if (callEnding) return;
  callEnding = true;
  mediaRequestGeneration++;
  clearTimeout(deviceChangeTimer);
  clearTimeout(mediaRecoveryTimer);
  isScreenSharing = false;
  screenShareTransition = false;
  mediaInitialized = false;
  updateCallMediaControls();

  const activeTracks = new Set(localStream?.getTracks() || []);
  activeTracks.forEach(track => track.stop());
  if (displayVideoTrack && !activeTracks.has(displayVideoTrack)) displayVideoTrack.stop();
  if (cameraVideoTrack && !activeTracks.has(cameraVideoTrack)) cameraVideoTrack.stop();
  displayVideoTrack = null;
  cameraVideoTrack = null;
  disconnect();
  localStream = undefined;
}

leaveButton.addEventListener('click', () => {
  endLocalCall();
  window.location.href = 'index.html';
});

window.addEventListener('pagehide', endLocalCall);
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    window.location.reload();
  } else {
    scheduleMediaRecovery(600);
  }
});

function markPageInactive() {
  if (!pageInactiveAt) pageInactiveAt = Date.now();
  clearTimeout(mediaRecoveryTimer);
}

function handlePageResume() {
  if (document.visibilityState === 'hidden' || callEnding) return;
  const interruptionWasLong = isMobileDevice()
    && pageInactiveAt > 0
    && Date.now() - pageInactiveAt > 1500;
  pageInactiveAt = 0;
  scheduleMediaRecovery(600, interruptionWasLong);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    markPageInactive();
  } else {
    handlePageResume();
  }
});
window.addEventListener('blur', markPageInactive);
window.addEventListener('focus', handlePageResume);

// Repetir em cada interação é intencional: participantes podem chegar depois
// do primeiro toque e navegadores móveis podem revogar a tentativa anterior.
document.addEventListener('pointerdown', event => {
  if (!enableRemoteAudioButton.contains(event.target)) {
    void enableRemoteAudio();
  }
});
enableRemoteAudioButton.addEventListener('click', () => { void enableRemoteAudio(); });

// Mostrar/ocultar menus de configurações
audioSettingsButton.addEventListener('click', (e) => {
  e.stopPropagation();
  videoSettingsMenu.classList.add('hidden');
  audioSettingsMenu.classList.toggle('hidden');
  audioSettingsButton.setAttribute('aria-expanded', String(!audioSettingsMenu.classList.contains('hidden')));
  videoSettingsButton.setAttribute('aria-expanded', 'false');
});

videoSettingsButton.addEventListener('click', (e) => {
  e.stopPropagation();
  audioSettingsMenu.classList.add('hidden');
  videoSettingsMenu.classList.toggle('hidden');
  videoSettingsButton.setAttribute('aria-expanded', String(!videoSettingsMenu.classList.contains('hidden')));
  audioSettingsButton.setAttribute('aria-expanded', 'false');
});

// Fechar menus quando clicar fora deles
document.addEventListener('click', (e) => {
  if (!audioSettingsMenu.contains(e.target) && e.target !== audioSettingsButton) {
    audioSettingsMenu.classList.add('hidden');
    audioSettingsButton.setAttribute('aria-expanded', 'false');
  }
  if (!videoSettingsMenu.contains(e.target) && e.target !== videoSettingsButton) {
    videoSettingsMenu.classList.add('hidden');
    videoSettingsButton.setAttribute('aria-expanded', 'false');
  }
});

document.addEventListener('keydown', event => {
  const shareDialogIsOpen = !shareDialog.classList.contains('hidden');
  if (shareDialogIsOpen && event.key === 'Tab') {
    const focusableElements = Array.from(shareDialog.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
    )).filter(element => element.getClientRects().length > 0);
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (!firstElement) return;
    if (event.shiftKey && (document.activeElement === firstElement || !shareDialog.contains(document.activeElement))) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && (document.activeElement === lastElement || !shareDialog.contains(document.activeElement))) {
      event.preventDefault();
      firstElement.focus();
    }
    return;
  }

  if (event.key === 'Escape') {
    const audioSettingsWereOpen = !audioSettingsMenu.classList.contains('hidden');
    const videoSettingsWereOpen = !videoSettingsMenu.classList.contains('hidden');
    audioSettingsMenu.classList.add('hidden');
    videoSettingsMenu.classList.add('hidden');
    audioSettingsButton.setAttribute('aria-expanded', 'false');
    videoSettingsButton.setAttribute('aria-expanded', 'false');
    if (shareDialogIsOpen) {
      closeShareDialog();
    } else if (audioSettingsWereOpen) {
      audioSettingsButton.focus();
    } else if (videoSettingsWereOpen) {
      videoSettingsButton.focus();
    }
  }
});

// Selecionar dispositivos, persistindo apenas depois que a captura foi aplicada.
async function applyCaptureDeviceSelection(kind) {
  const changeGeneration = ++captureDeviceChangeGeneration;
  const select = kind === 'camera' ? cameraSelect : microphoneSelect;
  const storageKey = kind === 'camera'
    ? 'agoraone:camera-id'
    : 'agoraone:microphone-id';
  const requestedDeviceId = select.value;

  try {
    await startLocalStream(cameraSelect.value, microphoneSelect.value);
    if (changeGeneration !== captureDeviceChangeGeneration || callEnding) return;
    localStorage.setItem(storageKey, requestedDeviceId);
  } catch (error) {
    if (changeGeneration !== captureDeviceChangeGeneration || callEnding) return;
    console.warn(`Não foi possível usar o dispositivo de ${kind === 'camera' ? 'vídeo' : 'áudio'} selecionado:`, error);
    await updateDeviceList(false);
  }
}

cameraSelect.addEventListener('change', () => {
  void applyCaptureDeviceSelection('camera');
});

microphoneSelect.addEventListener('change', () => {
  void applyCaptureDeviceSelection('microphone');
});

speakerSelect.addEventListener('change', async () => {
  const requestedSpeakerId = speakerSelect.value;
  const previousSpeakerId = localStorage.getItem('agoraone:speaker-id') || '';
  const remoteVideos = document.querySelectorAll('video[data-remote-video="true"]');
  const results = await Promise.all(
    Array.from(remoteVideos, video => applySelectedAudioOutput(video, requestedSpeakerId))
  );

  if (results.every(Boolean)) {
    localStorage.setItem('agoraone:speaker-id', requestedSpeakerId);
    return;
  }

  const fallbackOption = Array.from(speakerSelect.options).find(option => (
    option.value === previousSpeakerId
  )) || speakerSelect.options[0];
  if (fallbackOption) speakerSelect.value = fallbackOption.value;
  await Promise.all(Array.from(
    remoteVideos,
    video => applySelectedAudioOutput(video, speakerSelect.value)
  ));
});

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  clearTimeout(deviceChangeTimer);
  deviceChangeTimer = setTimeout(async () => {
    if (callEnding) return;

    await updateDeviceList(false);
    if (isScreenSharing || screenShareTransition || callEnding) return;

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameraIds = new Set(
        devices.filter(device => device.kind === 'videoinput').map(device => device.deviceId)
      );
      const microphoneIds = new Set(
        devices.filter(device => device.kind === 'audioinput').map(device => device.deviceId)
      );
      const videoTrack = cameraVideoTrack || localStream?.getVideoTracks()[0];
      const audioTrack = localStream?.getAudioTracks()[0];
      const videoDeviceId = videoTrack?.getSettings().deviceId;
      const audioDeviceId = audioTrack?.getSettings().deviceId;
      const captureIsUnavailable = !videoTrack
        || videoTrack.readyState === 'ended'
        || !audioTrack
        || audioTrack.readyState === 'ended'
        || (videoDeviceId && !cameraIds.has(videoDeviceId))
        || (audioDeviceId && !microphoneIds.has(audioDeviceId));

      if (captureIsUnavailable) scheduleMediaRecovery(100, true);
    } catch (error) {
      console.warn('Não foi possível verificar a troca de dispositivos:', error);
    }
  }, 300);
});

// Compartilhar link da reunião
shareButton.addEventListener('click', () => {
  shareDialog.classList.remove('hidden');
  copyFeedback.textContent = '';
  closeShareIconButton.focus();
  meetContainer.inert = true;
  meetContainer.setAttribute('aria-hidden', 'true');
});

copyLinkButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(meetingLinkInput.value);
  } catch {
    meetingLinkInput.select();
    document.execCommand('copy');
  }

  copyLinkButton.innerHTML = '<i class="fas fa-check" aria-hidden="true"></i><span>Copiado</span>';
  copyFeedback.textContent = 'Link copiado para a área de transferência.';
  setTimeout(() => {
    copyLinkButton.innerHTML = '<i class="fas fa-copy" aria-hidden="true"></i><span>Copiar</span>';
    copyFeedback.textContent = '';
  }, 2000);
});

function closeShareDialog() {
  shareDialog.classList.add('hidden');
  meetContainer.inert = false;
  meetContainer.removeAttribute('aria-hidden');
  shareButton.focus();
}

closeShareButton.addEventListener('click', closeShareDialog);
closeShareIconButton.addEventListener('click', closeShareDialog);

shareDialog.addEventListener('click', (e) => {
  if (e.target === shareDialog) {
    closeShareDialog();
  }
});

screenShareButton.addEventListener('click', () => {
  if (isScreenSharing) {
    void stopScreenShare();
  } else {
    void startScreenShare();
  }
});

stopScreenShareButton.addEventListener('click', () => { void stopScreenShare(); });

window.addEventListener('signaling-state', (event) => {
  if (!connectionStatus || !connectionStatusText || !connectionStatusIcon) return;

  const { state } = event.detail;
  connectionStatus.dataset.state = state;

  if (state === 'connected') {
    connectionStatus.classList.add('hidden');
    return;
  }

  connectionStatus.classList.remove('hidden');
  if (state === 'unavailable') {
    connectionStatusIcon.className = 'fas fa-exclamation-triangle';
    connectionStatusText.textContent = 'Sinalização indisponível. Nova tentativa em instantes…';
    return;
  }

  connectionStatusIcon.className = 'fas fa-circle-notch fa-spin';
  connectionStatusText.textContent = state === 'reconnecting'
    ? 'Reconectando à sala…'
    : 'Conectando à sala…';
});

// Garantir que o evento DOMContentLoaded seja disparado antes de inicializar
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM carregado, verificando elementos críticos:');
  console.log('- toggleAudioButton:', toggleAudioButton ? 'OK' : 'Não encontrado');
  console.log('- toggleVideoButton:', toggleVideoButton ? 'OK' : 'Não encontrado');
  console.log('- mainVideoContainer:', mainVideoContainer ? 'OK' : 'Não encontrado');
  console.log('- pipContainer:', pipContainer ? 'OK' : 'Não encontrado');
  
  updateCallMediaControls();
  if (!navigator.mediaDevices?.getDisplayMedia) {
    screenShareButton.title = 'Compartilhamento de tela não suportado neste navegador';
    screenShareButton.setAttribute('aria-label', 'Compartilhar tela (indisponível)');
  }
  updateVideoButtonUi();

  // Inicializar a aplicação
  void init();
});

// Ouvir eventos de status de mídia remota
window.addEventListener('remote-media-status', (event) => {
  const { peerId, audio, video, screenSharing = false } = event.detail;
  const state = { audio, video, screenSharing };
  remoteMediaStates.set(peerId, state);
  const container = document.getElementById(`container-${peerId}`);
  if (container) applyRemoteMediaState(container, state);
});

// Em calls.js, adicionar esse listener
window.addEventListener('video-active', (event) => {
  const { peerId } = event.detail;
  const container = document.getElementById(`container-${peerId}`);
  if (container) {
    container.classList.add('video-active');
    container.classList.remove('video-off');
  }
});

window.addEventListener('remote-peer-removed', event => {
  if (event.detail?.peerId) remoteMediaStates.delete(event.detail.peerId);
  updateRemoteAudioPrompt();
  ensureStageVideo();
});

window.addEventListener('room-participants', (event) => {
  const count = event.detail.users.length;
  const label = `${count} ${count === 1 ? 'participante' : 'participantes'}`;
  const visualLabel = participantCountElement.querySelector('.participant-count-visual');
  const announcement = participantCountElement.querySelector('.participant-count-announcement');
  if (visualLabel) visualLabel.textContent = label;
  if (announcement) announcement.textContent = label;
  participantCountElement.dataset.count = String(count);
});

