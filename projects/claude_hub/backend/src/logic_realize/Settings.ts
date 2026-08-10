// 全局设置（实现）：读写 data/settings.json。
import * as fs from 'fs';
import { SettingsStruct, AppSettings, QuickGroup, ToolPrefMap } from '../logic_struct/SettingsStruct';
import type { ToolId } from '../logic_struct/ToolchainStruct';
import { Paths } from '../paths';

// 运行环境面板里可选来源的工具（与 ToolchainStruct.ToolId 一致；type-only 导入不产生运行时循环依赖）
const TOOL_IDS: ToolId[] = ['node', 'git', 'claude', 'codex'];

export class Settings extends SettingsStruct {
  protected static _read(): AppSettings | null {
    try {
      if (!fs.existsSync(Paths.SETTINGS_FILE)) return null;
      return JSON.parse(fs.readFileSync(Paths.SETTINGS_FILE, 'utf8')) as AppSettings;
    } catch {
      return null;
    }
  }

  protected static _write(s: AppSettings): void {
    fs.writeFileSync(Paths.SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
  }

  // 清洗自定义快捷标签分组：标签去空白/去重（同组内）、丢弃空组，上限 10 组 × 10 标签
  protected static _sanitizeQuickGroups(raw: unknown): QuickGroup[] {
    if (!Array.isArray(raw)) return [];
    const out: QuickGroup[] = [];
    for (const g of raw.slice(0, 10)) {
      if (!g || typeof g !== 'object') continue;
      const src = Array.isArray((g as any).tags) ? (g as any).tags : [];
      const seen = new Set<string>();
      const tags: { label: string }[] = [];
      for (const t of src) {
        const label = typeof t === 'string' ? t : t && typeof t.label === 'string' ? t.label : '';
        const clean = label.trim().slice(0, 40);
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        tags.push({ label: clean });
        if (tags.length >= 10) break;
      }
      if (tags.length === 0) continue;
      const name = typeof (g as any).name === 'string' ? (g as any).name.trim().slice(0, 40) : '';
      out.push({ name: name || `组${out.length + 1}`, tags });
    }
    return out;
  }

  // 清洗工具来源偏好：只认已知工具 id 与 auto/system/bundled 三种取值；
  // 未设置过的工具回落到旧字段 preferBundled 的迁移值（true → bundled，否则 auto）。
  protected static _sanitizeToolPrefs(raw: unknown, legacyPreferBundled: boolean): ToolPrefMap {
    const fallback = legacyPreferBundled ? 'bundled' : 'auto';
    const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const out: ToolPrefMap = {};
    for (const id of TOOL_IDS) {
      const v = src[id];
      out[id] = v === 'auto' || v === 'system' || v === 'bundled' ? v : fallback;
    }
    return out;
  }
}
