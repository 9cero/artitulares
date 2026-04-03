// ── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  SUPABASE_URL:      'https://lgwyjuiurxjdcwkluykw.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxnd3lqdWl1cnhqZGN3a2x1eWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNzY3NjUsImV4cCI6MjA5MDY1Mjc2NX0.VFa1QhGWyp2HCgY0MttgQRlRUc6cY-51VitrVmpVoIo',
  EDGE_URL:          'https://lgwyjuiurxjdcwkluykw.supabase.co/functions/v1/smart-handler',
}

// ── DOM ─────────────────────────────────────────────────────
const welcome      = document.getElementById('welcome')
const welcomeNombre= document.getElementById('welcome-nombre')
const welcomeBtn   = document.getElementById('welcome-btn')
const usuarioLabel = document.getElementById('usuario-label')
const video        = document.getElementById('video')
const canvas       = document.getElementById('canvas')
const overlay      = document.getElementById('overlay')
const btnScan      = document.getElementById('btn-scan')
const btnClear     = document.getElementById('btn-clear')
const btnCamara    = document.getElementById('btn-camara')
const statusEl     = document.getElementById('status')
const progressBar  = document.getElementById('progress-bar')
const lista        = document.getElementById('lista')
const listaItems   = document.getElementById('lista-items')
const panel        = document.getElementById('panel')
const panelTitular = document.getElementById('panel-titular')
const panelComents = document.getElementById('panel-comentarios')
const panelClose   = document.getElementById('panel-close')
const inputComent  = document.getElementById('input-comentario')
const btnEnviar    = document.getElementById('btn-enviar')
const toastEl      = document.getElementById('toast')

// ── Estado ──────────────────────────────────────────────────
let titularActivo  = null
let streamActual   = null
let camaraFrente   = false
let usuario        = localStorage.getItem('ar_usuario') || ''

const sbHeaders = {
  'Content-Type':  'application/json',
  'apikey':        CONFIG.SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`
}

// ── Welcome / Usuario ────────────────────────────────────────
function initUsuario() {
  if (usuario) {
    welcome.classList.add('hidden')
    usuarioLabel.textContent = usuario
    initCamara()
  } else {
    welcome.classList.remove('hidden')
    welcomeNombre.focus()
  }
}

welcomeBtn.addEventListener('click', () => {
  const nombre = welcomeNombre.value.trim()
  if (!nombre) { welcomeNombre.focus(); return }
  usuario = nombre
  localStorage.setItem('ar_usuario', usuario)
  welcome.classList.add('hidden')
  usuarioLabel.textContent = usuario
  initCamara()
})

welcomeNombre.addEventListener('keydown', e => {
  if (e.key === 'Enter') welcomeBtn.click()
})

// ── Cámara ──────────────────────────────────────────────────
async function initCamara() {
  if (streamActual) {
    streamActual.getTracks().forEach(t => t.stop())
  }
  try {
    streamActual = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: camaraFrente ? 'user' : 'environment',
        width: { ideal: 1280 }
      },
      audio: false
    })
    video.srcObject = streamActual
    btnScan.disabled = false
    setStatus('listo')
  } catch {
    setStatus('sin cámara', 'error')
  }
}

btnCamara.addEventListener('click', () => {
  camaraFrente = !camaraFrente
  initCamara()
})

// ── Captura ─────────────────────────────────────────────────
function capturarCanvas() {
  canvas.width  = video.videoWidth
  canvas.height = video.videoHeight
  canvas.getContext('2d').drawImage(video, 0, 0)
  return canvas
}

function capturarBase64() {
  capturarCanvas()
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1]
}

// ── OCR via Edge Function ────────────────────────────────────
async function ocrEdge(imageBase64) {
  const res = await fetch(CONFIG.EDGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`
    },
    body: JSON.stringify({ image: imageBase64 })
  })
  if (!res.ok) throw new Error(`Error ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data.titulares || []
}

// ── Hash ────────────────────────────────────────────────────
function normalizar(texto) {
  return texto.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
}

async function hashTexto(texto) {
  const data = new TextEncoder().encode(normalizar(texto))
  const buf  = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('').slice(0, 16)
}

// ── Supabase ────────────────────────────────────────────────
async function buscarComentarios(hashes) {
  if (!hashes.length) return []
  const resultados = await Promise.all(
    hashes.map(h =>
      fetch(`${CONFIG.SUPABASE_URL}/rest/v1/comentarios?titular_hash=eq.${h}&order=created_at.asc`, { headers: sbHeaders })
        .then(r => r.ok ? r.json() : [])
    )
  )
  return resultados.flat()
}

async function guardarComentario(hash, texto, comentario) {
  const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/comentarios`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      titular_hash:  hash,
      titular_texto: texto,
      comentario,
      autor: usuario
    })
  })
  return res.ok
}

async function borrarComentario(id) {
  const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/comentarios?id=eq.${id}`, {
    method: 'DELETE',
    headers: sbHeaders
  })
  return res.ok
}

// ── Overlay AR ──────────────────────────────────────────────
function renderOverlay(titulares) {
  overlay.innerHTML = ''
  const viewerRect = video.getBoundingClientRect()
  const scaleX = viewerRect.width  / canvas.width
  const scaleY = viewerRect.height / canvas.height

  titulares.forEach(t => {
    if (!t.boundingBox) return
    const { x, y, w, h } = t.boundingBox
    const box = document.createElement('div')
    box.className = 'ar-box'
    box.style.cssText = `
      left:   ${x * scaleX}px;
      top:    ${y * scaleY}px;
      width:  ${w * scaleX}px;
      height: ${h * scaleY}px;
    `
    overlay.appendChild(box)
  })
}

// ── Escanear ────────────────────────────────────────────────
btnScan.addEventListener('click', async () => {
  btnScan.disabled = true
  btnScan.textContent = 'PROCESANDO...'
  lista.classList.remove('visible')
  overlay.innerHTML = ''
  progressBar.style.width = '30%'
  setStatus('procesando...', 'activo')

  try {
    const imageBase64 = capturarBase64()
    let titulares = await ocrEdge(imageBase64)

    progressBar.style.width = '70%'

    if (titulares.length) {
      const hashes = titulares.map(t => t.hash).filter(Boolean)
      if (hashes.length) {
        const comentarios = await buscarComentarios(hashes)
        titulares = titulares.map(t => ({
          ...t,
          comentarios: comentarios.filter(c => c.titular_hash === t.hash)
        }))
      }
    }

    if (!titulares.length) {
      setStatus('sin titulares detectados')
      listaItems.innerHTML = '<div style="padding:16px;color:#555;font-size:13px">No se detectaron titulares. Acercate más al diario.</div>'
    } else {
      setStatus(`${titulares.length} titular${titulares.length > 1 ? 'es' : ''}`, 'activo')
      renderOverlay(titulares)

      listaItems.innerHTML = ''
      titulares.forEach(t => {
        const count = t.comentarios?.length || 0
        const div   = document.createElement('div')
        div.className = 'titular-item'
        div.innerHTML = `
          <div class="titular-texto">${t.texto}</div>
          <div class="titular-badge">💬 ${count}</div>
        `
        div.addEventListener('click', () => abrirPanel(t))
        listaItems.appendChild(div)
      })
    }

    lista.classList.add('visible')
    progressBar.style.width = '100%'

  } catch (err) {
    setStatus('error: ' + err.message, 'error')
    console.error(err)
  } finally {
    btnScan.disabled = false
    btnScan.textContent = 'ESCANEAR'
    setTimeout(() => progressBar.style.width = '0%', 800)
  }
})

// ── Panel ────────────────────────────────────────────────────
function abrirPanel(titular) {
  titularActivo = titular
  panelTitular.textContent = titular.texto
  renderComentarios(titular.comentarios || [])
  inputComent.value = ''
  panel.classList.add('visible')
}

function formatFecha(iso) {
  const d = new Date(iso)
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) +
    ' ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
}

function renderComentarios(lista) {
  if (!lista.length) {
    panelComents.innerHTML = '<div class="sin-comentarios">Sin comentarios aún. ¡Sé el primero!</div>'
    return
  }
  panelComents.innerHTML = lista.map(c => `
    <div class="comentario-item" data-id="${c.id}">
      <div class="comentario-body">
        <div class="comentario-autor">
          ${c.autor || 'anon'}
          <span class="comentario-fecha">${formatFecha(c.created_at)}</span>
        </div>
        <div class="comentario-texto">${c.comentario}</div>
      </div>
      ${c.autor === usuario ? `<button class="btn-borrar" data-id="${c.id}" title="Borrar">✕</button>` : ''}
    </div>
  `).join('')

  // Eventos borrar
  panelComents.querySelectorAll('.btn-borrar').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id
      const ok = await borrarComentario(id)
      if (ok) {
        titularActivo.comentarios = titularActivo.comentarios.filter(c => c.id !== id)
        renderComentarios(titularActivo.comentarios)
        toast('Comentario borrado')
      }
    })
  })
}

function cerrarPanel() {
  panel.classList.remove('visible')
  titularActivo = null
}

// ── Enviar comentario ────────────────────────────────────────
btnEnviar.addEventListener('click', async () => {
  if (!titularActivo) return
  const comentario = inputComent.value.trim()
  if (!comentario) return

  btnEnviar.disabled    = true
  btnEnviar.textContent = '...'

  const hash = titularActivo.hash || await hashTexto(titularActivo.texto)
  const ok   = await guardarComentario(hash, titularActivo.texto, comentario)

  if (ok) {
    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/comentarios?titular_hash=eq.${hash}&order=created_at.asc`,
      { headers: sbHeaders }
    )
    const nuevos = await res.json()
    titularActivo.comentarios = nuevos
    renderComentarios(nuevos)
    inputComent.value = ''
    toast('Comentario enviado ✓')
  } else {
    toast('Error al enviar')
  }

  btnEnviar.disabled    = false
  btnEnviar.textContent = 'ENVIAR'
})

// ── Toast ────────────────────────────────────────────────────
function toast(msg, ms = 2000) {
  toastEl.textContent = msg
  toastEl.classList.add('visible')
  setTimeout(() => toastEl.classList.remove('visible'), ms)
}

// ── UI helpers ───────────────────────────────────────────────
function setStatus(msg, tipo = '') {
  statusEl.textContent = msg
  statusEl.className   = tipo
}

panelClose.addEventListener('click', cerrarPanel)
panel.addEventListener('click', e => { if (e.target === panel) cerrarPanel() })
btnClear.addEventListener('click', () => {
  lista.classList.remove('visible')
  overlay.innerHTML = ''
  setStatus('listo')
})

// ── Init ─────────────────────────────────────────────────────
initUsuario()
