// ── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  SUPABASE_URL:      'https://lgwyjuiurxjdcwkluykw.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxnd3lqdWl1cnhqZGN3a2x1eWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNzY3NjUsImV4cCI6MjA5MDY1Mjc2NX0.VFa1QhGWyp2HCgY0MttgQRlRUc6cY-51VitrVmpVoIo',
  EDGE_URL:          'https://lgwyjuiurxjdcwkluykw.supabase.co/functions/v1/smart-handler',

  // Cambiar a false para usar Tesseract local (sin Edge Function)
  USE_EDGE: false,

  // Altura mínima de texto para considerar "titular" (solo Tesseract)
  ALTURA_MINIMA: 30,
}

// ── DOM ─────────────────────────────────────────────────────
const video        = document.getElementById('video')
const canvas       = document.getElementById('canvas')
const overlay      = document.getElementById('overlay')
const btnScan      = document.getElementById('btn-scan')
const btnClear     = document.getElementById('btn-clear')
const statusEl     = document.getElementById('status')
const progressBar  = document.getElementById('progress-bar')
const lista        = document.getElementById('lista')
const listaItems   = document.getElementById('lista-items')
const panel        = document.getElementById('panel')
const panelTitular = document.getElementById('panel-titular')
const panelComents = document.getElementById('panel-comentarios')
const panelClose   = document.getElementById('panel-close')
const inputAutor   = document.getElementById('input-autor')
const inputComent  = document.getElementById('input-comentario')
const btnEnviar    = document.getElementById('btn-enviar')

let titularActivo = null

const sbHeaders = {
  'Content-Type':  'application/json',
  'apikey':        CONFIG.SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`
}

// ── Cámara ──────────────────────────────────────────────────
navigator.mediaDevices.getUserMedia({
  video: { facingMode: 'environment', width: { ideal: 1280 } },
  audio: false
}).then(stream => {
  video.srcObject = stream
  btnScan.disabled = false
  setStatus('listo')
}).catch(() => {
  setStatus('sin cámara', 'error')
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

// ── OCR via Edge Function (OCR.space) ────────────────────────
async function ocrEdge(imageBase64) {
  const res = await fetch(CONFIG.EDGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`
    },
    body: JSON.stringify({ image: imageBase64 })
  })
  if (!res.ok) throw new Error(`Edge error ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data.titulares || []
}

// ── OCR via Tesseract (fallback local) ──────────────────────
async function ocrTesseract() {
  const img = capturarCanvas()
  const result = await Tesseract.recognize(img, 'spa', {
    logger: m => {
      if (m.status === 'recognizing text') {
        progressBar.style.width = Math.round(m.progress * 100) + '%'
        setStatus(`reconociendo... ${Math.round(m.progress * 100)}%`, 'activo')
      }
    }
  })

  const palabras = result.data.words || []
  const grandes  = palabras.filter(w => {
    const h = w.bbox.y1 - w.bbox.y0
    return h >= CONFIG.ALTURA_MINIMA && w.text.trim().length > 2
  })

  const lineas = agruparEnLineas(grandes)

  // Generar hashes y buscar comentarios
  const hashes = await Promise.all(lineas.map(t => hashTexto(t)))
  const comentarios = await buscarComentarios(hashes)

  return lineas.map((texto, i) => ({
    texto,
    hash: hashes[i],
    boundingBox: null,
    comentarios: comentarios.filter(c => c.titular_hash === hashes[i])
  }))
}

function agruparEnLineas(palabras) {
  if (!palabras.length) return []
  const ordenadas = [...palabras].sort((a, b) => a.bbox.y0 - b.bbox.y0)
  const lineas = []
  let lineaActual = [ordenadas[0]]

  for (let i = 1; i < ordenadas.length; i++) {
    const prev    = lineaActual[lineaActual.length - 1]
    const curr    = ordenadas[i]
    const centroP = (prev.bbox.y0 + prev.bbox.y1) / 2
    const centroC = (curr.bbox.y0 + curr.bbox.y1) / 2
    if (Math.abs(centroC - centroP) < 20) {
      lineaActual.push(curr)
    } else {
      lineas.push(lineaActual.map(w => w.text).join(' '))
      lineaActual = [curr]
    }
  }
  lineas.push(lineaActual.map(w => w.text).join(' '))
  return lineas.filter(l => l.trim().length > 3)
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

async function guardarComentario(hash, texto, comentario, autor) {
  const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/comentarios`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ titular_hash: hash, titular_texto: texto, comentario, autor: autor || 'anon' })
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
  progressBar.style.width = '0%'
  setStatus('procesando...', 'activo')

  try {
    let titulares = []

    if (CONFIG.USE_EDGE) {
      const imageBase64 = capturarBase64()
      titulares = await ocrEdge(imageBase64)

      // Agregar comentarios de Supabase si vienen de Edge
      if (titulares.length) {
        const hashes = titulares.map(t => t.hash || '').filter(Boolean)
        if (hashes.length) {
          const comentarios = await buscarComentarios(hashes)
          titulares = titulares.map(t => ({
            ...t,
            comentarios: comentarios.filter(c => c.titular_hash === t.hash)
          }))
        }
      }
    } else {
      titulares = await ocrTesseract()
    }

    if (!titulares.length) {
      setStatus('sin titulares detectados')
      listaItems.innerHTML = '<div style="padding:16px;color:#555;font-size:13px">No se detectaron titulares. Acercate más.</div>'
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
    setTimeout(() => progressBar.style.width = '0%', 1000)
  }
})

// ── Panel ────────────────────────────────────────────────────
function abrirPanel(titular) {
  titularActivo = titular
  panelTitular.textContent = titular.texto
  renderComentarios(titular.comentarios || [])
  inputAutor.value  = ''
  inputComent.value = ''
  panel.classList.add('visible')
}

function renderComentarios(lista) {
  if (!lista.length) {
    panelComents.innerHTML = '<div class="sin-comentarios">Sin comentarios aún. ¡Sé el primero!</div>'
    return
  }
  panelComents.innerHTML = lista.map(c => `
    <div class="comentario-item">
      <div class="comentario-autor">${c.autor || 'anon'}</div>
      <div class="comentario-texto">${c.comentario}</div>
    </div>
  `).join('')
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

  const ok = await guardarComentario(hash, titularActivo.texto, comentario, inputAutor.value.trim())

  if (ok) {
    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/comentarios?titular_hash=eq.${hash}&order=created_at.asc`,
      { headers: sbHeaders }
    )
    const nuevos = await res.json()
    renderComentarios(nuevos)
    titularActivo.comentarios = nuevos
    inputComent.value = ''
  } else {
    alert('No se pudo enviar. Intentá de nuevo.')
  }

  btnEnviar.disabled    = false
  btnEnviar.textContent = 'ENVIAR'
})

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
