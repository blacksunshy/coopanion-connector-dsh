/**
 * 自动转发开关的持久化。
 *
 * DSH 插件上下文不直接暴露 profile 路径，但 DSH 桌面端在启动插件时注入
 * `DSH_PROFILE_DIR` 环境变量（值即 `<profile 根>`，例如
 * `C:\Users\WIT_User\.dsh\profiles\desktop`）。读不到时退回进程工作目录。
 *
 * 持久化失败只丢状态、不阻断桥——插件加载时 `apply()` 里会再从文件读一次，
 * 读不到就用 AgentRegistry 的默认值（现已改为 true，即"从没设置过 = 默认开"）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FILE = 'coopanion-forward.json';

export function forwardStatePath(): string {
  return join(process.env.DSH_PROFILE_DIR ?? process.cwd(), FILE);
}

/**
 * 读上次保存的开关值。
 *
 * - 文件不存在、无法解析、或 `forward` 不是 boolean → 返回 null
 *   （让调用方决定用默认值还是保留现状）
 * - 文件存在且合法 → 返回保存的 boolean
 */
export function readForwardState(): boolean | null {
  try {
    const parsed = JSON.parse(readFileSync(forwardStatePath(), 'utf8')) as { forward?: unknown };
    return typeof parsed.forward === 'boolean' ? parsed.forward : null;
  } catch {
    return null;
  }
}

/** 把当前开关值写回 profile 下的 json。写失败静默吞。 */
export function writeForwardState(forward: boolean): void {
  try {
    const path = forwardStatePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ forward }, null, 2)}\n`, 'utf8');
  } catch {
    // 只丢状态，不阻断桥
  }
}
