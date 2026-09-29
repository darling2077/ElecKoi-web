/**
 * 给验收租户装一个"够用就好"的模型配置。
 *
 * 为什么现在必须有它：**v0.2.0 起 `command.conversations.create` 会立刻创建 agent 会话**
 * 并解析当前 chat 模型，没有可用配置就直接抛「请先在设置里填写模型 API Key。」
 * —— 以前不配模型也能建会话，所以老的验收脚本会突然炸在"建会话"这一步。
 *
 * `baseUrl` 缺省指向一个不会被访问的地址（只建会话、不跑回合的验收用它就够）；
 * 真要跑 Agent 回合的（agent / quota 等）请传自己的 mock 服务地址与模型名。
 */
export interface StubModelDispatch {
  <T>(name: string, input: unknown): Promise<T>
}

export async function installStubModel(
  dispatch: StubModelDispatch,
  options: { name?: string; baseUrl?: string; model?: string } = {}
): Promise<string | undefined> {
  const name = options.name ?? 'Stub 模型'
  const model = options.model ?? 'stub-model'
  const configs = await dispatch<Array<{ id: string; name: string }>>('command.models.save', {
    name,
    provider: 'custom',
    api_key: 'stub-key',
    base_url: options.baseUrl ?? 'http://127.0.0.1:9',
    proxy_url: '',
    model,
    model_options: [],
    custom_headers: {},
    supports_tools: null,
    enabled: true,
    image_settings: {},
    api_format: 'chat_completions'
  })
  // models.ensureDefault() 可能先建过一个默认配置，因此按名字取回我们自己写的那个。
  const configId = configs.find((config) => config.name === name)?.id
  await dispatch('command.settings.write', {
    key: 'models.active',
    value: { capability: 'chat', config_id: configId, model }
  })
  return configId
}
