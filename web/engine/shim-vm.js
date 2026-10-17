/**
 * 浏览器版 vm 垫片：数据包脚本是本机可信内容，用 new Function 直接执行。
 * （房主权威模式下，数据包由房主从 Supabase 存储桶加载，不是不可信输入。）
 */
export function createContext(obj) {
  return obj;
}

export function runInContext(code, context) {
  const keys = Object.keys(context);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...keys, code);
  fn(...keys.map((k) => context[k]));
}
