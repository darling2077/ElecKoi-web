/**
 * 我们自己的页面（登录/账号/用户管理）与应用之间的主题桥。
 *
 * 这些页面是独立文档，拿不到应用的运行时设置，但既然要「和应用是一套 UI」，
 * 就不能固定成暗色或亮色：必须跟随该账号在应用里的 `appearance.mode`。
 *
 * 一个容易踩的点：上游 `UserSettingsStore` 里 `appearance.mode` 的**默认值是 light**
 * （`nativeTheme.themeSource = 存储值 ?? 'light'`），与操作系统无关。
 * 所以"读不到设置"时要落到 light，而不是 system——否则系统是暗色的用户
 * 会看到亮色的应用里弹出暗色的账号页。
 */

export type PageTheme = 'light' | 'dark' | 'system'

/** 登录页用来记住上次登录时主题的键。 */
const STORAGE_KEY = 'eleckoi:theme'

/**
 * 把上游的 appearance.mode 收敛成本模块的取值。
 * 未知值（含"这一行还不存在"）落到 light，与应用默认一致。
 */
export function normalizeTheme(value: unknown): PageTheme {
  return value === 'dark' ? 'dark' : value === 'system' ? 'system' : 'light'
}

/**
 * 主题引导脚本（不含 <script> 标签本身），放在 <head> 里同步执行——
 * 等 CSS 加载完再改就会先亮后暗地闪一下。
 *
 * @param mode      应用里的设置
 * @param remember  是否把解析结果记到 localStorage（供登录页复用）
 */
function bootstrap(mode: PageTheme | null, remember: boolean): string {
  return `
(function () {
  var KEY = ${JSON.stringify(STORAGE_KEY)};
  // null 表示"还不知道是谁"（登录页）：用上次登录时的主题，没有就按应用默认的亮色。
  var stored = null;
  try { stored = window.localStorage.getItem(KEY); } catch (error) { /* 隐私模式下不可用 */ }
  var mode = ${mode === null ? 'null' : JSON.stringify(mode)} || stored || 'light';
  var query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function apply() {
    var resolved = mode === 'system' ? (query && query.matches ? 'dark' : 'light') : mode;
    document.documentElement.dataset.theme = resolved;
    ${remember ? 'try { window.localStorage.setItem(KEY, resolved); } catch (error) {}' : ''}
  }
  apply();
  if (mode === 'system' && query) {
    if (query.addEventListener) query.addEventListener('change', apply);
    else if (query.addListener) query.addListener(apply);
  }
})();`
}

/** 账号/用户管理页：按该账号在应用里的设置，并记下结果供登录页下次使用。 */
export function themeBootstrap(theme: PageTheme): string {
  return bootstrap(theme, true)
}

/** 登录页：此时还不知道是谁，沿用上次登录时的主题；没有则按应用默认（亮色）。 */
export function loginThemeBootstrap(): string {
  return bootstrap(null, false)
}
