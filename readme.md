# AgoraOne

**AgoraOne — one place to meet.**

AgoraOne é uma aplicação de videochamadas no navegador. O nome une a ideia da ágora — um lugar de encontro e discussão — à simplicidade de reunir todo mundo em um único link.

## Funcionalidades

- Salas instantâneas com link compartilhável
- Áudio e vídeo em tempo real via WebRTC
- Participante remoto no palco e câmera local em picture-in-picture
- Compartilhamento de tela
- Controles de microfone, câmera e dispositivos
- Retomada de captura e reprodução após interrupções no celular
- Interface responsiva para desktop e celular
- Presença resiliente a recarregamentos da página

## Arquitetura

- **index.html** e **index.js**: criação e entrada em salas
- **calls.html** e **calls.js**: interface e controles da reunião
- **webrtc.js**: conexões peer-to-peer, sinalização e estado de mídia
- **styles.css**: identidade visual e layout responsivo
- **worker.js**: serviço de sinalização em Cloudflare Workers, com estado compartilhado no Turso

O frontend usa HTML, CSS e JavaScript nativos, com Bootstrap 5, Font Awesome 5 e webrtc-adapter.

## Execução local

Sirva o diretório por HTTPS ou por localhost, requisito das APIs de câmera, microfone e compartilhamento de tela. Em uma instalação XAMPP, acesse:

    http://localhost/webrtc-meet/

## Requisitos

- Navegador moderno com WebRTC
- Câmera e microfone autorizados
- Conexão à internet para a sinalização e os servidores STUN/TURN
