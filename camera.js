/**
 * CONTÁBIL INTELIGENTE — Camera Capture Module
 * Arquivo: camera.js
 * 
 * Permite tirar fotos diretamente da câmera no celular e
 * adicioná-las à fila de upload existente do sistema.
 *
 * Como usar:
 *   1. Inclua este script no final do <body>: <script src="/camera.js"></script>
 *   2. Adicione o HTML do modal (ver camera-modal.html) ao seu dashboard
 *   3. O módulo se integra automaticamente com o input de upload existente
 */

(function () {
  'use strict';

  // ─── Estado ────────────────────────────────────────────────────────────────
  let stream = null;
  let capturedFiles = [];         // Fotos capturadas (File objects)
  let facingMode = 'environment'; // 'environment' = câmera traseira (padrão)

  // ─── Elementos DOM ──────────────────────────────────────────────────────────
  const modal      = document.getElementById('camera-modal');
  const video      = document.getElementById('camera-video');
  const canvas     = document.getElementById('camera-canvas');
  const btnCapture = document.getElementById('btn-capture');
  const btnCancel  = document.getElementById('btn-cancel-camera');
  const btnFlip    = document.getElementById('btn-flip-camera');
  const btnOpen    = document.getElementById('btn-open-camera');
  const previewBar = document.getElementById('camera-preview-bar');
  const counter    = document.getElementById('camera-photo-count');

  // ─── Detectar suporte ───────────────────────────────────────────────────────
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const hasCamera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  // Só mostra o botão de câmera se for mobile com câmera
  if (btnOpen) {
    if (isMobile && hasCamera) {
      btnOpen.style.display = 'inline-flex';
    } else {
      btnOpen.style.display = 'none';
    }
  }

  // ─── Abrir câmera ───────────────────────────────────────────────────────────
  async function openCamera() {
    if (!modal || !video) return;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: facingMode,
          width:  { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });

      video.srcObject = stream;
      await video.play();
      modal.classList.add('active');

    } catch (err) {
      console.error('[Camera] Erro ao acessar câmera:', err);

      if (err.name === 'NotAllowedError') {
        alert('Permissão de câmera negada. Por favor, permita o acesso à câmera nas configurações do navegador.');
      } else if (err.name === 'NotFoundError') {
        alert('Nenhuma câmera encontrada neste dispositivo.');
      } else {
        alert('Não foi possível acessar a câmera: ' + err.message);
      }
    }
  }

  // ─── Fechar câmera ──────────────────────────────────────────────────────────
  function closeCamera() {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }
    if (video) video.srcObject = null;
    if (modal) modal.classList.remove('active');
  }

  // ─── Capturar foto ──────────────────────────────────────────────────────────
  function capturePhoto() {
    if (!video || !canvas) return;

    // Verificar limite de arquivos do plano
    const planLimit = getPlanLimit();
    const currentCount = getExistingFileCount() + capturedFiles.length;

    if (currentCount >= planLimit) {
      alert(`Seu plano permite até ${planLimit} arquivo(s) por análise. Remova algum arquivo para continuar.`);
      return;
    }

    // Desenhar frame do vídeo no canvas
    canvas.width  = video.videoWidth  || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');

    // Espelhar se for câmera frontal
    if (facingMode === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }

    ctx.drawImage(video, 0, 0);

    // Converter para Blob → File
    canvas.toBlob(function (blob) {
      if (!blob) return;

      const fileName = `foto_${Date.now()}.jpg`;
      const file = new File([blob], fileName, { type: 'image/jpeg' });

      capturedFiles.push(file);
      addPreviewThumb(blob, capturedFiles.length - 1);
      updateCounter();

      // Feedback visual (flash)
      flashEffect();

    }, 'image/jpeg', 0.9);
  }

  // ─── Virar câmera ───────────────────────────────────────────────────────────
  async function flipCamera() {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';

    if (stream) {
      stream.getTracks().forEach(t => t.stop());
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facingMode },
        audio: false
      });
      video.srcObject = stream;
      await video.play();
    } catch (err) {
      console.warn('[Camera] Falha ao virar câmera:', err);
      facingMode = facingMode === 'user' ? 'environment' : 'user'; // revert
    }
  }

  // ─── Preview thumbnail ──────────────────────────────────────────────────────
  function addPreviewThumb(blob, index) {
    if (!previewBar) return;

    const url = URL.createObjectURL(blob);
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;display:inline-block;';

    const img = document.createElement('img');
    img.src = url;
    img.alt = `Foto ${index + 1}`;
    img.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:6px;border:2px solid #1a56db;';

    // Botão remover
    const btnRemove = document.createElement('button');
    btnRemove.innerHTML = '×';
    btnRemove.title = 'Remover foto';
    btnRemove.style.cssText = `
      position:absolute;top:-6px;right:-6px;
      width:20px;height:20px;border-radius:50%;
      background:#ef4444;color:#fff;border:none;
      font-size:14px;line-height:1;cursor:pointer;
      display:flex;align-items:center;justify-content:center;
    `;
    btnRemove.onclick = function () {
      capturedFiles.splice(index, 1);
      URL.revokeObjectURL(url);
      wrapper.remove();
      rebuildPreviewIndices();
      updateCounter();
    };

    wrapper.appendChild(img);
    wrapper.appendChild(btnRemove);
    previewBar.appendChild(wrapper);
  }

  function rebuildPreviewIndices() {
    // Reindexar após remoção
    const wrappers = previewBar ? previewBar.querySelectorAll('div') : [];
    wrappers.forEach((w, i) => {
      const btn = w.querySelector('button');
      if (btn) {
        btn.onclick = function () {
          capturedFiles.splice(i, 1);
          w.remove();
          rebuildPreviewIndices();
          updateCounter();
        };
      }
    });
  }

  // ─── Confirmar fotos e enviar ao sistema ────────────────────────────────────
  function confirmPhotos() {
    if (capturedFiles.length === 0) {
      closeCamera();
      return;
    }

    // Injeta as fotos no input[type=file] existente OU na fila de upload
    injectFilesIntoUpload(capturedFiles);

    closeCamera();
    capturedFiles = [];
    if (previewBar) previewBar.innerHTML = '';
    updateCounter();
  }

  /**
   * Injeta File objects no sistema de upload do dashboard.
   * Tenta três estratégias, na ordem:
   * 1. DataTransfer API (moderna — funciona na maioria dos browsers mobile)
   * 2. Dispara evento customizado 'camera:files' que o seu código pode ouvir
   * 3. Chama função global `onCameraFiles` se existir
   */
  function injectFilesIntoUpload(files) {
    // Estratégia 1: DataTransfer → input[type=file]
    const fileInput = document.querySelector(
      'input[type="file"], #file-input, #upload-input, [data-upload]'
    );

    if (fileInput && typeof DataTransfer !== 'undefined') {
      try {
        const dt = new DataTransfer();

        // Manter arquivos já selecionados
        if (fileInput.files) {
          Array.from(fileInput.files).forEach(f => dt.items.add(f));
        }

        files.forEach(f => dt.items.add(f));
        fileInput.files = dt.files;

        // Disparar evento change para o listener existente detectar
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[Camera] Fotos injetadas via DataTransfer:', files.length);
        return;
      } catch (e) {
        console.warn('[Camera] DataTransfer falhou, tentando evento customizado:', e);
      }
    }

    // Estratégia 2: Evento customizado
    document.dispatchEvent(new CustomEvent('camera:files', {
      detail: { files: files },
      bubbles: true
    }));
    console.log('[Camera] Evento camera:files disparado com', files.length, 'arquivo(s)');

    // Estratégia 3: Callback global
    if (typeof window.onCameraFiles === 'function') {
      window.onCameraFiles(files);
    }
  }

  // ─── Utilitários ────────────────────────────────────────────────────────────
  function getPlanLimit() {
    // Lê o plano do usuário da página — adapte ao seu atributo/variável
    const planEl = document.querySelector('[data-plan]');
    if (planEl) {
      const plan = planEl.dataset.plan;
      if (plan === 'plus') return 6;
    }
    // Fallback: tenta variável global
    if (window.userPlan === 'plus') return 6;
    return 2; // Básico
  }

  function getExistingFileCount() {
    const fileInput = document.querySelector('input[type="file"]');
    return fileInput ? (fileInput.files ? fileInput.files.length : 0) : 0;
  }

  function updateCounter() {
    if (!counter) return;
    const total = getExistingFileCount() + capturedFiles.length;
    const limit = getPlanLimit();
    counter.textContent = `${total}/${limit} arquivo(s)`;
    counter.style.color = total >= limit ? '#ef4444' : 'inherit';
  }

  function flashEffect() {
    const flash = document.createElement('div');
    flash.style.cssText = `
      position:fixed;inset:0;background:#fff;
      z-index:999999;opacity:0.7;pointer-events:none;
      animation:cameraFlash 0.25s ease-out forwards;
    `;
    if (!document.getElementById('camera-flash-style')) {
      const style = document.createElement('style');
      style.id = 'camera-flash-style';
      style.textContent = `@keyframes cameraFlash{0%{opacity:.7}100%{opacity:0}}`;
      document.head.appendChild(style);
    }
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 300);
  }

  // ─── Event listeners ────────────────────────────────────────────────────────
  if (btnOpen)    btnOpen.addEventListener('click', openCamera);
  if (btnCancel)  btnCancel.addEventListener('click', closeCamera);
  if (btnCapture) btnCapture.addEventListener('click', capturePhoto);
  if (btnFlip)    btnFlip.addEventListener('click', flipCamera);

  // Botão "Usar fotos" (fechar e confirmar)
  const btnConfirm = document.getElementById('btn-confirm-camera');
  if (btnConfirm) btnConfirm.addEventListener('click', confirmPhotos);

  // Fechar ao clicar fora do conteúdo
  if (modal) {
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeCamera();
    });
  }

  // Fechar com ESC
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal && modal.classList.contains('active')) {
      closeCamera();
    }
  });

  // ─── Sidebar mobile (hamburger) ──────────────────────────────────────────────
  const hamburger = document.querySelector('.hamburger, .menu-toggle, .btn-menu, #btn-menu');
  const sidebar   = document.querySelector('.sidebar, .side-nav, #sidebar');
  const overlay   = document.querySelector('.sidebar-overlay, #sidebar-overlay');

  if (hamburger && sidebar) {
    hamburger.addEventListener('click', function () {
      sidebar.classList.toggle('open');
      if (overlay) overlay.classList.toggle('active');
    });
  }

  if (overlay) {
    overlay.addEventListener('click', function () {
      if (sidebar) sidebar.classList.remove('open');
      overlay.classList.remove('active');
    });
  }

  // ─── Expor API pública ───────────────────────────────────────────────────────
  window.CameraCapture = {
    open:    openCamera,
    close:   closeCamera,
    capture: capturePhoto,
    flip:    flipCamera,
    confirm: confirmPhotos,
    getFiles: function () { return [...capturedFiles]; }
  };

  console.log('[Contábil Inteligente] camera.js carregado. Mobile:', isMobile, '| Câmera:', hasCamera);

})();
