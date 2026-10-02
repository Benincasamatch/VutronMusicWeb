/**
 * Web 版登录闸门：先确认会话，再挂载既有渲染层。
 *
 * 与桌面版不同，Web 版需要站点账号（多用户隔离），因此渲染层必须在登录成功后才求值；
 * `../main.ts` 顶部会立即 createApp/mount，所以这里用动态 import 作为“运行时选择”的加载边界。
 */
import { currentUser, login, changePassword, logout, type WebUser } from './auth.ts'
import { startRealtime } from './realtime.ts'

const GATE_STYLE = `
.vw-gate {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-body-bg, #f7f7f9);
  color: var(--color-font, #121212);
  font-family: inherit;
  z-index: 9999;
  padding: 24px;
  box-sizing: border-box;
}
.vw-gate-card {
  width: min(360px, 100%);
  padding: 32px 28px;
  border-radius: 18px;
  background: var(--color-card-bg, #fff);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.16);
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.vw-gate-title { font-size: 20px; font-weight: 700; margin: 0; }
.vw-gate-sub { font-size: 12px; opacity: 0.6; margin: 0 0 6px; line-height: 1.6; }
.vw-gate-field { display: flex; flex-direction: column; gap: 6px; }
.vw-gate-field label { font-size: 12px; opacity: 0.7; }
.vw-gate input {
  height: 38px;
  border-radius: 10px;
  border: 1px solid rgba(128, 128, 128, 0.32);
  background: transparent;
  color: inherit;
  padding: 0 12px;
  font-size: 14px;
  outline: none;
}
.vw-gate input:focus { border-color: var(--color-primary, #0a84ff); }
.vw-gate button {
  height: 40px;
  border-radius: 10px;
  border: none;
  background: var(--color-primary, #0a84ff);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.vw-gate button:disabled { opacity: 0.6; cursor: default; }
.vw-gate-error { color: #ff453a; font-size: 12px; min-height: 16px; line-height: 16px; }
.vw-gate-foot { font-size: 11px; opacity: 0.5; text-align: center; }
`

function injectStyle(): void {
  if (document.getElementById('vw-gate-style')) return
  const style = document.createElement('style')
  style.id = 'vw-gate-style'
  style.textContent = GATE_STYLE
  document.head.appendChild(style)
}

interface Field {
  name: string
  label: string
  type: string
  autocomplete?: string
}

function buildCard(options: {
  title: string
  subtitle: string
  fields: Field[]
  submitText: string
  onSubmit: (values: Record<string, string>) => Promise<void>
}): HTMLElement {
  const root = document.createElement('div')
  root.className = 'vw-gate'

  const card = document.createElement('form')
  card.className = 'vw-gate-card'
  card.autocomplete = 'on'

  const title = document.createElement('h1')
  title.className = 'vw-gate-title'
  title.textContent = options.title

  const subtitle = document.createElement('p')
  subtitle.className = 'vw-gate-sub'
  subtitle.textContent = options.subtitle

  card.append(title, subtitle)

  const inputs = new Map<string, HTMLInputElement>()
  for (const field of options.fields) {
    const wrap = document.createElement('div')
    wrap.className = 'vw-gate-field'
    const label = document.createElement('label')
    label.textContent = field.label
    label.htmlFor = `vw-${field.name}`
    const input = document.createElement('input')
    input.id = `vw-${field.name}`
    input.name = field.name
    input.type = field.type
    if (field.autocomplete) input.setAttribute('autocomplete', field.autocomplete)
    wrap.append(label, input)
    card.appendChild(wrap)
    inputs.set(field.name, input)
  }

  const error = document.createElement('div')
  error.className = 'vw-gate-error'

  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.textContent = options.submitText

  const foot = document.createElement('div')
  foot.className = 'vw-gate-foot'
  foot.textContent = 'VutronMusic Web · 局域网音乐服务'

  card.append(error, submit, foot)

  card.addEventListener('submit', (event) => {
    event.preventDefault()
    const values: Record<string, string> = {}
    for (const [name, input] of inputs) values[name] = input.value
    error.textContent = ''
    submit.disabled = true
    void options
      .onSubmit(values)
      .catch((err: unknown) => {
        error.textContent = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        submit.disabled = false
      })
  })

  root.appendChild(card)
  return root
}

/**
 * 渲染层入口按需加载：main.ts 顶部会立即 createApp/mount，必须等会话确认后再执行。
 * 用 import.meta.glob 而不是 `import('../main.ts')`，既保持运行时选择语义，
 * 也避免 web/tsconfig 的类型检查把整个渲染层（.vue 需要 vue-tsc）拖进来。
 */
const appEntries = import.meta.glob('../main.ts')
/** 挂载后的 Web 专用启动流程（播放镜像 + 本地音源登录态）同样按需加载，避免被 web/tsconfig 拉入类型检查 */
const bootEntries = import.meta.glob('./bootWeb.ts')

async function mountApp(): Promise<void> {
  document.getElementById('vw-gate')?.remove()
  const load = appEntries['../main.ts']
  if (load) await load()
  startRealtime()
  const loadBoot = bootEntries['./bootWeb.ts']
  if (loadBoot) {
    const mod = (await loadBoot()) as { bootWeb?: () => void }
    mod.bootWeb?.()
  }
}

function renderGate(node: HTMLElement): void {
  document.getElementById('vw-gate')?.remove()
  node.id = 'vw-gate'
  document.body.appendChild(node)
}

/** 必须修改口令时先改密，再进入应用 */
function passwordGate(user: WebUser): HTMLElement {
  return buildCard({
    title: '请修改初始口令',
    subtitle: `${user.displayName}，首次登录必须设置新口令（至少 8 位）。`,
    fields: [
      { name: 'current', label: '当前口令', type: 'password', autocomplete: 'current-password' },
      { name: 'next', label: '新口令', type: 'password', autocomplete: 'new-password' },
      { name: 'confirm', label: '确认新口令', type: 'password', autocomplete: 'new-password' }
    ],
    submitText: '保存并进入',
    onSubmit: async (values) => {
      if (values.next.length < 8) throw new Error('新口令至少 8 位')
      if (values.next !== values.confirm) throw new Error('两次输入的新口令不一致')
      await changePassword(values.current, values.next)
      await mountApp()
    }
  })
}

function loginGate(): HTMLElement {
  return buildCard({
    title: '登录 VutronMusic',
    subtitle: '使用服务器管理员为你创建的账号登录。',
    fields: [
      { name: 'username', label: '用户名', type: 'text', autocomplete: 'username' },
      { name: 'password', label: '口令', type: 'password', autocomplete: 'current-password' }
    ],
    submitText: '登录',
    onSubmit: async (values) => {
      const result = await login(values.username, values.password)
      if (result.user.mustChangePassword) {
        renderGate(passwordGate(result.user))
        return
      }
      await mountApp()
    }
  })
}

/** 入口：确认会话后决定显示登录闸门还是直接挂载应用 */
export async function bootstrapWebApp(): Promise<void> {
  injectStyle()
  let user: WebUser | null = null
  try {
    user = await currentUser()
  } catch {
    user = null
  }

  if (user && !user.mustChangePassword) {
    await mountApp()
    return
  }
  if (user) {
    renderGate(passwordGate(user))
    return
  }
  renderGate(loginGate())
}

/** 退出登录：断开实时通道并回到登录页 */
export async function logoutToGate(): Promise<void> {
  await logout()
  window.location.reload()
}
