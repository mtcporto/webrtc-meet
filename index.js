// Elementos DOM
const joinTab = document.getElementById('join-tab');
const createTab = document.getElementById('create-tab');
const switchToCreateBtn = document.getElementById('switch-to-create');
const switchToJoinBtn = document.getElementById('switch-to-join');
const joinForm = document.getElementById('join-form');
const createForm = document.getElementById('create-form');
const joinNameInput = document.getElementById('join-name');
const createNameInput = document.getElementById('create-name');
const roomCodeInput = document.getElementById('room-code');

function setActiveTab(tab) {
  const showCreate = tab === 'create';
  createTab.classList.toggle('active', showCreate);
  createTab.hidden = !showCreate;
  joinTab.classList.toggle('active', !showCreate);
  joinTab.hidden = showCreate;
  switchToCreateBtn.classList.toggle('active', showCreate);
  switchToCreateBtn.setAttribute('aria-selected', String(showCreate));
  switchToCreateBtn.tabIndex = showCreate ? 0 : -1;
  switchToJoinBtn.classList.toggle('active', !showCreate);
  switchToJoinBtn.setAttribute('aria-selected', String(!showCreate));
  switchToJoinBtn.tabIndex = showCreate ? -1 : 0;

  if (showCreate) {
    createNameInput.value = joinNameInput.value || localStorage.getItem('userName') || '';
  } else {
    joinNameInput.value = createNameInput.value || localStorage.getItem('userName') || '';
  }
}

switchToCreateBtn.addEventListener('click', () => setActiveTab('create'));
switchToJoinBtn.addEventListener('click', () => setActiveTab('join'));

const modeTabs = [switchToCreateBtn, switchToJoinBtn];
modeTabs.forEach((tab, index) => {
  tab.addEventListener('keydown', event => {
    let nextIndex = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % modeTabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + modeTabs.length) % modeTabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = modeTabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = modeTabs[nextIndex];
    setActiveTab(nextTab === switchToCreateBtn ? 'create' : 'join');
    nextTab.focus();
  });
});

// Preencher o nome do usuário se já estiver salvo
if (localStorage.getItem('userName')) {
  joinNameInput.value = localStorage.getItem('userName');
  createNameInput.value = localStorage.getItem('userName');
}

// Função para gerar código de sala aleatório no formato XXX-XXXX-XXX
function generateRoomCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let code = '';
  
  for (let i = 0; i < 3; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  code += '-';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  code += '-';
  for (let i = 0; i < 3; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return code;
}

function normalizeRoomCode(value) {
  const rawValue = value.trim();

  try {
    const parsedUrl = new URL(rawValue, window.location.origin);
    const queryRoom = parsedUrl.searchParams.get('room');
    if (queryRoom) {
      return queryRoom.toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    const pathRoom = parsedUrl.pathname.split('/meet/')[1];
    if (pathRoom) {
      return pathRoom.toLowerCase().replace(/[^a-z0-9]/g, '');
    }
  } catch {
    // Se não for uma URL, tratamos a entrada como código da sala.
  }

  return rawValue.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Manipular formulário de entrada
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const userName = joinNameInput.value.trim();
  const roomCode = normalizeRoomCode(roomCodeInput.value);
  
  if (!userName || !roomCode) {
    alert('Por favor, preencha todos os campos.');
    return;
  }
  
  // Salvar nome do usuário
  localStorage.setItem('userName', userName);
  
  // Sempre redirecionar para o formato simples e seguro
  window.location.href = `calls.html?room=${roomCode}`;
});

// Manipular formulário de criação
createForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const userName = createNameInput.value.trim();
  
  if (!userName) {
    alert('Por favor, digite seu nome.');
    return;
  }
  
  // Salvar nome do usuário
  localStorage.setItem('userName', userName);
  
  // Gerar código aleatório
  const roomCode = normalizeRoomCode(generateRoomCode());
  
  // Sempre redirecionar para o formato simples e seguro
  window.location.href = `calls.html?room=${roomCode}`;
});

// Verificar se há código na URL (para facilitar entrada em reuniões compartilhadas)
const urlParams = new URLSearchParams(window.location.search);
const urlCode = urlParams.get('room');
if (urlCode) {
  roomCodeInput.value = urlCode;
  setActiveTab('join');
}

// Se a URL contém código de sala no formato /meet/XXX-XXXX-XXX (para compatibilidade)
const urlPath = window.location.pathname;
if (urlPath.includes('/meet/')) {
  const pathCode = urlPath.split('/meet/')[1];
  if (pathCode) {
    roomCodeInput.value = pathCode;
    setActiveTab('join');
  }
}

document.getElementById('current-year').textContent = String(new Date().getFullYear());
