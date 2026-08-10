// 过程轨迹存储（实现）：落盘位置、jsonl 反推、合并去重、耗时计算与统计聚合。
// 落盘：data/traces/<rootId>/<claudeSessionId>.jsonl，一行一个 TraceEvent（不截断任何字段）。
// 跨平台：全部走 path.join + fs，无 shell 依赖。
import * as path from 'path';
import { TraceStoreStruct, TraceInput } from '../logic_struct/TraceStoreStruct';
import { JsonlStore } from '../helper/JsonlStore';
import { ClaudeStoreHelper } from '../helper/ClaudeStoreHelper';
import { Paths } from '../paths';
import { RootManager } from './RootManager';
import { TraceEvent, TraceStats, TraceToolStat, TraceSlow, TraceTaskStat } from '../models/Types';

interface RawFrame {
  type?: string;
  timestamp?: string;
  uuid?: string;
  message?: { role?: string; model?: string; content?: unknown; usage?: Record<string, unknown> };
  toolUseResult?: unknown;
}

export class TraceStore extends TraceStoreStruct {
  // 每会话的自增序号（进程内）。重启后从已落盘的最大 seq 续接，保证单调。
  private static _seq = new Map<string, number>();

  static file(sessionId: string): string {
    if (!sessionId) throw new Error(`TraceStore.file: invalid sessionId=${sessionId}`);
    const { rootId, uuid } = this._split(sessionId);
    return path.join(Paths.TRACES_DIR, this._safe(rootId), `${this._safe(uuid)}.jsonl`);
  }

  protected static _stamp(sessionId: string, ev: TraceInput): TraceEvent {
    const seq = this._nextSeq(sessionId);
    return { ...ev, seq, ts: ev.ts || Date.now(), source: 'live' } as TraceEvent;
  }

  protected static _append(sessionId: string, ev: TraceEvent): void {
    JsonlStore.append(this.file(sessionId), ev);
  }

  protected static _readLive(sessionId: string): TraceEvent[] {
    return JsonlStore.readAll<TraceEvent>(this.file(sessionId)).map((e) => ({ ...e, source: 'live' }));
  }

  // 从 claude 自己的 jsonl 反推事件。会话是 codex 的 / 文件不存在 / 根目录已删 → 返回 []
  protected static _readJsonl(sessionId: string, includeRaw: boolean): TraceEvent[] {
    const { rootId, uuid } = this._split(sessionId);
    if (!uuid || uuid.startsWith('draft-')) return [];
    let rootPath = '';
    try {
      rootPath = RootManager.getRoot(rootId).path;
    } catch {
      return [];
    }
    if (!ClaudeStoreHelper.sessionExists(rootPath, uuid)) return [];

    const out: TraceEvent[] = [];
    let seq = 0;
    for (const ln of ClaudeStoreHelper.readLines(ClaudeStoreHelper.sessionFile(rootPath, uuid))) {
      const f = this._parseFrame(ln);
      if (!f) continue;
      const ts = f.timestamp ? Date.parse(f.timestamp) || 0 : 0;
      const blocks = Array.isArray(f.message?.content) ? (f.message!.content as any[]) : null;

      if (!blocks) {
        if (includeRaw) out.push(this._jsonlEvent(seq++, ts, { kind: 'raw', name: f.type, raw: f }));
        continue;
      }

      let usageAttached = false;
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        // 每帧的 usage/model 只挂在该帧第一个事件上，避免聚合时重复计数
        const extra = usageAttached
          ? {}
          : { model: f.message?.model, usage: f.message?.usage };
        if (f.message?.usage || f.message?.model) usageAttached = true;

        if (b.type === 'thinking') {
          // claude 落盘时会抹掉 thinking 正文（只剩 signature），这里如实反映为空文本
          out.push(this._jsonlEvent(seq++, ts, { kind: 'thinking', text: String(b.thinking || ''), ...extra }));
        } else if (b.type === 'text') {
          out.push(this._jsonlEvent(seq++, ts, { kind: 'text', text: String(b.text || ''), ...extra }));
        } else if (b.type === 'tool_use') {
          out.push(
            this._jsonlEvent(seq++, ts, {
              kind: 'tool_use',
              name: String(b.name || 'tool'),
              toolId: String(b.id || ''),
              input: b.input,
              ...extra,
            }),
          );
        } else if (b.type === 'tool_result') {
          out.push(
            this._jsonlEvent(seq++, ts, {
              kind: 'tool_result',
              toolId: String(b.tool_use_id || ''),
              output: this._text(b.content),
              isError: !!b.is_error,
              // toolUseResult 是 claude 附带的结构化结果（如文件内容/命令退出码），一并留存
              raw: f.toolUseResult,
              ...extra,
            }),
          );
        } else if (includeRaw) {
          out.push(this._jsonlEvent(seq++, ts, { kind: 'raw', name: String(b.type || ''), raw: b }));
        }
      }
    }
    return out;
  }

  // 合并：jsonl 为权威（text/tool_use/tool_result 以它为准），live 只补 jsonl 没有的种类。
  // jsonl 为空（终端外的 codex 会话 / 文件被删）时，live 全量保留。
  protected static _merge(live: TraceEvent[], jsonl: TraceEvent[]): TraceEvent[] {
    if (jsonl.length === 0) return [...live].sort(this._byTime);
    const dupKinds = new Set(['text', 'tool_use', 'tool_result']);
    const liveKept = live.filter((e) => !dupKinds.has(e.kind));
    return [...jsonl, ...liveKept].sort(this._byTime);
  }

  // 标注耗时：tool_result.durationMs = 与同 toolId 的 tool_use 间隔；每个事件的 gapMs = 与前一事件间隔
  protected static _annotate(events: TraceEvent[]): TraceEvent[] {
    const useTs = new Map<string, number>();
    for (const e of events) {
      if (e.kind === 'tool_use' && e.toolId) useTs.set(e.toolId, e.ts);
    }
    let prev = 0;
    return events.map((e) => {
      const gapMs = prev ? Math.max(0, e.ts - prev) : 0;
      prev = e.ts;
      const start = e.kind === 'tool_result' && e.toolId ? useTs.get(e.toolId) : undefined;
      const durationMs = start ? Math.max(0, e.ts - start) : undefined;
      return durationMs !== undefined ? { ...e, gapMs, durationMs } : { ...e, gapMs };
    });
  }

  protected static _aggregate(sessionId: string, events: TraceEvent[]): TraceStats {
    const first = events.length ? events[0].ts : 0;
    const last = events.length ? events[events.length - 1].ts : 0;
    const spanMs = Math.max(0, last - first);

    const nameOf = new Map<string, string>();
    for (const e of events) if (e.kind === 'tool_use' && e.toolId) nameOf.set(e.toolId, e.name || 'tool');

    const tools = new Map<string, TraceToolStat>();
    const slow: TraceSlow[] = [];
    const briefOf = new Map<string, string>();
    for (const e of events) {
      if (e.kind === 'tool_use' && e.toolId) briefOf.set(e.toolId, this._brief(e.input));
    }

    let toolMs = 0;
    let toolCalls = 0;
    for (const e of events) {
      if (e.kind !== 'tool_result' || e.durationMs === undefined) continue;
      const name = (e.toolId && nameOf.get(e.toolId)) || 'tool';
      const ms = e.durationMs;
      toolMs += ms;
      toolCalls++;
      const cur = tools.get(name) || { name, count: 0, totalMs: 0, avgMs: 0, maxMs: 0 };
      cur.count++;
      cur.totalMs += ms;
      cur.maxMs = Math.max(cur.maxMs, ms);
      cur.avgMs = Math.round(cur.totalMs / cur.count);
      tools.set(name, cur);
      slow.push({ name, ms, ts: e.ts, brief: (e.toolId && briefOf.get(e.toolId)) || '' });
    }

    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
    for (const e of events) {
      if (e.costUsd) usage.costUsd += e.costUsd;
      const u = e.usage as Record<string, number> | undefined;
      if (!u) continue;
      usage.inputTokens += Number(u.input_tokens || 0);
      usage.outputTokens += Number(u.output_tokens || 0);
      usage.cacheReadTokens += Number(u.cache_read_input_tokens || 0);
      usage.cacheCreationTokens += Number(u.cache_creation_input_tokens || 0);
    }

    return {
      sessionId,
      events: events.length,
      spanMs,
      toolMs,
      modelMs: Math.max(0, spanMs - toolMs),
      toolCalls,
      byTool: [...tools.values()].sort((a, b) => b.totalMs - a.totalMs),
      slowest: slow.sort((a, b) => b.ms - a.ms).slice(0, 10),
      usage,
      byTask: this._byTask(events),
    };
  }

  protected static _moveFile(oldSessionId: string, newSessionId: string): void {
    JsonlStore.rename(this.file(oldSessionId), this.file(newSessionId));
    this._seq.delete(oldSessionId);
  }

  protected static _removeFile(sessionId: string): void {
    JsonlStore.remove(this.file(sessionId));
    this._seq.delete(sessionId);
  }

  // ── 内部纯实现 ──

  // 按任务汇总（jsonl 反推的事件统一归到 native 任务下）
  private static _byTask(events: TraceEvent[]): TraceTaskStat[] {
    const map = new Map<string, TraceTaskStat & { _toolIds: Set<string> }>();
    const nameSeen = new Map<string, string>();
    for (const e of events) {
      const id = e.taskId || 'native';
      const cur =
        map.get(id) ||
        ({ taskId: id, startedAt: e.ts, endedAt: e.ts, totalMs: 0, toolMs: 0, modelMs: 0, toolCalls: 0, _toolIds: new Set<string>() } as any);
      cur.startedAt = Math.min(cur.startedAt, e.ts);
      cur.endedAt = Math.max(cur.endedAt, e.ts);
      if (e.kind === 'tool_use' && e.toolId) nameSeen.set(e.toolId, id);
      if (e.kind === 'tool_result' && e.durationMs !== undefined) {
        cur.toolMs += e.durationMs;
        cur.toolCalls++;
      }
      map.set(id, cur);
    }
    return [...map.values()]
      .map((t) => {
        const totalMs = Math.max(0, t.endedAt - t.startedAt);
        return {
          taskId: t.taskId,
          startedAt: t.startedAt,
          endedAt: t.endedAt,
          totalMs,
          toolMs: t.toolMs,
          modelMs: Math.max(0, totalMs - t.toolMs),
          toolCalls: t.toolCalls,
        };
      })
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  private static _jsonlEvent(seq: number, ts: number, part: Partial<TraceEvent>): TraceEvent {
    return { seq, ts, taskId: 'native', source: 'jsonl', kind: 'raw', ...part } as TraceEvent;
  }

  private static _parseFrame(ln: string): RawFrame | null {
    try {
      return JSON.parse(ln) as RawFrame;
    } catch {
      return null;
    }
  }

  // tool_result 的 content 可能是字符串或块数组，统一成完整文本（不截断）
  private static _text(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((c: any) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : JSON.stringify(c)))
        .join('\n');
    }
    if (content === undefined || content === null) return '';
    return JSON.stringify(content);
  }

  private static _brief(input: unknown): string {
    try {
      const s = typeof input === 'string' ? input : JSON.stringify(input);
      return s.length > 200 ? s.slice(0, 200) + '…' : s;
    } catch {
      return '';
    }
  }

  private static _byTime(a: TraceEvent, b: TraceEvent): number {
    return a.ts - b.ts || a.seq - b.seq;
  }

  private static _nextSeq(sessionId: string): number {
    let n = this._seq.get(sessionId);
    if (n === undefined) {
      const existing = JsonlStore.readAll<TraceEvent>(this.file(sessionId));
      n = existing.reduce((m, e) => Math.max(m, Number(e.seq) || 0), 0);
    }
    n += 1;
    this._seq.set(sessionId, n);
    return n;
  }

  // sessionId = `<rootId>:<uuid>`；无冒号时整串当 uuid，rootId 归入 _misc
  private static _split(sessionId: string): { rootId: string; uuid: string } {
    const i = sessionId.indexOf(':');
    if (i < 0) return { rootId: '_misc', uuid: sessionId };
    return { rootId: sessionId.slice(0, i), uuid: sessionId.slice(i + 1) };
  }

  // 文件名安全化：非字母数字下划线短横一律替换，避免 id 里的字符击穿路径
  private static _safe(s: string): string {
    return (s || '_').replace(/[^a-zA-Z0-9_-]/g, '_');
  }
}
