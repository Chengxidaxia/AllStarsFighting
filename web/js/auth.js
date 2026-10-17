/**
 * 登录 / 注册（照仿首页：顶栏入口 → 模态面板；未登录门禁）。
 * 后端 = Supabase Auth 邮箱 + 密码（部署版没有 Node 服务端，会话由 supabase-js 存在 localStorage）。
 *
 * 门禁开关：
 *  - 配了 __SUPABASE_URL / __SUPABASE_ANON_KEY → 启用（部署版默认）；
 *  - ?auth=off 或 __ALSF_AUTH='off' → 关闭（本地开发 / E2E / 直连 WS 服务端时用）。
 */

const ERR_MAP = [
  [/invalid login credentials/i, '邮箱或密码不正确'],
  [/email not confirmed/i, '邮箱尚未验证：请先到收件箱点确认链接（没收到请检查垃圾邮件）'],
  [/user already registered|already been registered/i, '该邮箱已注册，请直接登录'],
  [/password should be at least 6/i, '密码至少 6 位'],
  [/unable to validate email|email_address_invalid/i, '邮箱格式不正确或该地址不可用'],
  [/signups? not allowed/i, '注册已关闭'],
  [/over_email_send_rate_limit|over_request_rate_limit|rate limit/i, '操作太频繁，请稍后再试'],
  [/email logins are disabled/i, '邮箱登录未开启'],
  [/failed to fetch|load failed|networkerror/i, '网络不通，请检查连接后重试'],
];

function friendly(msg) {
  const s = String(msg ?? '');
  for (const [re, zh] of ERR_MAP) if (re.test(s)) return zh;
  return s || '操作失败，请重试';
}

function sanitizeName(email) {
  let n = String(email ?? '').split('@')[0] ?? '';
  n = n.replace(/[^A-Za-z0-9_\u4e00-\u9fa5-]/g, '').slice(0, 16);
  if (n === '') n = '星海' + Math.floor(100 + Math.random() * 900);
  return n;
}

export function createAuth() {
  const params = new URLSearchParams(location.search);
  const url = String(window.__SUPABASE_URL ?? '').trim();
  const key = String(window.__SUPABASE_ANON_KEY ?? '').trim();
  const off = params.get('auth') === 'off' || window.__ALSF_AUTH === 'off';
  let enabled = !off && url !== '' && key !== '';

  const listeners = new Set();
  let user = null; // { id, email }
  let client = null;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });

  function emit() { renderSlots(); for (const fn of [...listeners]) fn(user); }
  function setUser(u) { user = u; emit(); }

  async function ensureClient() {
    if (client !== null) return client;
    const mod = await import('https://esm.sh/@supabase/supabase-js@2');
    client = mod.createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    return client;
  }

  function toUser(session) {
    const u = session?.user;
    if (!u) return null;
    return { id: u.id, email: u.email ?? '' };
  }

  async function doSignIn(email, password) {
    const sb = await ensureClient();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error(friendly(error.message));
    setUser(toUser(data.session));
  }

  async function doSignUp(email, password) {
    const sb = await ensureClient();
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) throw new Error(friendly(error.message));
    if (data.session && data.user) { setUser(toUser(data.session)); return { confirmed: true }; }
    return { confirmed: false };
  }

  /* ── UI（照仿首页模态面板） ── */
  const ui = {
    modal: document.getElementById('auth-modal'),
    hint: document.getElementById('auth-hint'),
    tabL: document.getElementById('authtab-login'),
    tabR: document.getElementById('authtab-register'),
    email: document.getElementById('auth-email'),
    pass: document.getElementById('auth-pass'),
    submit: document.getElementById('auth-submit'),
    msg: document.getElementById('auth-msg'),
    close: document.getElementById('auth-close'),
  };
  let mode = 'login';
  let uiBound = false;

  function setMode(m) {
    mode = m;
    ui.tabL.classList.toggle('active', m === 'login');
    ui.tabR.classList.toggle('active', m === 'register');
    ui.submit.textContent = m === 'login' ? '登录' : '注册并登录';
    ui.pass.setAttribute('autocomplete', m === 'login' ? 'current-password' : 'new-password');
    ui.msg.textContent = '';
  }

  function openModal(hint) {
    if (ui.modal === null) return;
    ui.hint.textContent = hint || '';
    ui.hint.hidden = !hint;
    ui.modal.hidden = false;
    document.body.classList.add('modal-open');
    setTimeout(() => { if (ui.email) ui.email.focus(); }, 30);
  }

  function closeModal() {
    if (ui.modal === null) return;
    ui.modal.hidden = true;
    document.body.classList.remove('modal-open');
    ui.msg.textContent = '';
  }

  function bindUi() {
    if (uiBound || ui.modal === null) return;
    uiBound = true;
    ui.close.addEventListener('click', closeModal);
    ui.modal.addEventListener('click', (e) => { if (e.target === ui.modal) closeModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && ui.modal.hidden === false) closeModal();
    });
    ui.tabL.addEventListener('click', () => setMode('login'));
    ui.tabR.addEventListener('click', () => setMode('register'));
    ui.email.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.pass.focus(); });
    ui.pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.submit.click(); });
    ui.submit.addEventListener('click', async () => {
      const email = ui.email.value.trim();
      const pass = ui.pass.value;
      if (email === '' || !email.includes('@')) { ui.msg.textContent = '请填写邮箱'; return; }
      if (pass.length < 6) { ui.msg.textContent = '密码至少 6 位'; return; }
      ui.submit.disabled = true;
      ui.msg.textContent = '…';
      try {
        if (mode === 'login') {
          await doSignIn(email, pass);
        } else {
          const r = await doSignUp(email, pass);
          if (r.confirmed === false) {
            // 先 setMode 再写 msg：setMode 会清空 msg。
            // Supabase 开了防枚举，已注册的邮箱也走这条分支，提示要兼容两种情况。
            setMode('login');
            ui.msg.textContent = '注册成功。新邮箱请先到收件箱点确认链接，再回来登录；已注册的邮箱请直接登录。';
            return;
          }
        }
        ui.email.value = '';
        ui.pass.value = '';
        closeModal();
      } catch (err) {
        ui.msg.textContent = friendly(err?.message ?? err);
      } finally {
        ui.submit.disabled = false;
      }
    });
  }

  /* ── 顶栏入口（所有 .auth-slot 同步渲染） ── */
  function renderSlots() {
    for (const slot of document.querySelectorAll('.auth-slot')) {
      if (!enabled) { slot.innerHTML = ''; continue; }
      if (user === null) {
        slot.innerHTML = '<button class="btn btn-sm auth-enter" type="button">登录 / 注册</button>';
        const b = slot.querySelector('.auth-enter');
        b.addEventListener('click', () => openModal('登录后即可进入游戏'));
      } else {
        slot.innerHTML =
          `<span class="auth-user">你好，<b>${esc(sanitizeName(user.email))}</b></span>` +
          '<button class="ghost-btn btn-sm auth-exit" type="button">退出</button>';
        slot.querySelector('.auth-exit').addEventListener('click', async () => {
          try { if (client !== null) await client.auth.signOut(); } catch { /* 本地状态照样清 */ }
          setUser(null);
        });
      }
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
    ));
  }

  /* ── 启动：读本地会话 ── */
  bindUi();
  renderSlots();
  if (enabled) {
    (async () => {
      try {
        const sb = await ensureClient();
        const { data } = await sb.auth.getSession();
        if (data?.session) setUser(toUser(data.session));
        sb.auth.onAuthStateChange((_evt, session) => setUser(toUser(session)));
      } catch (err) {
        // Supabase 不可用：降级为不门禁（本地会话也没有，按访客玩）
        console.warn('[auth] Supabase 不可用，已关闭登录门禁：' + String(err));
        enabled = false;
      }
      readyResolve();
    })();
  } else {
    readyResolve();
  }

  return {
    get enabled() { return enabled; },
    get user() { return user; },
    ready,
    onChange(fn) { listeners.add(fn); },
    displayName() { return user === null ? '' : sanitizeName(user.email); },
    waitLogin() {
      if (user !== null) return Promise.resolve();
      return new Promise((resolve) => {
        const fn = (u) => { if (u !== null) { listeners.delete(fn); resolve(); } };
        listeners.add(fn);
      });
    },
    openModal,
    closeModal,
    async signIn(email, password) { return doSignIn(email, password); },
    async signUp(email, password) { return doSignUp(email, password); },
    async signOut() {
      try { if (client !== null) await client.auth.signOut(); } catch { /* 忽略 */ }
      setUser(null);
    },
  };
}
