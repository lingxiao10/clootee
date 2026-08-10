// 引擎服务商配置（调度骨架）：claude / codex 各自选择「原版 / minimax / kimi」，
// 第三方需填 apiKey 并选 model（模型列表实时从服务商拉取）。
// - claude：第三方走 Anthropic 兼容端点，托管环境变量（MANAGED_ENV_KEYS）同时注入本进程
//   和 ~/.claude/settings.json 的 env 段，两处始终一致。
// - 模型列表：走服务商 OpenAI 兼容 /v1/models（实时），**无内置兜底**，失败即报错让用户改 Key。
// 具体 IO（读写 data/engines.json、HTTP 拉取、写 ~/.claude/settings.json）由 Realize 实现。
import {
  EnginesConfig,
  EngineProvider,
  EngineProviderConfig,
  ModelDetect,
  ModelOption,
} from '../models/Types';
import { EnvHelper } from '../helper/EnvHelper';

// 各服务商元信息（域内配置，非通用 helper）
export interface ProviderMeta {
  anthropicBase: string; // 供 claude 第三方使用的 Anthropic 兼容 base_url
  chatBase: string;      // OpenAI Chat Completions 兼容 base_url（供 Codex 内置转换代理）
  modelsUrl: string;     // OpenAI 兼容模型列表端点
  // ── 以下供前端「新手引导」展示：名称、开通/购买入口、使用指南、一句话说明 ──
  label: string;
  signupUrl: string;  // 注册并创建 API Key 的页面
  docsUrl: string;    // 官方文档
  note: string;       // 一句话卖点/提示（新手看这句就够）
  vision?: boolean;   // 是否支持图片识别（前端会标出「支持图片识别」）
  recommended?: boolean; // 是否首推（前端「推荐」角标；国产模型里目前首推 MiniMax）
  extraEnv?: Record<string, string>; // 该服务商官方要求的额外环境变量（键必须在 MANAGED_ENV_KEYS 内）
  // 自动选默认模型时的偏好顺序（不区分大小写的子串匹配）。
  // ⚠ 这不是兜底模型列表：只用于在服务商 API **真实返回**的 id 里排序挑一个，
  //   API 返回空仍然照旧报错（见 listModels），绝不拿写死的名字去请求。
  preferModels?: string[];
}

// 由本工具托管的 claude 环境变量：既注入 process.env，也写进 ~/.claude/settings.json 的 env 段。
// 切回原版订阅时这些键会被一并清除（不碰用户自己加的其他键）。
export const MANAGED_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  // claude 会按 sonnet/opus/haiku 别名请求模型，第三方端点不认这些别名 → 三个都指向选定模型
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_EFFORT_LEVEL',
];

// 顺序即前端展示顺序：首推的服务商放最前
export const PROVIDERS: Record<Exclude<EngineProvider, 'official' | 'custom'>, ProviderMeta> = {
  minimax: {
    anthropicBase: 'https://api.minimaxi.com/anthropic',
    chatBase: 'https://api.minimaxi.com/v1',
    modelsUrl: 'https://api.minimaxi.com/v1/models',
    label: 'MiniMax',
    signupUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    docsUrl: 'https://platform.minimaxi.com/docs/token-plan/claude-code',
    note: 'MiniMax 最新模型（列表实时拉取），代码能力强且支持图片识别，国产模型首推',
    vision: true,
    recommended: true,
    // 官方 Claude Code 接入文档要求：把自动压缩窗口对齐到 1M 上下文
    extraEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' },
    // 官方文档推荐 M3（M2.x 只有 text+tools，图片识别要 M3）
    preferModels: ['MiniMax-M3', 'MiniMax-M2'],
  },
  xiaomi: {
    anthropicBase: 'https://api.xiaomimimo.com/anthropic',
    chatBase: 'https://api.xiaomimimo.com/v1',
    modelsUrl: 'https://api.xiaomimimo.com/v1/models',
    label: '小米 MiMo',
    signupUrl: 'https://platform.xiaomimimo.com',
    docsUrl: 'https://platform.xiaomimimo.com/docs',
    note: '小米自研模型，国内直连',
  },
  kimi: {
    anthropicBase: 'https://api.moonshot.cn/anthropic',
    chatBase: 'https://api.moonshot.cn/v1',
    modelsUrl: 'https://api.moonshot.cn/v1/models',
    label: 'Kimi（月之暗面）',
    signupUrl: 'https://platform.moonshot.cn/console/api-keys',
    docsUrl: 'https://platform.moonshot.cn/docs',
    note: '国内直连，长上下文见长，需充值后使用',
    extraEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1048576', CLAUDE_CODE_EFFORT_LEVEL: 'max' },
  },
};

// 第三方服务商 id 列表（唯一来源：PROVIDERS 的键，新增服务商只需改 PROVIDERS）
export const THIRD_PARTY_PROVIDERS = Object.keys(PROVIDERS) as Exclude<EngineProvider, 'official' | 'custom'>[];

// 某字符串是否为合法服务商 id
export function isProvider(v: unknown): v is EngineProvider {
  return v === 'official' || v === 'custom' || (typeof v === 'string' && v in PROVIDERS);
}

const DEFAULT: EnginesConfig = {
  claude: { provider: 'official', apiKey: '', model: '' },
  codex: { provider: 'official', apiKey: '', model: '' },
};

export class EngineConfigStruct {
  // 读取配置（缺失回退 official）
  static get(): EnginesConfig {
    const raw = this._read();
    return {
      claude: this._normalize(raw?.claude),
      codex: this._normalize(raw?.codex),
    };
  }

  // 更新某引擎的服务商配置；写盘后应用 claude 环境变量到本进程
  static setProvider(engine: keyof EnginesConfig, cfg: EngineProviderConfig): EnginesConfig {
    if (engine !== 'claude' && engine !== 'codex')
      throw new Error(`setProvider: invalid engine=${engine}`);
    const provider = cfg?.provider;
    if (!isProvider(provider))
      throw new Error(`setProvider: invalid provider=${provider}（可选 official/${THIRD_PARTY_PROVIDERS.join('/')}）`);
    if (provider !== 'official' && (!cfg.apiKey || !cfg.apiKey.trim()))
      throw new Error(`setProvider: ${provider} 需要填写 API Key`);
    if (provider === 'custom') this._assertUrl(cfg.baseUrl, 'Base URL');
    // 无兜底模型：claude 走第三方端点时必须选定真实模型，否则 claude 会按 sonnet 别名请求 → 对方 404
    if (engine === 'claude' && provider !== 'official' && !(cfg.model || '').trim())
      throw new Error(`setProvider: ${provider} 需要先「拉取模型」并选定一个模型`);
    const next = this.get();
    const prev = next[engine];
    // 模型跟随服务商：换回 official 时模型是可选项（不像第三方那样强制校验非空），
    // 若不强制清空，前端残留的旧服务商模型 id 会被当成 official 的选定模型一路传下去
    // （ClaudeRunner/CodexRunner 对 official 同样会把 cfg.model 当 --model/-m 传给 CLI）。
    const model = provider === 'official' && provider !== prev.provider ? '' : (cfg.model || '').trim();
    next[engine] = {
      provider,
      apiKey: (cfg.apiKey || '').trim(),
      model,
      baseUrl: provider === 'custom' ? this._cleanUrl(cfg.baseUrl || '') : undefined,
      modelsUrl: provider === 'custom' && cfg.modelsUrl
        ? this._cleanUrl(cfg.modelsUrl)
        : undefined,
      // 换服务商时候选列表已失效（不同服务商模型不同），清掉；检测结果同理
      models: provider === prev.provider ? prev.models : undefined,
      detected: provider === prev.provider ? prev.detected : undefined,
    };
    this._write(next);
    this.applyEnv();
    return this.get();
  }

  // 只改「选定模型」，不动服务商/apiKey。'' = 自动（由引擎自己决定）。
  static setModel(engine: keyof EnginesConfig, model: string): EnginesConfig {
    if (engine !== 'claude' && engine !== 'codex')
      throw new Error(`setModel: invalid engine=${engine}`);
    if (typeof model !== 'string') throw new Error(`setModel: invalid model=${model}`);
    const next = this.get();
    next[engine] = { ...next[engine], model: model.trim() };
    this._write(next);
    this.applyEnv();
    return this.get();
  }

  // 缓存检测结果（候选列表 / 当前模型），供前端下拉与状态展示
  static setCache(
    engine: keyof EnginesConfig,
    patch: { models?: ModelOption[]; detected?: ModelDetect },
  ): EnginesConfig {
    if (engine !== 'claude' && engine !== 'codex')
      throw new Error(`setCache: invalid engine=${engine}`);
    const next = this.get();
    const cur = next[engine];
    next[engine] = {
      ...cur,
      models: patch.models !== undefined ? patch.models : cur.models,
      detected: patch.detected !== undefined ? patch.detected : cur.detected,
    };
    this._write(next);
    return this.get();
  }

  // 当前 claude 服务商对应的托管环境变量（official / 未填 Key → 空对象＝全部清除）
  static claudeEnv(): Record<string, string> {
    const cfg = this.get().claude;
    if (cfg.provider === 'official') return {};
    const meta = cfg.provider === 'custom' ? null : PROVIDERS[cfg.provider];
    const baseUrl = cfg.provider === 'custom' ? cfg.baseUrl : meta?.anthropicBase;
    if (!baseUrl || !cfg.apiKey) return {};
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: cfg.apiKey,
      ...(meta?.extraEnv || {}),
    };
    if (!cfg.model) return env;
    return {
      ...env,
      ANTHROPIC_MODEL: cfg.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: cfg.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: cfg.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: cfg.model,
      ANTHROPIC_DEFAULT_FABLE_MODEL: cfg.model,
      CLAUDE_CODE_SUBAGENT_MODEL: cfg.model,
    };
  }

  static codexUpstream(): { baseUrl: string; apiKey: string; model: string; label: string } {
    const cfg = this.get().codex;
    if (cfg.provider === 'official') throw new Error('Codex 当前使用原版 ChatGPT，无第三方上游');
    const meta = cfg.provider === 'custom' ? null : PROVIDERS[cfg.provider];
    const baseUrl = cfg.provider === 'custom' ? cfg.baseUrl || '' : meta?.chatBase || '';
    if (!baseUrl || !cfg.apiKey || !cfg.model)
      throw new Error('Codex 第三方服务商缺少 Base URL、API Key 或模型');
    return {
      baseUrl: this._cleanUrl(baseUrl),
      apiKey: cfg.apiKey,
      model: cfg.model,
      label: meta?.label || '自定义服务商',
    };
  }

  // 应用 claude 服务商配置：注入本进程环境（spawn 的 claude 子进程继承）
  // + 同步写 ~/.claude/settings.json 的 env 段（用户直接开终端跑 claude 也一致）。
  // official → 两处的托管键都清除，回到订阅登录流程。
  static applyEnv(): void {
    const env = this.claudeEnv();
    EnvHelper.applyManaged(process.env, MANAGED_ENV_KEYS, env);
    this._syncClaudeSettings(env);
    const codex = this.get().codex;
    if (codex.provider !== 'official' && codex.apiKey)
      process.env.CLAUDE_HUB_CODEX_API_KEY = codex.apiKey;
    else
      delete process.env.CLAUDE_HUB_CODEX_API_KEY;
    this._syncCodexConfig(codex);
  }

  // 实时拉取某服务商模型列表（OpenAI 兼容 /v1/models）。
  // 不做任何内置兜底：Key 错/网络不通/返回空 → 直接抛错让用户改 Key，避免拿假列表去跑。
  static async listModels(
    provider: EngineProvider,
    apiKey: string,
    baseUrl = '',
    modelsUrl = '',
  ): Promise<string[]> {
    if (provider === 'official')
      throw new Error('listModels: official（原版订阅）无需选择模型');
    const meta = provider === 'custom' ? null : PROVIDERS[provider];
    if (provider !== 'custom' && !meta) throw new Error(`listModels: invalid provider=${provider}`);
    if (!apiKey || !apiKey.trim()) throw new Error('listModels: 需要填写 API Key 才能拉取模型列表');
    if (provider === 'custom') this._assertUrl(baseUrl, 'Base URL');
    const url = provider === 'custom'
      ? (modelsUrl ? this._cleanUrl(modelsUrl) : `${this._cleanUrl(baseUrl)}/models`)
      : meta!.modelsUrl;
    const ids = await this._fetchModels(url, apiKey.trim());
    if (!ids.length)
      throw new Error(
        `listModels: ${provider} 返回了空模型列表——请确认这个 API Key 属于该服务商且已开通模型权限`,
      );
    return ids;
  }

  // 在服务商 API 真实返回的模型 id 里挑一个作默认（供前端「换服务商即自动选模型」）。
  // 规则：先按该服务商的 preferModels 顺序找子串命中，都没命中就用 API 返回的第一个。
  // ⚠ 不引入任何写死的兜底模型名——ids 为空就返回 ''，由调用方按「没有可用模型」处理。
  static pickDefaultModel(provider: EngineProvider, ids: string[]): string {
    if (!Array.isArray(ids) || !ids.length) return '';
    const meta = provider === 'official' || provider === 'custom' ? null : PROVIDERS[provider];
    for (const want of meta?.preferModels || []) {
      const hit = ids.find((id) => id.toLowerCase().includes(want.toLowerCase()));
      if (hit) return hit;
    }
    return ids[0];
  }

  // 供前端「新手引导 / 设置」展示的服务商清单（含开通链接与说明）
  static providerList(): Array<{ id: EngineProvider } & Partial<ProviderMeta>> {
    return [
      {
        id: 'official' as EngineProvider,
        label: '原版（官方订阅登录）',
        note: '用已有的 Claude / ChatGPT 账号登录，不需要 API Key',
        signupUrl: 'https://claude.com/claude-code',
        docsUrl: 'https://docs.claude.com/en/docs/claude-code/overview',
      },
      ...THIRD_PARTY_PROVIDERS.map((id) => ({ id: id as EngineProvider, ...PROVIDERS[id] })),
      {
        id: 'custom' as EngineProvider,
        label: '自定义服务商',
        note: '填写兼容 Base URL、模型列表 URL 与 API Key',
      },
    ];
  }

  private static _normalize(c: EngineProviderConfig | undefined): EngineProviderConfig {
    const provider: EngineProvider = isProvider(c?.provider) ? c!.provider : 'official';
    return {
      provider,
      apiKey: c?.apiKey || '',
      model: c?.model || '',
      baseUrl: c?.baseUrl || '',
      modelsUrl: c?.modelsUrl || '',
      models: Array.isArray(c?.models) ? c!.models : undefined,
      detected: c?.detected,
    };
  }

  // ── IO 钩子（Realize 实现）──
  protected static _read(): EnginesConfig | null {
    throw new Error('Not implemented');
  }
  protected static _write(_c: EnginesConfig): void {
    throw new Error('Not implemented');
  }
  // 拉取模型 id 列表（Realize 用 HttpJson 实现）
  protected static _fetchModels(_url: string, _apiKey: string): Promise<string[]> {
    throw new Error('Not implemented');
  }
  // 把托管环境变量同步进 ~/.claude/settings.json 的 env 段（Realize 实现读改写）
  protected static _syncClaudeSettings(_env: Record<string, string>): void {
    throw new Error('Not implemented');
  }
  protected static _syncCodexConfig(_cfg: EngineProviderConfig): void {
    throw new Error('Not implemented');
  }

  private static _cleanUrl(url: string): string {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  private static _assertUrl(url: unknown, label: string): void {
    const value = this._cleanUrl(String(url || ''));
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error(`${label} 不是有效 URL`); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      throw new Error(`${label} 只支持 http/https`);
  }

  static DEFAULT = DEFAULT;
}
