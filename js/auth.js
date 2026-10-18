/**
 * 登录 / 注册 / 改昵称（照仿首页：顶栏入口 → 模态面板；未登录门禁）。
 * 后端 = Supabase Auth 邮箱 + 密码（部署版没有 Node 服务端，会话由 supabase-js 存在 localStorage）。
 *
 * 门禁开关（显式开启，避免本地开发被挡）：
 *  - __ALSF_AUTH = 'on' 或 ?auth=on → 启用（部署版在 config.local.js 里设 'on'）；
 *  - ?auth=off → 强制关闭（本地开发 / E2E / 直连 WS 服务端时用）；
 *  - 默认关闭：本地经合集网关（已有 hub 账号）不该被双重门禁挡着。
 *
 * 昵称：存 Supabase user_metadata.nickname（跨设备跟随账号），顶栏「改名」随时改；
 * 名号优先级 = 昵称 > 邮箱前缀 >（本地模式）本地缓存/访客名。
 *
 * 邮箱确认链接：signUp 带 emailRedirectTo = location.origin，
 * 确认邮件里的链接指向当前站点（后台 Site URL 默认是 localhost:3000，不能依赖它）；
 * 用户点链接回到本站时带 ?token_hash=...&type=signup，启动时 verifyOtp 自动确认并登录。
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
  const off = params.get('auth') === 'off';
  const authOn = params.get('auth') === 'on' || window.__ALSF_AUTH === 'on';
  let enabled = authOn && !off && url !== '' && key !== '';

  const listeners = new Set();
  let user = null; // { id, email, nickname }
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
    const nick = String(u.user_metadata?.nickname ?? '').trim();
    return { id: u.id, email: u.email ?? '', nickname: nick };
  }

  async function doSignIn(email, password) {
    const sb = await ensureClient();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error(friendly(error.message));
    setUser(toUser(data.session));
  }

  async function doSignUp(email, password) {
    const sb = await ensureClient();
    // emailRedirectTo：确认邮件链接指向当前站点（后台 Site URL 默认 localhost:3000，不能依赖）
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { emailRedirectTo: location.origin },
    });
    if (error) throw new Error(friendly(error.message));
    if (data.session && data.user) { setUser(toUser(data.session)); return { confirmed: true }; }
    return { confirmed: false };
  }

  async function doRename(name) {
    const sb = await ensureClient();
    const { data, error } = await sb.auth.updateUser({ data: { nickname: name } });
    if (error) throw new Error(friendly(error.message));
    // onAuthStateChange 也会推 USER_UPDATED，这里手动兜底一次（幂等）
    if (data?.user) {
      setUser({ id: data.user.id, email: data.user.email ?? user?.email ?? '', nickname: name });
    } else if (user !== null) {
      setUser({ ...user, nickname: name });
    }
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

  /* ── 改名模态 ── */
  const rui = {
    modal: document.getElementById('rename-modal'),
    input: document.getElementById('rename-input'),
    submit: document.getElementById('rename-submit'),
    msg: document.getElementById('rename-msg'),
    close: document.getElementById('rename-close'),
  };
  let ruiBound = false;

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

  function openRenameModal() {
    if (rui.modal === null) return;
    rui.input.value = user !== null && user.nickname !== '' ? user.nickname : sanitizeName(user?.email);
    rui.msg.textContent = '';
    rui.modal.hidden = false;
    document.body.classList.add('modal-open');
    setTimeout(() => { rui.input.focus(); rui.input.select(); }, 30);
  }

  function closeRenameModal() {
    if (rui.modal === null) return;
    rui.modal.hidden = true;
    document.body.classList.remove('modal-open');
    rui.msg.textContent = '';
  }

  function bindUi() {
    if (uiBound || ui.modal === null) return;
    uiBound = true;
    ui.close.addEventListener('click', closeModal);
    ui.modal.addEventListener('click', (e) => { if (e.target === ui.modal) closeModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (rui.modal !== null && rui.modal.hidden === false) { closeRenameModal(); return; }
      if (ui.modal.hidden === false) closeModal();
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
            ui.msg.textContent = '注册成功。请先到收件箱点确认链接（会跳回本站并自动登录）；已注册的邮箱请直接登录。';
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

  function bindRenameUi() {
    if (ruiBound || rui.modal === null) return;
    ruiBound = true;
    rui.close.addEventListener('click', closeRenameModal);
    rui.modal.addEventListener('click', (e) => { if (e.target === rui.modal) closeRenameModal(); });
    rui.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') rui.submit.click(); });
    rui.submit.addEventListener('click', async () => {
      const name = rui.input.value.trim()
        .replace(/[^A-Za-z0-9_\u4e00-\u9fa5-]/g, '').slice(0, 16);
      if (name.length < 2) { rui.msg.textContent = '昵称至少 2 个字符（中英文、数字、- _）'; return; }
      rui.submit.disabled = true;
      rui.msg.textContent = '…';
      try {
        await doRename(name);
        // 当前对局内的名字不会实时变（协议没有改名消息），提示下次生效
        rui.msg.textContent = '已保存，下次进入对局时生效';
        setTimeout(closeRenameModal, 700);
      } catch (err) {
        rui.msg.textContent = friendly(err?.message ?? err);
        rui.submit.disabled = false;
      }
    });
  }

  /* ── 顶栏入口（所有 .auth-slot 同步渲染） ── */
  function displayName() {
    if (user === null) return '';
    return user.nickname !== '' ? user.nickname : sanitizeName(user.email);
  }

  function renderSlots() {
    for (const slot of document.querySelectorAll('.auth-slot')) {
      if (!enabled) { slot.innerHTML = ''; continue; }
      if (user === null) {
        slot.innerHTML = '<button class="btn btn-sm auth-enter" type="button">登录 / 注册</button>';
        const b = slot.querySelector('.auth-enter');
        b.addEventListener('click', () => openModal('登录后即可进入游戏'));
      } else {
        slot.innerHTML =
          `<span class="auth-user">你好，<b>${esc(displayName())}</b></span>` +
          '<button class="ghost-btn btn-sm auth-rename" type="button">改名</button>' +
          '<button class="ghost-btn btn-sm auth-exit" type="button">退出</button>';
        slot.querySelector('.auth-rename').addEventListener('click', openRenameModal);
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

  /* ── 邮件确认链接落点：?token_hash=xxx&type=signup（emailRedirectTo 指回本页）。
   * 点链接 → verifyOtp 确认邮箱并自动登录 → 清理 URL 参数（保留 mode/room 等其它参数）。 ── */
  function rewriteUrl(p) {
    const q = p.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
  }

  async function verifyFromUrl(sb) {
    const p = new URLSearchParams(location.search);
    const tokenHash = p.get('token_hash');
    const type = p.get('type');
    if (!tokenHash) return;
    if (type !== 'signup' && type !== 'email') { p.delete('token_hash'); p.delete('type'); rewriteUrl(p); return; }
    try {
      const { error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type });
      if (error) {
        openModal('邮箱验证');
        ui.msg.textContent = '验证链接无效或已使用过：' + friendly(error.message);
      } else {
        closeModal(); // 已自动登录，别让门禁模态挡着
      }
    } catch {
      openModal('邮箱验证');
      ui.msg.textContent = '邮箱验证失败，请直接登录';
    }
    p.delete('token_hash');
    p.delete('type');
    rewriteUrl(p);
  }

  /* ── 启动：读本地会话 + 处理邮件确认链接 ── */
  bindUi();
  bindRenameUi();
  renderSlots();
  if (enabled) {
    (async () => {
      try {
        const sb = await ensureClient();
        sb.auth.onAuthStateChange((_evt, session) => setUser(toUser(session)));
        await verifyFromUrl(sb);
        const { data } = await sb.auth.getSession();
        if (data?.session) setUser(toUser(data.session));
      } catch (err) {
        // Supabase 不可用：降级为不门禁（本地会话也没有，按访客玩）
        console.warn('[auth] Supabase 不可用，已关闭登录门禁：' + String(err));
        enabled = false;
        renderSlots();
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
    displayName,
    waitLogin() {
      if (user !== null) return Promise.resolve();
      return new Promise((resolve) => {
        const fn = (u) => { if (u !== null) { listeners.delete(fn); resolve(); } };
        listeners.add(fn);
      });
    },
    openModal,
    closeModal,
    openRenameModal,
    closeRenameModal,
    async signIn(email, password) { return doSignIn(email, password); },
    async signUp(email, password) { return doSignUp(email, password); },
    async rename(name) { return doRename(name); },
    async signOut() {
      try { if (client !== null) await client.auth.signOut(); } catch { /* 忽略 */ }
      setUser(null);
    },
  };
}
