/**
 * 最小 .env 加载（零依赖）：项目根若存在 .env，用 Node 内置 `process.loadEnvFile` 读入。
 *
 * 注意：必须在 `config.ts` 之前 import —— ESM 按 import 顺序求值，
 * 本模块先跑完，config.ts 才能读到 .env 里的值。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '.env');

try {
  const loadEnv = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (existsSync(envPath) && typeof loadEnv === 'function') loadEnv(envPath);
} catch {
  /* .env 缺失或格式错误：忽略，继续用代码默认值 */
}
