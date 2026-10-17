/**
 * 房主权威模式的传输层：
 *  - 配了 Supabase（__SUPABASE_URL / __SUPABASE_ANON_KEY）→ Supabase Realtime Broadcast；
 *  - 没配 → 同浏览器 BroadcastChannel（本地多标签调试）。
 */
export async function createTransport(roomId, onMessage) {
  const url = String(window.__SUPABASE_URL ?? '').trim();
  const key = String(window.__SUPABASE_ANON_KEY ?? '').trim();
  const forceLocal = window.__ALSF_TRANSPORT === 'local'
    || new URLSearchParams(location.search).get('transport') === 'local';
  if (!forceLocal && url !== '' && key !== '') {
    try {
      const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
      const sb = createClient(url, key);
      const ch = sb.channel('alsf:' + roomId, { config: { broadcast: { self: false } } });
      ch.on('broadcast', { event: 'msg' }, (p) => onMessage(p.payload));
      await ch.subscribe();
      return {
        kind: 'supabase',
        send: (m) => { void ch.send({ type: 'broadcast', event: 'msg', payload: m }); },
        close: () => { void ch.unsubscribe(); void sb.removeChannel(ch); },
      };
    } catch (err) {
      console.warn('[transport] Supabase Realtime 不可用，回退 BroadcastChannel：' + String(err));
    }
  }
  const bc = new BroadcastChannel('alsf:' + roomId);
  bc.onmessage = (e) => onMessage(e.data);
  return {
    kind: 'local',
    send: (m) => bc.postMessage(m),
    close: () => bc.close(),
  };
}
