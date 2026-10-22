export type PwaDisplayPreference = "fullscreen" | "standalone";
export type RuntimePwaDisplayMode = "fullscreen" | "standalone" | "minimal-ui" | "browser";
export type PwaHostedSurface = "custom-app" | "game";

export type PwaHostedSafeArea = {
  top: string;
  right: string;
  bottom: string;
  left: string;
  /* 宿主顶部浮层（胶囊按钮/悬浮返回钮）所在行的几何：想跟宿主按钮同排摆自己
     顶栏的应用用这组值贴行对齐，只需避开水平占位，不必整体让到 top 之下。 */
  barTop: string;
  barHeight: string;
  barClearLeft: string;
  barClearRight: string;
};

/** 宿主实测的浮层几何（px）；缺项用各表面的估算值兜底。 */
export type PwaHostedOverlayMetrics = {
  topPx?: number | null;
  barTopPx?: number | null;
  barHeightPx?: number | null;
  barClearLeftPx?: number | null;
  barClearRightPx?: number | null;
};

export const PWA_DISPLAY_MODE_COOKIE = "pwa_display_mode";
export const PWA_DISPLAY_MODE_CHANGED_EVENT = "pwa-display-mode-changed";
export const DEFAULT_PWA_DISPLAY_PREFERENCE: PwaDisplayPreference = "fullscreen";

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function readPwaDisplayPreference(cookie: string): PwaDisplayPreference | null {
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${PWA_DISPLAY_MODE_COOKIE}=([^;]+)`));
  if (!match) return null;
  const value = decodeCookieValue(match[1]);
  return value === "fullscreen" || value === "standalone" ? value : null;
}

export function writePwaDisplayPreference(preference: PwaDisplayPreference) {
  if (typeof document === "undefined") return;
  document.cookie = `${PWA_DISPLAY_MODE_COOKIE}=${preference}; path=/; max-age=31536000; samesite=lax`;
  window.dispatchEvent(new CustomEvent(PWA_DISPLAY_MODE_CHANGED_EVENT, { detail: preference }));
}

/** Preserve the upstream default: mobile browsers request fullscreen unless Edge or explicitly disabled. */
export function shouldRequestPwaFullscreen(): boolean {
  if (typeof document === "undefined" || typeof navigator === "undefined") return false;
  const preference = readPwaDisplayPreference(document.cookie);
  if (preference === "standalone") return false;
  if (preference === "fullscreen") return true;
  return !/Edg/i.test(navigator.userAgent);
}

/** ── 「全屏与方向锁」用户可选策略 ──
 *  全屏和锁方向是绑在一起的：只有进了全屏，`screen.orientation.lock` 才被允许；
 *  而不少国产壳接受全屏却拒绝锁方向（2026-10-20 真机日志实测），于是全屏变成了
 *  "画面躺倒 + 连地址栏都没有"。默认口径是"锁不住就退回浏览器态"——竖屏可用优先。
 *  这里给设置面板留出反悔的口子：
 *  - auto   默认。请求全屏，锁得住才留；锁不住立刻退出全屏（露地址栏但绝不躺倒）。
 *  - always 沉浸优先。锁不住也留在全屏里，方向交给浏览器自己（横屏风险自负）。
 *  - never  从不请求全屏。一定竖屏，代价是浏览器界面一直在。
 *  存 localStorage 而不是 cookie：这是纯端上的显示策略，不参与 manifest 计算
 *  （装到桌面的形态归上面那个 cookie 管），也不需要服务端知道。 */
export const IMMERSIVE_POLICY_STORAGE_KEY = "aiphone_immersive_fullscreen_policy";
export const IMMERSIVE_POLICY_CHANGED_EVENT = "aiphone-immersive-fullscreen-policy-changed";
export type ImmersiveFullscreenPolicy = "auto" | "always" | "never";
const IMMERSIVE_POLICIES: ImmersiveFullscreenPolicy[] = ["auto", "always", "never"];

export function readImmersiveFullscreenPolicy(): ImmersiveFullscreenPolicy {
  if (typeof window === "undefined") return "auto";
  try {
    const raw = window.localStorage.getItem(IMMERSIVE_POLICY_STORAGE_KEY);
    return IMMERSIVE_POLICIES.includes(raw as ImmersiveFullscreenPolicy)
      ? (raw as ImmersiveFullscreenPolicy)
      : "auto";
  } catch {
    /* 无痕模式 / 存储被禁：按默认口径走 */
    return "auto";
  }
}

export function writeImmersiveFullscreenPolicy(policy: ImmersiveFullscreenPolicy) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(IMMERSIVE_POLICY_STORAGE_KEY, policy);
  } catch {
    /* 写不进去也不阻塞 UI，本次会话按默认口径继续 */
  }
  window.dispatchEvent(new CustomEvent(IMMERSIVE_POLICY_CHANGED_EVENT, { detail: policy }));
}

/** ── 手机端布局判定（唯一入口，CSS 的 phone-shell 媒体查询与此保持同源） ──
 *  竖屏看视口宽度；横屏改看"矮视口 + 触摸"：手机横屏高约 390，平板横屏 600 以上，
 *  用 max-height 能把平板留在桌面舞台。
 *  刻意拆成两条 Level 3 查询而不是用 `or` 分组——老内核解析不了整条查询时会整条判 false，
 *  手机布局会被直接丢掉（这正是"横屏后掉回 390×844 桌面壳、只看得见一小截"的成因）。 */
export const MOBILE_PORTRAIT_MEDIA = "(max-width: 500px) and (hover: none) and (pointer: coarse)";
export const MOBILE_LANDSCAPE_MEDIA =
  "(max-height: 500px) and (orientation: landscape) and (hover: none) and (pointer: coarse)";

export function isMobilePhoneViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(MOBILE_PORTRAIT_MEDIA).matches
    || window.matchMedia(MOBILE_LANDSCAPE_MEDIA).matches;
}

/** 当前视口是否横向；screen.orientation.type 更准，拿不到时退回宽高比较。 */
function isViewportLandscape(): boolean {
  if (typeof window === "undefined") return false;
  const type = screen?.orientation?.type;
  if (type) return type.startsWith("landscape");
  return window.innerWidth > window.innerHeight;
}

/** 方向锁在本机的可信程度。一次会话里只实测一次，结果决定后面还赌不赌全屏：
 *  - unknown：还没试过
 *  - locked：lock("portrait") 真的应答了
 *  - unsupported：没有该 API 或被拒——这台设备用全屏换不来竖屏，别再请求 */
export type PortraitLockState = "unknown" | "locked" | "unsupported";
let portraitLockState: PortraitLockState = "unknown";
let landscapeWatchdogBound = false;

export function getPortraitLockState(): PortraitLockState {
  return portraitLockState;
}

/** 尝试把方向锁回竖屏，**把结果如实返回**。
 *  全屏态才允许 lock，所以只能在 requestFullscreen 成功后调。
 *  这里刻意不吞失败：2026-10-20 的真机日志（PKS110 / Android 16，`fullscreen:"html"`
 *  + `orientType:"landscape-primary"` + `screen 804x360`）显示，旧写法用
 *  `.catch(() => {})` 把"锁不上"静默吃掉，页面已经脱离了浏览器地址栏这道保护，
 *  又没能锁住方向，于是壳在全屏态跟着传感器转横（系统自动旋转关着也照样转），
 *  390 竖屏稿被压进 360 高——"打开就躺倒、只看得见一小截"就是这么来的。 */
async function tryLockPortrait(): Promise<boolean> {
  if (typeof screen === "undefined") return false;
  const orientation = screen.orientation as
    (ScreenOrientation & { lock?: (value: string) => Promise<void> }) | undefined;
  if (!orientation?.lock) return false;
  try {
    await orientation.lock("portrait");
    return true;
  } catch {
    /* iOS Safari 无此 API、老内核在非手势调用里直接 throw、部分壳直接 reject */
    return false;
  }
}

async function exitFullscreenQuietly(): Promise<void> {
  if (typeof document === "undefined") return;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* 已经不在全屏，或这个壳不让退 */
  }
}

/** 借一次用户手势确认"全屏 + 竖屏"能不能同时成立：能就留全屏，不能就退回浏览器态。
 *  调用点都在 click 里，requestFullscreen / orientation.lock 需要的用户激活是够的。
 *  策略为 always（沉浸优先）时，锁不住也留在全屏里——那是用户在设置里明确选的取舍。 */
async function securePortraitInsideFullscreen(): Promise<void> {
  const locked = await tryLockPortrait();
  const immersiveFirst = readImmersiveFullscreenPolicy() === "always";
  portraitLockState = locked ? "locked" : "unsupported";
  if (!locked && !immersiveFirst) await exitFullscreenQuietly();
}

/** 全屏态下视口转横的兜底：连 screen.orientation.lock 报成功却仍然转横的壳
 *  （"接受但不生效"那一种），也不能让她停在没法用的画面里。退出全屏后壳一般会转回竖屏。
 *  退一次就把状态判死，免得下一次点击又请求全屏→又转横→又退，来回抖。
 *  只服务于默认口径：always 是用户自愿承担横屏换沉浸，never 本来就不会在全屏里。 */
function bindLandscapeWatchdog(): void {
  if (typeof window === "undefined" || landscapeWatchdogBound) return;
  landscapeWatchdogBound = true;
  const onMaybeLandscape = () => {
    if (readImmersiveFullscreenPolicy() !== "auto") return;
    if (portraitLockState === "unsupported") return;
    if (!document.fullscreenElement || !isViewportLandscape()) return;
    portraitLockState = "unsupported";
    void exitFullscreenQuietly();
  };
  window.addEventListener("orientationchange", onMaybeLandscape);
  window.addEventListener("resize", onMaybeLandscape);
  // 设置里改策略要当场生效：判死记录清零（换成 always/never 后不该沿用旧的探测结论）；
  // 切到 never 时若此刻正处在我们请求来的全屏里，立刻退出来，不用等下一次点击。
  window.addEventListener(IMMERSIVE_POLICY_CHANGED_EVENT, (event) => {
    const detail = (event as CustomEvent<string>).detail;
    portraitLockState = "unknown";
    if (detail === "never" && document.fullscreenElement) void exitFullscreenQuietly();
  });
}

/** 沉浸全屏请求：偏好关闭、策略选了"从不全屏"、本机已证明锁不住竖屏、
 *  或视口本来就是横向的都不请求；已经在全屏里则用来补锁（上一次进入时可能还没走到这一步）。 */
export function requestMobileImmersiveFullscreen(): void {
  if (typeof document === "undefined") return;
  bindLandscapeWatchdog();
  if (!shouldRequestPwaFullscreen()) return;
  const policy = readImmersiveFullscreenPolicy();
  if (policy === "never") return;
  // 判死只对默认口径生效：always 是"无论如何都要沉浸"，每次点击都该继续试。
  if (policy !== "always" && portraitLockState === "unsupported") return;
  if (isViewportLandscape()) {
    // 僵局的入口：进来就已经是横屏全屏（旧版本留下的状态），用这次手势把它拉回竖屏。
    if (document.fullscreenElement) void securePortraitInsideFullscreen();
    return;
  }
  if (document.fullscreenElement) return;
  const doc = document.documentElement;
  const request = doc.requestFullscreen?.();
  if (request && typeof request.then === "function") {
    request.then(() => void securePortraitInsideFullscreen()).catch(() => {
      /* 全屏请求本身被拒：保持浏览器 UI，竖屏照常可用 */
    });
  } else {
    // 老内核不返回 Promise，无法确认结果；仍尝试一次锁，锁不上就退回浏览器态。
    void securePortraitInsideFullscreen();
  }
}

export function getRuntimePwaDisplayMode(): RuntimePwaDisplayMode {
  if (typeof window === "undefined" || typeof document === "undefined") return "browser";
  if (document.fullscreenElement || window.matchMedia("(display-mode: fullscreen)").matches) {
    return "fullscreen";
  }
  if (window.matchMedia("(display-mode: standalone)").matches) {
    return "standalone";
  }
  if (window.matchMedia("(display-mode: minimal-ui)").matches) {
    return "minimal-ui";
  }

  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return navigatorWithStandalone.standalone ? "standalone" : "browser";
}

/** 非沉浸布局是否生效：必须用户显式开了「显示系统状态栏」且运行时确实不在全屏。
 *  只看运行时模式是不行的——iOS 装到桌面永远报 standalone，会把没碰过开关的
 *  用户也误判成非沉浸（这正是 pwa-manifest-injector 挂标记前要先过这道门的原因）。 */
export function isNonImmersiveLayoutActive(): boolean {
  if (typeof document === "undefined") return false;
  return readPwaDisplayPreference(document.cookie) === "standalone"
    && getRuntimePwaDisplayMode() !== "fullscreen";
}

/** Safe-area values injected into sandboxed apps, which cannot inherit host CSS variables.
 *  measured：宿主实测的浮层几何，优先于估算值——壳布局以后再调整时数字不会失真。
 *  top 是"完全让开浮层"的保守值；bar* 描述浮层那一行本身，供想同排摆按钮的应用用。 */
export function getPwaHostedSafeArea(surface: PwaHostedSurface, embedded = false, measured?: PwaHostedOverlayMetrics): PwaHostedSafeArea {
  if (embedded) {
    return { top: "0px", right: "0px", bottom: "0px", left: "0px", barTop: "0px", barHeight: "0px", barClearLeft: "0px", barClearRight: "0px" };
  }

  const nonImmersive = isNonImmersiveLayoutActive();
  const px = (value: number | null | undefined, fallback: number) =>
    `${value != null && value > 0 ? Math.round(value) : fallback}px`;
  // 兜底估算与两个浮层的 CSS 定位保持一致（app-market.css 胶囊 / game.css 悬浮返回钮）：
  // top = 浮层 top + 浮层高 + 4px 间隙。浮层的 top 偏移与这段间隙都已从 8px 收到 4px，
  // 兜底值同步跟着减，免得实测拿不到时又冒出一条比实际更宽的留白。
  const isGame = surface === "game";
  return {
    top: px(measured?.topPx, nonImmersive ? (isGame ? 52 : 40) : (isGame ? 84 : 80)),
    right: "16px",
    bottom: "24px",
    left: "16px",
    barTop: px(measured?.barTopPx, isGame ? 38 : (nonImmersive ? 4 : 52)),
    barHeight: px(measured?.barHeightPx, isGame ? 44 : 30),
    barClearLeft: px(measured?.barClearLeftPx, isGame ? 66 : 0),
    barClearRight: px(measured?.barClearRightPx, isGame ? 0 : 96),
  };
}
