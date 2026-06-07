/**
 * app.js — Lógica completa del frontend para Counter App
 *
 * Estado global mínimo; toda la persistencia vive en el servidor (SQLite).
 * El token JWT se guarda en localStorage y se adjunta a cada request.
 */

const App = (() => {
  // ─── Estado ──────────────────────────────────────────────────────────────
  let token    = localStorage.getItem('counter_token') || null;
  let username = localStorage.getItem('counter_user') || '';
  let counters = [];
  let focusCounter = null;
  let authMode     = 'login';
  let editMode     = false;
  let selectedColor = '#6366f1';
  let focusMenuOpen = false;
  let dashMenuOpen  = false;

  // Estado de la pantalla de análisis
  let analyticsData   = null;
  let analyticsYear   = null;
  let analyticsChart1 = null;
  let analyticsChart2 = null;

  const COLORS = [
    '#6366f1', '#8b5cf6', '#ec4899', '#ef4444',
    '#f97316', '#eab308', '#22c55e', '#14b8a6',
    '#3b82f6', '#0ea5e9', '#64748b', '#1e293b',
  ];

  const MONTHS_SHORT = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

  // Paleta para el gráfico de comparación multi-año
  const CHART_PALETTE = [
    { bg: 'rgba(99,102,241,0.85)',  border: '#6366f1' },
    { bg: 'rgba(236,72,153,0.85)',  border: '#ec4899' },
    { bg: 'rgba(34,197,94,0.85)',   border: '#22c55e' },
    { bg: 'rgba(245,158,11,0.85)',  border: '#f59e0b' },
    { bg: 'rgba(59,130,246,0.85)',  border: '#3b82f6' },
    { bg: 'rgba(239,68,68,0.85)',   border: '#ef4444' },
  ];

  // SVG del ícono estrella (reutilizado en fav btn y en las tarjetas)
  const SVG_STAR_OUTLINE = `<svg class="w-5 h-5 text-white/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>`;
  const SVG_STAR_FILLED  = `<svg class="w-5 h-5 text-yellow-300" fill="currentColor" viewBox="0 0 24 24"><path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>`;

  // ─── Helpers de red ───────────────────────────────────────────────────────

  async function api(method, path, body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (body)  opts.body = JSON.stringify(body);
    try {
      const res  = await fetch(path, opts);
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: { error: 'Sin conexión con el servidor' } };
    }
  }

  // ─── Modo oscuro ──────────────────────────────────────────────────────────

  function initDarkMode() {
    const saved      = localStorage.getItem('counter_theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark     = saved ? saved === 'dark' : prefersDark;
    document.documentElement.classList.toggle('dark', isDark);
    document.getElementById('themeBtn').textContent = isDark ? '☀️' : '🌙';
  }

  function toggleDarkMode() {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('counter_theme', isDark ? 'dark' : 'light');
    document.getElementById('themeBtn').textContent = isDark ? '☀️' : '🌙';
  }

  // ─── Toast ────────────────────────────────────────────────────────────────

  let toastTimer = null;
  function showToast(msg, duration = 2200) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
  }

  // ─── Navegación ───────────────────────────────────────────────────────────

  function showScreen(id) {
    ['authScreen', 'mainScreen', 'focusScreen'].forEach(s =>
      document.getElementById(s).classList.add('hidden')
    );
    document.getElementById(id).classList.remove('hidden');
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────

  function showAuthTab(mode) {
    authMode = mode;
    const isReg = mode === 'register';
    const base  = 'flex-1 py-2 text-sm font-semibold rounded-xl transition-all duration-200';
    const active = `${base} bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm`;
    const inactive = `${base} text-gray-500 dark:text-gray-400`;

    document.getElementById('tabLogin').className    = isReg ? inactive : active;
    document.getElementById('tabRegister').className = isReg ? active : inactive;
    document.getElementById('fieldUsername').classList.toggle('hidden', !isReg);
    document.getElementById('authSubmitBtn').textContent = isReg ? 'Crear cuenta' : 'Iniciar sesión';
    document.getElementById('authError').classList.add('hidden');
    document.getElementById('authForm').reset();
  }

  async function submitAuth(e) {
    e.preventDefault();
    const email    = document.getElementById('inputEmail').value.trim();
    const password = document.getElementById('inputPassword').value;
    const errorEl  = document.getElementById('authError');
    const btn      = document.getElementById('authSubmitBtn');

    errorEl.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Cargando…';

    let res;
    if (authMode === 'register') {
      const uname = document.getElementById('inputUsername').value.trim();
      res = await api('POST', '/api/auth/register', { username: uname, email, password });
    } else {
      res = await api('POST', '/api/auth/login', { email, password });
    }

    btn.disabled = false;
    btn.textContent = authMode === 'register' ? 'Crear cuenta' : 'Iniciar sesión';

    if (!res.ok) {
      errorEl.textContent = res.data.error || 'Error desconocido';
      errorEl.classList.remove('hidden');
      return;
    }

    token    = res.data.token;
    username = res.data.username;
    localStorage.setItem('counter_token', token);
    localStorage.setItem('counter_user', username);
    loadDashboard();
  }

  function logout() {
    token    = null;
    username = '';
    counters = [];
    focusCounter = null;
    localStorage.removeItem('counter_token');
    localStorage.removeItem('counter_user');
    dashMenuOpen = false;
    document.getElementById('dropdownMenu').classList.add('hidden');
    showScreen('authScreen');
    showAuthTab('login');
    showToast('Sesión cerrada');
  }

  // ─── Dashboard ────────────────────────────────────────────────────────────

  async function loadDashboard() {
    showScreen('mainScreen');
    document.getElementById('welcomeMsg').textContent = `Hola, ${username} 👋`;

    const res = await api('GET', '/api/counters');
    if (!res.ok) {
      if (res.status === 401) { logout(); return; }
      showToast('Error cargando contadores');
      return;
    }
    counters = res.data;
    renderDashboard();
  }

  function renderDashboard() {
    const favList         = document.getElementById('favList');
    const counterList     = document.getElementById('counterList');
    const emptyState      = document.getElementById('emptyState');
    const favSection      = document.getElementById('favSection');
    const allSectionLabel = document.getElementById('allSectionLabel');

    favList.innerHTML = '';
    counterList.innerHTML = '';

    if (counters.length === 0) {
      emptyState.classList.remove('hidden');
      emptyState.classList.add('flex');
      favSection.classList.add('hidden');
      allSectionLabel.classList.add('hidden');
      return;
    }

    emptyState.classList.add('hidden');
    emptyState.classList.remove('flex');

    const favs = counters.filter(c => c.is_favorite);
    const rest = counters.filter(c => !c.is_favorite);

    favSection.classList.toggle('hidden', favs.length === 0);
    allSectionLabel.classList.toggle('hidden', favs.length === 0 || rest.length === 0);

    favs.forEach(c => favList.appendChild(buildCounterCard(c)));
    rest.forEach(c => counterList.appendChild(buildCounterCard(c)));
  }

  /**
   * Construye una tarjeta de contador.
   * - Tap en la tarjeta → incrementa directamente (igual que la app iOS)
   * - Botón "›" en la esquina → abre el modo enfoque
   */
  function buildCounterCard(c) {
    const div = document.createElement('div');
    div.className = 'counter-card flex items-center gap-3 pl-5 pr-3 py-4 rounded-3xl shadow-sm transition-transform duration-150';
    div.style.background = c.color;
    div.dataset.id = c.id;

    const numStr  = formatNumber(c.current_value);
    const stepStr = c.step > 0 ? `+${formatNumber(c.step)}` : formatNumber(c.step);
    const starSvg = c.is_favorite
      ? `<svg class="w-3.5 h-3.5 text-yellow-300 shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>`
      : '';

    div.innerHTML = `
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-1.5 mb-0.5">
          <p class="text-white/75 text-xs font-semibold truncate">${escapeHtml(c.name)}</p>
          ${starSvg}
        </div>
        <p class="card-value text-white text-[2.75rem] font-black tabular-nums leading-none tracking-tight">${numStr}</p>
        <p class="text-white/55 text-[11px] font-medium mt-1">${stepStr} por tap</p>
      </div>
      <button class="card-open-btn w-10 h-14 rounded-2xl bg-black/15 hover:bg-black/25 active:scale-90 flex items-center justify-center transition-all shrink-0">
        <svg class="w-5 h-5 text-white/75" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
        </svg>
      </button>
    `;

    // Tap en la tarjeta (excepto el botón ›) = incrementar
    div.addEventListener('click', (e) => {
      if (!e.target.closest('.card-open-btn')) {
        incrementCard(c.id, div);
      }
    });

    // Botón › = abrir modo enfoque
    div.querySelector('.card-open-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openFocus(c.id);
    });

    return div;
  }

  /**
   * Incrementa un contador desde el dashboard con actualización optimista.
   * Muestra el nuevo valor de inmediato y corrige si el servidor falla.
   */
  async function incrementCard(id, cardEl) {
    const c = counters.find(x => x.id === id);
    if (!c) return;

    // Actualización optimista
    c.current_value = parseFloat((c.current_value + c.step).toFixed(10));
    const valueEl = cardEl.querySelector('.card-value');
    if (valueEl) valueEl.textContent = formatNumber(c.current_value);

    // Feedback visual + háptico
    cardEl.classList.remove('bump');
    void cardEl.offsetWidth;
    cardEl.classList.add('bump');
    if (navigator.vibrate) navigator.vibrate(8);

    const res = await api('POST', `/api/counters/${id}/increment`);
    if (res.ok) {
      c.current_value = res.data.current_value;
      if (valueEl) valueEl.textContent = formatNumber(c.current_value);
    } else {
      // Revierte si el servidor falló
      c.current_value = parseFloat((c.current_value - c.step).toFixed(10));
      if (valueEl) valueEl.textContent = formatNumber(c.current_value);
      showToast('Error al registrar');
    }
  }

  // ─── Modo Enfoque ─────────────────────────────────────────────────────────

  async function openFocus(id) {
    const c = counters.find(x => x.id === id);
    if (!c) return;
    focusCounter = { ...c };
    applyFocusUI();
    showScreen('focusScreen');
  }

  /** Actualiza toda la UI del modo enfoque a partir de focusCounter */
  function applyFocusUI() {
    const c = focusCounter;
    document.getElementById('focusScreen').style.background = c.color;
    document.getElementById('focusName').textContent  = c.name;
    document.getElementById('focusStep').textContent  =
      `Paso: ${c.step > 0 ? '+' : ''}${formatNumber(c.step)}`;
    document.getElementById('focusValue').textContent = formatNumber(c.current_value);
    updateFavBtn(c.is_favorite);
  }

  /** Actualiza el ícono de favorito en el encabezado del foco (SVG consistente) */
  function updateFavBtn(isFavorite) {
    document.getElementById('focusFavBtn').innerHTML =
      isFavorite ? SVG_STAR_FILLED : SVG_STAR_OUTLINE;
  }

  function closeFocus() {
    closeAnalytics();
    const idx = counters.findIndex(x => x.id === focusCounter?.id);
    if (idx !== -1) counters[idx] = { ...counters[idx], ...focusCounter };
    renderDashboard();
    focusCounter = null;
    showScreen('mainScreen');
  }

  function animateValue(shake = false) {
    const el = document.getElementById('focusValueWrap');
    el.classList.remove('bump', 'shake');
    void el.offsetWidth;
    el.classList.add(shake ? 'shake' : 'bump');
  }

  async function incrementFocus(e) {
    if (e) e.stopPropagation();
    if (!focusCounter) return;

    const res = await api('POST', `/api/counters/${focusCounter.id}/increment`);
    if (!res.ok) { showToast('Error al incrementar'); return; }

    focusCounter.current_value = res.data.current_value;
    document.getElementById('focusValue').textContent = formatNumber(focusCounter.current_value);
    animateValue(false);
    if (navigator.vibrate) navigator.vibrate(10);
  }

  async function decrementFocus(e) {
    if (e) e.stopPropagation();
    if (!focusCounter) return;

    const res = await api('POST', `/api/counters/${focusCounter.id}/decrement`);
    if (!res.ok) { showToast('Error al decrementar'); return; }

    focusCounter.current_value = res.data.current_value;
    document.getElementById('focusValue').textContent = formatNumber(focusCounter.current_value);
    animateValue(false);
    if (navigator.vibrate) navigator.vibrate(10);
  }

  async function resetFocus(e) {
    if (e) e.stopPropagation();
    if (!focusCounter) return;

    const res = await api('POST', `/api/counters/${focusCounter.id}/reset`);
    if (!res.ok) { showToast('Error al resetear'); return; }

    focusCounter.current_value = res.data.current_value;
    document.getElementById('focusValue').textContent = formatNumber(focusCounter.current_value);
    animateValue(true);
    showToast('Contador reseteado');
    if (navigator.vibrate) navigator.vibrate([10, 30, 10]);
  }

  async function toggleFavoriteFocus() {
    if (!focusCounter) return;
    const newFav = !focusCounter.is_favorite;
    const res = await api('PUT', `/api/counters/${focusCounter.id}`, { is_favorite: newFav });
    if (!res.ok) { showToast('Error al actualizar favorito'); return; }

    focusCounter.is_favorite = newFav;
    updateFavBtn(newFav);
    showToast(newFav ? 'Agregado a favoritos ⭐' : 'Quitado de favoritos');
  }

  // ─── Menús desplegables ───────────────────────────────────────────────────

  function toggleMenu() {
    dashMenuOpen = !dashMenuOpen;
    document.getElementById('dropdownMenu').classList.toggle('hidden', !dashMenuOpen);
  }

  function toggleFocusMenu() {
    focusMenuOpen = !focusMenuOpen;
    document.getElementById('focusDropdown').classList.toggle('hidden', !focusMenuOpen);
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#menuBtn') && !e.target.closest('#dropdownMenu')) {
      dashMenuOpen = false;
      document.getElementById('dropdownMenu').classList.add('hidden');
    }
    if (!e.target.closest('#focusDropdown') && !e.target.closest('[onclick*="toggleFocusMenu"]')) {
      focusMenuOpen = false;
      document.getElementById('focusDropdown').classList.add('hidden');
    }
  });

  // ─── Modal Crear / Editar ─────────────────────────────────────────────────

  /**
   * Construye el picker de color con 12 colores predefinidos +
   * un selector nativo para colores personalizados (rueda de color).
   */
  function buildColorPicker() {
    const picker = document.getElementById('colorPicker');
    picker.innerHTML = '';

    COLORS.forEach(color => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `color-pill ${color === selectedColor ? 'active' : ''}`;
      btn.style.background = color;
      btn.style.color      = color;
      btn.onclick = () => {
        selectedColor = color;
        picker.querySelectorAll('.color-pill').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        // Sincroniza el input nativo
        const inp = picker.querySelector('input[type=color]');
        if (inp) inp.value = color;
      };
      picker.appendChild(btn);
    });

    // Pill especial: selector de color nativo (rueda de colores)
    const customPill = document.createElement('label');
    customPill.className = `color-pill overflow-hidden relative ${!COLORS.includes(selectedColor) ? 'active' : ''}`;
    customPill.title = 'Color personalizado';
    customPill.style.background = COLORS.includes(selectedColor)
      ? 'conic-gradient(from 0deg, #ff0000, #ff8800, #ffff00, #22c55e, #3b82f6, #8b5cf6, #ff0000)'
      : selectedColor;
    customPill.style.color = COLORS.includes(selectedColor) ? '#ff6600' : selectedColor;

    const inp = document.createElement('input');
    inp.type  = 'color';
    inp.value = COLORS.includes(selectedColor) ? '#ff6600' : selectedColor;
    inp.style.cssText = 'position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer;border:none;padding:0;';

    inp.addEventListener('input', (e) => {
      selectedColor = e.target.value;
      picker.querySelectorAll('.color-pill').forEach(p => p.classList.remove('active'));
      customPill.classList.add('active');
      customPill.style.background = e.target.value;
      customPill.style.color      = e.target.value;
    });

    customPill.appendChild(inp);
    picker.appendChild(customPill);
  }

  function openCreateModal() {
    editMode      = false;
    selectedColor = COLORS[0];
    document.getElementById('modalTitle').textContent     = 'Nuevo contador';
    document.getElementById('modalSubmitBtn').textContent = 'Crear contador';
    document.getElementById('counterName').value          = '';
    document.getElementById('counterInitial').value       = '0';
    document.getElementById('counterStep').value          = '1';
    document.getElementById('modalError').classList.add('hidden');
    buildColorPicker();
    document.getElementById('counterModal').classList.remove('hidden');
    setTimeout(() => document.getElementById('counterName').focus(), 300);
  }

  function openEditModal() {
    if (!focusCounter) return;
    editMode      = true;
    selectedColor = focusCounter.color;

    document.getElementById('modalTitle').textContent     = 'Editar contador';
    document.getElementById('modalSubmitBtn').textContent = 'Guardar cambios';
    document.getElementById('counterName').value          = focusCounter.name;
    document.getElementById('counterInitial').value       = focusCounter.initial_value;
    document.getElementById('counterStep').value          = focusCounter.step;
    document.getElementById('modalError').classList.add('hidden');
    buildColorPicker();

    closeFocusDropdown();
    document.getElementById('counterModal').classList.remove('hidden');
    setTimeout(() => document.getElementById('counterName').focus(), 300);
  }

  function closeCounterModal() {
    document.getElementById('counterModal').classList.add('hidden');
  }

  function closeFocusDropdown() {
    focusMenuOpen = false;
    document.getElementById('focusDropdown').classList.add('hidden');
  }

  async function saveCounter(e) {
    e.preventDefault();
    const name    = document.getElementById('counterName').value.trim();
    const initial = parseFloat(document.getElementById('counterInitial').value) || 0;
    const step    = parseFloat(document.getElementById('counterStep').value) ?? 1;
    const errorEl = document.getElementById('modalError');
    const btn     = document.getElementById('modalSubmitBtn');

    if (!name) {
      errorEl.textContent = 'El nombre es requerido';
      errorEl.classList.remove('hidden');
      return;
    }
    if (step === 0) {
      errorEl.textContent = 'El paso no puede ser 0';
      errorEl.classList.remove('hidden');
      return;
    }

    errorEl.classList.add('hidden');
    btn.disabled    = true;
    btn.textContent = 'Guardando…';

    let res;
    if (editMode && focusCounter) {
      res = await api('PUT', `/api/counters/${focusCounter.id}`, {
        name, color: selectedColor, step,
      });
    } else {
      res = await api('POST', '/api/counters', {
        name, color: selectedColor, initial_value: initial, step,
      });
    }

    btn.disabled    = false;
    btn.textContent = editMode ? 'Guardar cambios' : 'Crear contador';

    if (!res.ok) {
      errorEl.textContent = res.data.error || 'Error desconocido';
      errorEl.classList.remove('hidden');
      return;
    }

    closeCounterModal();

    if (editMode) {
      Object.assign(focusCounter, res.data);
      applyFocusUI();
      const idx = counters.findIndex(x => x.id === focusCounter.id);
      if (idx !== -1) counters[idx] = { ...res.data };
      showToast('Cambios guardados');
    } else {
      counters.unshift(res.data);
      renderDashboard();
      showToast('Contador creado ✓');
    }
  }

  // ─── Eliminar contador ────────────────────────────────────────────────────

  async function confirmDelete() {
    closeFocusDropdown();
    if (!focusCounter) return;
    if (!confirm(`¿Eliminar "${focusCounter.name}"? Esta acción no se puede deshacer.`)) return;

    const res = await api('DELETE', `/api/counters/${focusCounter.id}`);
    if (!res.ok) { showToast('Error al eliminar'); return; }

    counters = counters.filter(c => c.id !== focusCounter.id);
    focusCounter = null;
    renderDashboard();
    showScreen('mainScreen');
    showToast('Contador eliminado');
  }

  // ─── Historial ────────────────────────────────────────────────────────────

  async function openHistoryModal() {
    closeFocusDropdown();
    document.getElementById('historyModal').classList.remove('hidden');
    document.getElementById('historyList').innerHTML =
      '<p class="text-center text-gray-400 dark:text-gray-500 text-sm py-8">Cargando…</p>';

    const res  = await api('GET', `/api/counters/${focusCounter.id}/history`);
    const list = document.getElementById('historyList');

    if (!res.ok || !res.data.length) {
      list.innerHTML = '<p class="text-center text-gray-400 dark:text-gray-500 text-sm py-8">Sin registros aún</p>';
      return;
    }

    list.innerHTML = '';
    res.data.forEach(h => {
      // ── Separador especial para el reset anual ────────────────────────────
      if (h.action === 'year_reset') {
        const year = h.timestamp ? h.timestamp.slice(0, 4) : '?';
        const sep  = document.createElement('div');
        sep.className = 'flex items-center gap-3 py-3 border-b border-gray-100 dark:border-gray-800';
        sep.innerHTML = `
          <div class="flex-1 h-px bg-indigo-200 dark:bg-indigo-900/60 rounded"></div>
          <span class="flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-50 dark:bg-indigo-900/40 text-indigo-500 dark:text-indigo-300 text-xs font-bold whitespace-nowrap">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
            </svg>
            Inicio ${year} · reinicio automático
          </span>
          <div class="flex-1 h-px bg-indigo-200 dark:bg-indigo-900/60 rounded"></div>
        `;
        list.appendChild(sep);
        return;
      }

      // ── Evento normal (increment / decrement / reset / import) ────────────
      const d     = document.createElement('div');
      d.className = 'flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-800 last:border-0';

      const icon  = h.action === 'increment' ? '↑' : h.action === 'decrement' ? '↓' : h.action === 'import' ? '↓' : '↺';
      const color = h.action === 'increment' ? 'text-emerald-500' : h.action === 'decrement' ? 'text-red-400' : 'text-gray-400';

      const ts      = new Date(h.timestamp);
      const dateStr = ts.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
      const timeStr = ts.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      d.innerHTML = `
        <div class="flex items-center gap-3">
          <span class="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center font-bold ${color} text-base">${icon}</span>
          <div>
            <p class="text-sm font-semibold">${formatNumber(h.value_after)}</p>
            <p class="text-xs text-gray-400 dark:text-gray-500">${dateStr} · ${timeStr}</p>
          </div>
        </div>
        <span class="text-xs font-mono ${color}">${h.increment > 0 ? '+' : ''}${formatNumber(h.increment)}</span>
      `;
      list.appendChild(d);
    });
  }

  function closeHistoryModal() {
    document.getElementById('historyModal').classList.add('hidden');
  }

  // ─── Exportación CSV ──────────────────────────────────────────────────────

  async function exportAll() {
    dashMenuOpen = false;
    document.getElementById('dropdownMenu').classList.add('hidden');
    await downloadCSV('/api/counters/export', 'contadores_export.csv');
  }

  async function exportSingle() {
    closeFocusDropdown();
    if (!focusCounter) return;
    const name = focusCounter.name.replace(/[^a-z0-9]/gi, '_');
    await downloadCSV(`/api/counters/${focusCounter.id}/export`, `contador_${name}.csv`);
  }

  async function downloadCSV(url, filename) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { showToast('Error al exportar'); return; }
    const blob = await res.blob();
    const link = document.createElement('a');
    link.href  = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast('CSV exportado ✓');
  }

  // ─── Importación CSV ──────────────────────────────────────────────────────

  async function importCSV(event) {
    dashMenuOpen = false;
    document.getElementById('dropdownMenu').classList.add('hidden');

    const file = event.target.files[0];
    if (!file) return;
    event.target.value = ''; // permite re-seleccionar el mismo archivo

    const formData = new FormData();
    formData.append('file', file);

    showToast('Importando…', 5000);

    const res  = await fetch('/api/counters/import', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showToast(data.error || 'Error al importar');
      return;
    }

    counters.unshift(...(data.counters || []));
    renderDashboard();
    showToast(`${data.imported} contador(es) importado(s) ✓`);
  }

  // ─── Análisis ─────────────────────────────────────────────────────────────

  async function openAnalytics() {
    if (!focusCounter) return;
    closeFocusDropdown();

    document.getElementById('analyticsCounterName').textContent = focusCounter.name;
    document.getElementById('analyticsScreen').classList.remove('hidden');
    document.getElementById('chart1Empty').classList.add('hidden');
    document.getElementById('chart2Empty').classList.add('hidden');

    const res = await api('GET', `/api/counters/${focusCounter.id}/analytics`);
    if (!res.ok) { showToast('Error cargando análisis'); return; }

    analyticsData = res.data;

    // Asegura que el año actual siempre aparezca en el selector (aunque esté vacío)
    const currentYear = String(new Date().getFullYear());
    if (!analyticsData.years.includes(currentYear)) {
      analyticsData.years.push(currentYear);
      analyticsData.yearlyData[currentYear] = Array(12).fill(0);
    }
    analyticsYear = currentYear; // Siempre arranca en el año en curso

    updateYearSelector();
    renderChart1();
    renderChart2();
  }

  function closeAnalytics() {
    document.getElementById('analyticsScreen').classList.add('hidden');
    if (analyticsChart1) { analyticsChart1.destroy(); analyticsChart1 = null; }
    if (analyticsChart2) { analyticsChart2.destroy(); analyticsChart2 = null; }
    analyticsData = null;
  }

  function updateYearSelector() {
    const years = analyticsData?.years || [];
    const idx   = years.indexOf(analyticsYear);
    document.getElementById('analyticsYear').textContent = analyticsYear || '—';
    document.getElementById('prevYearBtn').disabled = idx <= 0;
    document.getElementById('nextYearBtn').disabled = idx < 0 || idx >= years.length - 1;
  }

  function prevAnalyticsYear() {
    if (!analyticsData) return;
    const years = analyticsData.years;
    const idx   = years.indexOf(analyticsYear);
    if (idx > 0) { analyticsYear = years[idx - 1]; updateYearSelector(); renderChart1(); }
  }

  function nextAnalyticsYear() {
    if (!analyticsData) return;
    const years = analyticsData.years;
    const idx   = years.indexOf(analyticsYear);
    if (idx < years.length - 1) { analyticsYear = years[idx + 1]; updateYearSelector(); renderChart1(); }
  }

  function chartTheme() {
    const dark = document.documentElement.classList.contains('dark');
    return {
      grid:    dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)',
      tick:    dark ? '#9ca3af' : '#6b7280',
      tooltip: dark ? '#1f2937' : '#111827',
    };
  }

  function renderChart1() {
    if (!analyticsData) return;
    const { grid, tick, tooltip } = chartTheme();
    const values  = analyticsData.yearlyData[analyticsYear] || Array(12).fill(0);
    const hasData = values.some(v => v > 0);

    document.getElementById('chart1Empty').classList.toggle('hidden', hasData || analyticsData.years.length === 0);

    if (analyticsChart1) analyticsChart1.destroy();

    const ctx   = document.getElementById('chart1Canvas').getContext('2d');
    const color = analyticsData.counter.color;

    analyticsChart1 = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: MONTHS_SHORT,
        datasets: [{
          data: values,
          backgroundColor: color + 'cc',
          borderColor: color,
          borderWidth: 0,
          borderRadius: 6,
          borderSkipped: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: tooltip,
            padding: 10,
            callbacks: { label: ctx => ` ${formatNumber(ctx.parsed.y)}` },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: tick, font: { size: 11 } },
            border: { display: false },
          },
          y: {
            beginAtZero: true,
            grid: { color: grid },
            ticks: { color: tick, font: { size: 11 }, maxTicksLimit: 5 },
            border: { display: false },
          },
        },
      },
    });
  }

  function renderChart2() {
    if (!analyticsData) return;
    const { grid, tick, tooltip } = chartTheme();
    const years   = analyticsData.years;
    const hasData = years.length > 0;

    document.getElementById('chart2Empty').classList.toggle('hidden', hasData);
    if (!hasData) return;

    if (analyticsChart2) analyticsChart2.destroy();

    const ctx      = document.getElementById('chart2Canvas').getContext('2d');
    const datasets = years.map((year, i) => {
      const c = CHART_PALETTE[i % CHART_PALETTE.length];
      return {
        label: year,
        data: analyticsData.yearlyData[year] || Array(12).fill(0),
        backgroundColor: c.bg,
        borderColor: c.border,
        borderWidth: 0,
        borderRadius: 4,
        borderSkipped: false,
      };
    });

    analyticsChart2 = new Chart(ctx, {
      type: 'bar',
      data: { labels: MONTHS_SHORT, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: tick,
              boxWidth: 12, boxHeight: 12,
              borderRadius: 3, useBorderRadius: true,
              padding: 16,
              font: { size: 12 },
            },
          },
          tooltip: {
            backgroundColor: tooltip,
            padding: 10,
            callbacks: { label: ctx => ` ${ctx.dataset.label}: ${formatNumber(ctx.parsed.y)}` },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: tick, font: { size: 11 } },
            border: { display: false },
          },
          y: {
            beginAtZero: true,
            grid: { color: grid },
            ticks: { color: tick, font: { size: 11 }, maxTicksLimit: 5 },
            border: { display: false },
          },
        },
      },
    });
  }

  // ─── Utilidades ───────────────────────────────────────────────────────────

  function formatNumber(n) {
    if (n === null || n === undefined) return '0';
    if (Number.isInteger(n)) return n.toLocaleString('es-AR');
    return parseFloat(n.toFixed(4)).toLocaleString('es-AR');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Inicialización ───────────────────────────────────────────────────────

  function init() {
    initDarkMode();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('counter_theme')) {
        document.documentElement.classList.toggle('dark', e.matches);
        document.getElementById('themeBtn').textContent = e.matches ? '☀️' : '🌙';
      }
    });
    token ? loadDashboard() : showScreen('authScreen');
  }

  return {
    init,
    toggleDarkMode,
    showAuthTab,
    submitAuth,
    logout,
    openCreateModal,
    openEditModal,
    closeCounterModal,
    saveCounter,
    openFocus,
    closeFocus,
    incrementFocus,
    decrementFocus,
    resetFocus,
    toggleFavoriteFocus,
    confirmDelete,
    toggleMenu,
    toggleFocusMenu,
    exportAll,
    exportSingle,
    importCSV,
    openHistoryModal,
    closeHistoryModal,
    openAnalytics,
    closeAnalytics,
    prevAnalyticsYear,
    nextAnalyticsYear,
  };
})();

document.addEventListener('DOMContentLoaded', App.init);
