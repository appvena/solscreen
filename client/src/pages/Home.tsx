import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  BellOff,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Coins,
  Copy,
  Database,
  ExternalLink,
  Filter,
  Globe2,
  KeyRound,
  LayoutDashboard,
  Loader2,
  LogOut,
  MessageCircle,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Target,
  X,
  Zap,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import type { AppRouter } from "../../../server/routers";

type Outputs = inferRouterOutputs<AppRouter>;
type Screening = NonNullable<Outputs["screening"]["today"]>;
type Candidate = Screening["candidates"][number];
type Review = NonNullable<Outputs["ai"]["review"]>;
type Usage = Outputs["ai"]["usage"];
type Tone = "good" | "warn" | "bad";
type Status = Candidate["status"];

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const dateFmt = new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

const formatClock = (date: Date) => timeFmt.format(date).replace(/\./g, ":");
const zoneFmt = new Intl.DateTimeFormat("id-ID", { timeZoneName: "short" });
const zoneLabel = () => zoneFmt.formatToParts(new Date()).find(p => p.type === "timeZoneName")?.value ?? "";
const formatHm = (date: Date) => formatClock(date).slice(0, 5);
const formatAgo = (minutes: number) => {
  if (minutes < 1) return "baru saja";
  if (minutes < 60) return `${minutes} mnt lalu`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} jam lalu` : `${Math.floor(hours / 24)} hari lalu`;
};
const pad2 = (value: number) => String(value).padStart(2, "0");
const formatIdr = (v: number) => `Rp${v.toLocaleString("id-ID", { maximumSignificantDigits: 4 })}`;
const formatUsdPrice = (v: number) => `$${v.toLocaleString("en-US", { maximumSignificantDigits: 4 })}`;
const formatUsdShort = (v: number | null) => v === null ? "—" : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`;
const formatUsdMoney = (v: number) => `US$${v.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 })}`;
/** Copies text; falls back to a hidden textarea for browsers without the Clipboard API. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall back below
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    el.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  } catch {
    return false;
  }
}
const shortMint = (mint: string) => `${mint.slice(0, 4)}...${mint.slice(-4)}`;
const fmtChange = (v: number | null) => v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toLocaleString("id-ID", { maximumFractionDigits: 1 })}%`;
const accentFor = (mint: string) => {
  const palette = ["#b7ef5e", "#8fa7ff", "#f3a55e", "#6fd3c1", "#e58fd0", "#f2d36b"];
  let h = 0;
  for (const ch of mint) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
};

const STATUS_CLASS: Record<Status, string> = { Lolos: "review", Pantau: "watch", Ditolak: "rejected" };
const RISK_LABEL: Record<Candidate["risk"], string> = { Low: "Risiko rendah", Medium: "Risiko sedang", High: "Risiko tinggi" };

// ---------------------------------------------------------------------------
// Persisted alert settings (localStorage, per browser)
// ---------------------------------------------------------------------------
type AlertSettings = {
  thresholds: number[];
  downThreshold: number;
  /** Mirrors the server-side automatic scan setting (0 = off). */
  frequencyMinutes: 0 | 15 | 30 | 60;
  push: boolean;
  autoReview: boolean;
};

const SETTINGS_KEY = "solscreen.alertSettings.v1";
const PRESET_THRESHOLDS = [10, 20, 30];
const DEFAULT_SETTINGS: AlertSettings = { thresholds: [10, 20, 30], downThreshold: 10, frequencyMinutes: 15, push: false, autoReview: true };

function loadSettings(): AlertSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AlertSettings>;
    const thresholds = Array.isArray(parsed.thresholds)
      ? parsed.thresholds.filter((v): v is number => Number.isInteger(v) && v >= 1 && v <= 500)
      : DEFAULT_SETTINGS.thresholds;
    return {
      thresholds: [...new Set(thresholds)].sort((a, b) => a - b),
      downThreshold: Number.isInteger(parsed.downThreshold) && parsed.downThreshold! >= 1 && parsed.downThreshold! <= 50 ? parsed.downThreshold! : DEFAULT_SETTINGS.downThreshold,
      frequencyMinutes: parsed.frequencyMinutes === 30 || parsed.frequencyMinutes === 60 ? parsed.frequencyMinutes : 15,
      push: parsed.push === true,
      autoReview: parsed.autoReview !== false,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: AlertSettings): boolean {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Accessible dialog behaviour: Esc to close, focus trap, focus restore.
// ---------------------------------------------------------------------------
function useDialog(open: boolean, onClose: () => void): RefObject<HTMLElement | null> {
  const ref = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])') ?? []);
    window.requestAnimationFrame(() => focusables()[0]?.focus());
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open]);

  return ref;
}

// ---------------------------------------------------------------------------
// Small visual pieces
// ---------------------------------------------------------------------------
function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  // Normalise to 8–92 so the line never touches the edges, whatever the unit.
  const y = (value: number) => 92 - ((value - min) / span) * 84;
  const points = data.map((value, index) => `${(index / (data.length - 1)) * 100},${y(value)}`).join(" ");
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="sparkline" role="img" aria-label="Grafik harga simulasi">
      <polyline points={points} fill="none" stroke={color} strokeWidth="2.6" vectorEffect="non-scaling-stroke" />
      <circle cx="100" cy={y(data[data.length - 1])} r="2.7" fill={color} />
    </svg>
  );
}

function SignalDot({ tone }: { tone: Tone }) {
  return <span className={`signal-dot ${tone}`} aria-hidden="true" />;
}

function AppMark() {
  return (
    <div className="app-mark" aria-hidden="true">
      <span className="app-mark-core">S</span>
      <span className="app-mark-pulse" />
    </div>
  );
}

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}


// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
type NavKey = "overview" | "candidates" | "bonding" | "alerts" | "sources";
const NAV_MONITOR: { key: NavKey; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "overview", label: "Ringkasan", icon: LayoutDashboard },
  { key: "candidates", label: "Kandidat", icon: Target },
  { key: "bonding", label: "Hampir rilis", icon: Zap },
  { key: "alerts", label: "Alert", icon: Bell },
];
const NAV_LABEL: Record<NavKey, string> = { overview: "Ringkasan", candidates: "Kandidat", bonding: "Hampir rilis", alerts: "Alert", sources: "Sumber data" };

type AlertEvent = { key: string; symbol: string; mint: string; trigger: string; move: number; kind: "up" | "down" };

function deriveAlerts(candidates: Candidate[], settings: AlertSettings): AlertEvent[] {
  const events: AlertEvent[] = [];
  const up = [...settings.thresholds].sort((a, b) => b - a);
  for (const c of candidates) {
    const h1 = c.change.h1;
    if (h1 === null) continue;
    const hit = up.find(t => h1 >= t);
    if (hit !== undefined) events.push({ key: `${c.mint}:up${hit}`, symbol: c.symbol, mint: c.mint, trigger: `Naik melewati +${hit}% (1 jam)`, move: h1, kind: "up" });
    else if (h1 <= -settings.downThreshold) events.push({ key: `${c.mint}:down${settings.downThreshold}`, symbol: c.symbol, mint: c.mint, trigger: `Turun melewati −${settings.downThreshold}% (1 jam)`, move: h1, kind: "down" });
  }
  return events.sort((a, b) => Math.abs(b.move) - Math.abs(a.move));
}

const AUTO_REVIEW_MAX = 8;

export default function Home() {
  const [activeNav, setActiveNav] = useState<NavKey>("overview");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"All" | Status>("All");
  const [selectedMint, setSelectedMint] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AlertSettings>(() => loadSettings());
  const [showRejected, setShowRejected] = useState(false);
  const [readAlerts, setReadAlerts] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | undefined>(undefined);
  const [reviews, setReviews] = useState<Record<string, Review>>({});
  const [reviewing, setReviewing] = useState<Record<string, boolean>>({});
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [confirm, setConfirm] = useState<null | { title: string; description: string; action: (password: string) => Promise<void> }>(null);

  const utils = trpc.useUtils();
  const session = trpc.appAuth.session.useQuery(undefined, { refetchOnWindowFocus: false });
  const usingDefaultPassword = session.data?.usingDefaultPassword === true;
  const [securityFocus, setSecurityFocus] = useState(false);
  const logout = trpc.appAuth.logout.useMutation({ onSuccess: () => utils.invalidate() });
  const claudeStatus = trpc.ai.status.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const claudeReady = claudeStatus.data?.configured === true;
  const usage = trpc.ai.usage.useQuery(undefined, { refetchOnWindowFocus: false, refetchInterval: 60_000 });
  const automation = trpc.settings.automation.useQuery(undefined, { refetchOnWindowFocus: false });
  const autoScanMinutes = automation.data?.autoScanMinutes ?? 15;
  const autoReviewOn = automation.data?.autoReview ?? true;
  const setAutomation = trpc.settings.setAutomation.useMutation({ onSuccess: next => utils.settings.automation.setData(undefined, next) });
  const screening = trpc.screening.today.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
    refetchInterval: autoScanMinutes > 0 ? autoScanMinutes * 60_000 : false,
    retry: 1,
  });
  const data = screening.data ?? undefined;
  const history = trpc.screening.history.useQuery(undefined, { refetchOnWindowFocus: false });
  useEffect(() => { if (data) void history.refetch(); }, [data?.generatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const nextScanAt = data?.nextScanAt && autoScanMinutes > 0 ? new Date(data.nextScanAt) : null;
  const candidates = useMemo(() => data?.candidates ?? [], [data]);
  const nearGraduation = useMemo(() => data?.nearGraduation ?? [], [data]);
  const lastSync = data ? new Date(data.generatedAt) : null;

  const notify = useCallback((message: string) => {
    window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(""), 2800);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const filtered = useMemo(
    () =>
      candidates.filter(c => {
        const matchesQuery = `${c.name} ${c.symbol} ${c.mint}`.toLowerCase().includes(query.trim().toLowerCase());
        return matchesQuery && (statusFilter === "All" || c.status === statusFilter);
      }),
    [candidates, query, statusFilter],
  );
  const counts = useMemo(() => ({
    lolos: candidates.filter(c => c.status === "Lolos").length,
    pantau: candidates.filter(c => c.status === "Pantau").length,
  }), [candidates]);

  const alerts = useMemo(() => deriveAlerts([...candidates, ...nearGraduation], settings), [candidates, nearGraduation, settings]);
  const unreadAlerts = alerts.filter(a => !readAlerts.has(a.key)).length;

  // Browser push for new alerts (only when enabled and permitted).
  const notifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!settings.push || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const a of alerts) {
      if (notifiedRef.current.has(a.key)) continue;
      notifiedRef.current.add(a.key);
      try {
        new Notification(`SolScreen · ${a.symbol}`, { body: `${a.trigger}: ${fmtChange(a.move)}`, icon: "/icons/icon-192.png", tag: a.key });
      } catch {
        // Some mobile browsers only allow notifications from the service worker.
      }
    }
  }, [alerts, settings.push]);

  // --- Claude reviews: load cached ones, then auto-review new candidates. ---
  const runReview = useCallback(async (mint: string, mode: "auto" | "deep", cachedOnly = false, password?: string, manual = false) => {
    if (!cachedOnly) setReviewing(r => ({ ...r, [mint]: true }));
    setReviewErrors(e => { const { [mint]: _drop, ...rest } = e; return rest; });
    try {
      const result = await utils.client.ai.review.mutate({ mint, mode, cachedOnly, password, manual: manual || mode === "deep" });
      if (result) setReviews(r => (mode === "auto" && r[mint]?.mode === "deep" ? r : { ...r, [mint]: result }));
      return result as Review | null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Review gagal";
      if (message === "Password salah." || /percobaan password/.test(message)) return message === "Password salah." ? "forbidden" as const : (setReviewErrors(e => ({ ...e, [mint]: message })), null);
      if (!cachedOnly) setReviewErrors(e => ({ ...e, [mint]: message }));
      return null;
    } finally {
      if (!cachedOnly) {
        setReviewing(r => ({ ...r, [mint]: false }));
        void utils.ai.usage.invalidate();
      }
    }
  }, [utils]);

  const reviewsRef = useRef(reviews);
  reviewsRef.current = reviews;
  const autoRanFor = useRef<string | null>(null);
  useEffect(() => {
    if (!data || autoRanFor.current === data.generatedAt) return;
    autoRanFor.current = data.generatedAt;
    const mints = [...data.candidates.slice(0, AUTO_REVIEW_MAX), ...(data.nearGraduation ?? []).slice(0, 3)].map(c => c.mint);
    void (async () => {
      // 1) cached reviews (deep first, then auto) — free
      for (const mint of mints) {
        const deep = await runReview(mint, "deep", true);
        if (!deep) await runReview(mint, "auto", true);
      }
      // 2) new automatic reviews, two at a time
      if (!claudeReady || !autoReviewOn) return;
      const pending = mints.filter(m => !reviewsRef.current[m]);
      for (let i = 0; i < pending.length; i += 2) {
        await Promise.all(pending.slice(i, i + 2).map(m => runReview(m, "auto")));
      }
    })();
  }, [data, claudeReady, autoReviewOn, runReview]);

  const refresh = () => setConfirm({
    title: "Pindai sekarang?",
    description: "Pemindaian manual bisa memicu review Claude untuk token baru dan memakai kredit. Masukkan password aplikasi untuk melanjutkan.",
    action: async password => {
      setRefreshing(true);
      try {
        const fresh = await utils.client.screening.rescan.mutate({ password });
        if (!fresh) throw new Error("Pemindaian gagal.");
        utils.screening.today.setData(undefined, fresh);
        notify(`Dipindai ${formatClock(new Date(fresh.generatedAt))} · ${fresh.candidates.length} kandidat`);
        void history.refetch();
      } finally {
        setRefreshing(false);
      }
    },
  });

  const requestReview = (mint: string, mode: "auto" | "deep") => {
    if (mode === "auto") return void runReview(mint, "auto", false, undefined, true);
    setConfirm({
      title: "Review mendalam?",
      description: "Review mendalam memakai model Claude yang lebih kuat dan lebih banyak pencarian web (± US$0,05–0,15 per token). Masukkan password aplikasi untuk melanjutkan.",
      action: async password => {
        // Validate the password first so a typo doesn't close the dialog.
        const result = await runReview(mint, "deep", false, password);
        if (result === "forbidden") throw new Error("Password salah.");
      },
    });
  };

  const copyMint = async (mint: string) => {
    if (await copyText(mint)) notify(`Alamat lengkap disalin: ${mint}`);
    else notify("Gagal menyalin — tekan lama alamat di detail token untuk menyalin manual");
  };

  const navLockUntil = useRef(0);
  const goTo = (key: NavKey) => {
    setActiveNav(key);
    navLockUntil.current = Date.now() + 1200;
    if (key === "alerts") setReadAlerts(new Set(alerts.map(a => a.key)));
    const target = key === "overview" ? null : document.getElementById(`section-${key}`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    else window.scrollTo({ top: 0, behavior: "smooth" });
  };

  useEffect(() => {
    const ids: NavKey[] = ["candidates", "sources", "bonding", "alerts"];
    const onScroll = () => {
      if (Date.now() < navLockUntil.current) return;
      const line = window.innerHeight * 0.35;
      let current: NavKey = "overview";
      for (const id of ids) {
        const el = document.getElementById(`section-${id}`);
        if (el && el.getBoundingClientRect().top <= line) current = id;
      }
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      setActiveNav(atBottom ? "alerts" : current);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const sourceRows: { name: string; meta: string; tone: Tone }[] = [
    ...(data?.sources ?? []).map(s => ({
      name: s.name,
      meta: s.ok ? `${s.count} data · ${(s.ms / 1000).toFixed(1)} dtk` : `Gagal: ${s.error ?? "tidak diketahui"}`,
      tone: (s.ok ? "good" : "bad") as Tone,
    })),
    ...(data ? [{ name: "Kurs USD → IDR", meta: `${data.usdIdrLive ? "Live" : "Perkiraan"} · Rp${Math.round(data.usdIdr).toLocaleString("id-ID")}`, tone: (data.usdIdrLive ? "good" : "warn") as Tone }] : []),
    claudeStatus.isLoading
      ? { name: "Claude API", meta: "Memeriksa…", tone: "warn" }
      : claudeReady
        ? { name: "Claude API", meta: `Siap · otomatis ${claudeStatus.data?.autoModel}${claudeStatus.data?.webSearch ? " + riset web" : ""}`, tone: "good" }
        : { name: "Claude API", meta: claudeStatus.isError ? "Server tidak terjangkau" : "API key belum diatur di server", tone: "bad" },
  ];
  const healthyCount = sourceRows.filter(s => s.tone === "good").length;
  const selected = selectedMint ? candidates.find(c => c.mint === selectedMint) ?? nearGraduation.find(c => c.mint === selectedMint) ?? null : null;
  const allSourcesDown = data && data.sources.length > 0 && data.sources.every(s => !s.ok);

  return (
    <div className="solscreen-shell">
      <a href="#main" className="skip-link">Lewati ke konten</a>
      <aside className="sidebar">
        <div className="brand-block">
          <AppMark />
          <div>
            <div className="brand-name">solscreen</div>
            <div className="brand-caption">INTELIJEN TOKEN</div>
          </div>
        </div>
        <div className="workspace-chip"><span className="status-ping" /> Workspace / Operator</div>
        <nav className="nav-list" aria-label="Navigasi utama">
          <div className="nav-label">Monitor</div>
          {NAV_MONITOR.map(({ key, label, icon: Icon }) => (
            <button key={key} type="button" title={label} aria-current={activeNav === key ? "true" : undefined} className={`nav-item ${activeNav === key ? "active" : ""}`} onClick={() => goTo(key)}>
              <Icon size={17} strokeWidth={1.8} /> <span>{label}</span>
              {key === "alerts" && unreadAlerts > 0 && <span className="nav-count">{unreadAlerts}</span>}
            </button>
          ))}
          <div className="nav-label nav-label-gap">Sistem</div>
          <button type="button" title="Sumber data" aria-current={activeNav === "sources" ? "true" : undefined} className={`nav-item ${activeNav === "sources" ? "active" : ""}`} onClick={() => goTo("sources")}>
            <Database size={17} strokeWidth={1.8} /> <span>Sumber data</span>
          </button>
          <button type="button" title="Pengaturan" className="nav-item" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={17} strokeWidth={1.8} /> <span>Pengaturan</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="connection-card live">
            <div className="connection-head"><span className="eyebrow">STATUS RUNTIME</span><span className="live-dot" /></div>
            <strong>Data live Solana</strong>
            <span>{claudeReady ? "Claude aktif · review otomatis" : "Claude belum diatur"}</span>
          </div>
          <div className="profile-row"><div className="avatar">OP</div><div><strong>Operator</strong><span>Workspace pribadi</span></div><button type="button" className="icon-button small logout-button" title="Keluar" aria-label="Keluar" onClick={() => logout.mutate()} disabled={logout.isPending}><LogOut size={15} /></button></div>
        </div>
      </aside>

      <main className="main-canvas" id="main">
        <header className="topbar">
          <div className="mobile-brand"><AppMark /><span>solscreen</span></div>
          <div className="breadcrumb"><span>Workspace</span><ChevronRight size={14} /><strong>{NAV_LABEL[activeNav]}</strong></div>
          <div className="top-actions">
            <button type="button" className="last-sync" onClick={() => void refresh()} disabled={refreshing || screening.isFetching} title="Pindai ulang sekarang">
              <RefreshCw size={12} className={refreshing || screening.isFetching ? "spin" : ""} /> Sinkron terakhir <strong>{lastSync ? formatClock(lastSync) : "—"}</strong>
            </button>
            <button type="button" className="icon-button" onClick={() => goTo("alerts")} aria-label={unreadAlerts > 0 ? `${unreadAlerts} alert belum dibaca` : "Alert"}>
              <Bell size={18} />{unreadAlerts > 0 && <span className="notification-badge" />}
            </button>
            <button type="button" className="settings-trigger" onClick={() => setSettingsOpen(true)}><Settings2 size={16} /> <span>Pengaturan alert</span></button>
          </div>
        </header>

        <div className="content-wrap">
          <section className="hero-row">
            <div>
              <div className="eyebrow accent-eyebrow"><span className="tiny-square" /> INTELIJEN HARIAN / {dateFmt.format(lastSync ?? new Date()).toUpperCase()}</div>
              <h1>Sinyal sebelum <em>momentum.</em></h1>
              <p className="hero-copy">Token Solana yang muncul dalam 24 jam terakhir, harga di bawah Rp1, lalu disaring ketat: authority, wallet dev, distribusi holder, cluster insider, likuiditas, dan media sosial — kemudian ditinjau Claude.</p>
            </div>
            <div className="hero-note">
              <Sparkles size={16} /><span>Review AI · Claude</span>
              <strong className={claudeReady ? "" : "pending"}>{claudeStatus.isLoading ? "memeriksa" : claudeReady ? "siap" : "belum diatur"}</strong>
            </div>
          </section>

          <section className="scan-strip" aria-label="Waktu pemindaian">
            <div><span className="eyebrow">TERAKHIR DIPINDAI</span><strong>{lastSync ? `${formatClock(lastSync)} ${zoneLabel()}` : screening.isLoading ? "memindai…" : "—"}</strong></div>
            <div><span className="eyebrow">BERIKUTNYA</span><strong>{autoScanMinutes === 0 ? "Otomatis mati" : nextScanAt ? `± ${formatHm(nextScanAt)} ${zoneLabel()}` : "—"}</strong><small>{autoScanMinutes === 0 ? "hanya lewat Pindai sekarang" : `tiap ${autoScanMinutes} mnt, saat aplikasi terbuka`} · review otomatis {autoReviewOn ? "nyala" : "mati"}</small></div>
            <div><span className="eyebrow">HASIL</span><strong>{data ? `${counts.lolos} lolos · ${counts.pantau} pantau` : "—"}</strong>{data && <small>{nearGraduation.length} hampir rilis (pump.fun)</small>}</div>
            <button type="button" className="primary-button" onClick={() => void refresh()} disabled={refreshing || screening.isFetching}>
              <RefreshCw size={14} className={refreshing || screening.isFetching ? "spin" : ""} /> {refreshing ? "Memindai…" : "Pindai sekarang"}
            </button>
          </section>

          {usingDefaultPassword && (
            <section className="password-banner" role="alert">
              <KeyRound size={16} />
              <span><strong>Password masih bawaan (123456).</strong> Siapa pun yang tahu password awal bisa masuk. Ganti sekarang supaya API key Claude Anda aman.</span>
              <button type="button" className="primary-button" onClick={() => { setSecurityFocus(true); setSettingsOpen(true); }}>
                {session.data?.passwordManagedBy === "env" ? "Cara ganti password" : "Ganti password"}
              </button>
            </section>
          )}

          <section className={`simulation-banner live-banner ${allSourcesDown || screening.isError ? "error" : ""}`} aria-label="Status data">
            <div className="scan-line" />
            <div className="banner-icon"><Radio size={18} /></div>
            <div className="banner-copy">
              <strong>{screening.isError || allSourcesDown ? "SUMBER DATA BERMASALAH" : "DATA LIVE · SOLANA MAINNET"}</strong>
              <span>
                {screening.isError ? screening.error.message
                  : allSourcesDown ? "Semua sumber data gagal dihubungi. Coba pindai ulang beberapa menit lagi."
                  : data ? `Dipindai ${formatClock(new Date(data.generatedAt))}${data.cached ? " (cache ≤15 menit)" : ""} dari GeckoTerminal, DexScreener, dan RugCheck. Bukan saran investasi — token baru sangat berisiko.`
                  : "Memindai token baru di Solana… pemindaian pertama bisa 10–30 detik."}
              </span>
            </div>
            <button type="button" className="banner-action" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? "Memindai…" : "Pindai ulang"} <RefreshCw size={14} /></button>
          </section>

          <section className="metrics-grid" aria-label="Ringkasan screening">
            <Metric label="Token baru dipindai" value={data ? String(data.scanned) : "…"} detail={data ? `${data.checked} dicek mendalam` : "memindai"} icon={<Activity size={16} />} tone="lime" />
            <Metric label="Lolos semua syarat" value={data ? pad2(counts.lolos) : "…"} detail="dev, holder, insider, sosial sehat" icon={<ShieldCheck size={16} />} tone="blue" />
            <Metric label="Perlu dipantau" value={data ? pad2(counts.pantau) : "…"} detail="kurang 1–2 syarat" icon={<CircleHelp size={16} />} tone="amber" />
            <Metric label="Ditolak / risiko tinggi" value={data ? String(data.rejectedCount) : "…"} detail={data ? `harga ≥Rp1: ${data.prefilterRejected.harga} · umur >24j: ${data.prefilterRejected.umur}` : "—"} icon={<AlertTriangle size={16} />} tone="coral" />
          </section>

          <div className="section-heading candidate-heading" id="section-candidates">
            <div><div className="eyebrow">HASIL SCREENING</div><h2>Watchlist kandidat <span>{pad2(filtered.length)}</span></h2></div>
            <div className="filter-bar">
              <label className="search-box"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Cari simbol atau mint" aria-label="Cari simbol atau mint" /></label>
              <label className="filter-select"><Filter size={14} />
                <select value={statusFilter} onChange={event => setStatusFilter(event.target.value as "All" | Status)} aria-label="Filter status">
                  <option value="All">Semua</option><option value="Lolos">Lolos</option><option value="Pantau">Pantau</option>
                </select>
              </label>
            </div>
          </div>

          <section className="candidate-layout">
            <div className="candidate-list">
              {screening.isLoading && Array.from({ length: 3 }, (_, i) => <div key={i} className="candidate-card skeleton" aria-hidden="true" />)}
              {filtered.map(c => (
                <CandidateCard key={c.mint} candidate={c} review={reviews[c.mint]} reviewing={reviewing[c.mint] === true} onOpen={() => setSelectedMint(c.mint)} onCopy={() => void copyMint(c.mint)} />
              ))}
              {screening.isSuccess && !screening.data && (
                <div className="empty-state">
                  <Clock3 size={22} />
                  <strong>Belum ada hasil pemindaian</strong>
                  <span>Pemindaian otomatis sedang mati. Tekan "Pindai sekarang" untuk memindai.</span>
                </div>
              )}
              {data && filtered.length === 0 && (
                <div className="empty-state">
                  <Search size={22} />
                  <strong>{candidates.length === 0 ? "Belum ada token yang lolos saringan saat ini" : "Tidak ada kandidat yang cocok"}</strong>
                  <span>{candidates.length === 0
                    ? `Dari ${data.scanned} token baru, ${data.rejectedCount} ditolak. Ini normal — sebagian besar token baru tidak sehat. Pindai ulang nanti.`
                    : "Coba ubah kata kunci atau filter status."}</span>
                </div>
              )}
              {data && data.rejected.length > 0 && (
                <div className="rejected-box">
                  <button type="button" className="text-button no-margin" aria-expanded={showRejected} onClick={() => setShowRejected(v => !v)}>
                    {showRejected ? "Sembunyikan" : "Lihat"} {data.rejected.length} token yang dicek tapi ditolak <ChevronRight size={14} className={showRejected ? "rotate" : ""} />
                  </button>
                  {showRejected && (
                    <ul>{data.rejected.map(r => <li key={r.mint}><SignalDot tone="bad" /><strong>{r.symbol}</strong><span>{r.reason}</span></li>)}</ul>
                  )}
                </div>
              )}
            </div>
            <aside className="right-rail">
              <CreditCard usage={usage.data} loading={usage.isLoading} claudeReady={claudeReady} notify={notify} />
              <div className="rail-card source-card" id="section-sources">
                <div className="rail-card-head"><span className="eyebrow">KESEHATAN SUMBER</span><span className={`healthy-pill ${healthyCount < sourceRows.length ? "warn" : ""}`}><span /> {healthyCount} / {sourceRows.length} ok</span></div>
                {sourceRows.map(source => <SourceRow key={source.name} {...source} />)}
              </div>
              <div className="rail-card rule-card">
                <div className="rail-card-head"><span className="eyebrow">ATURAN SCREENING</span><Settings2 size={15} /></div>
                <div className="rule-line"><span>Umur token</span><strong>≤ {data?.rules.maxAgeHours ?? 24} jam</strong></div>
                <div className="rule-line"><span>Harga</span><strong>&lt; Rp{data?.rules.maxPriceIdr ?? 1}</strong></div>
                <div className="rule-line"><span>Likuiditas min.</span><strong>{formatUsdShort(data?.rules.minLiquidityUsd ?? 10000)}</strong></div>
                <div className="rule-line"><span>Mint/freeze authority</span><strong>harus off</strong></div>
                <div className="rule-line"><span>Top 10 holder</span><strong>≤ {data?.rules.top10HealthyPct ?? 30}%</strong></div>
                <div className="rule-line"><span>Saldo wallet dev</span><strong>≤ {data?.rules.creatorHealthyPct ?? 3}%</strong></div>
                <div className="rule-line"><span>Cluster insider</span><strong>0</strong></div>
                <div className="rule-line"><span>Boleh kurang</span><strong>maks. {data?.rules.maxUnmet ?? 2} syarat</strong></div>
                <div className="rule-line"><span>Ambang alert</span><strong>{settings.thresholds.length ? `+${settings.thresholds.join("/+")}%` : "off"} · −{settings.downThreshold}%</strong></div>
                <button type="button" className="outline-button" onClick={() => setSettingsOpen(true)}>Ubah ambang alert <Settings2 size={14} /></button>
              </div>
            </aside>
          </section>

          <div className="section-heading candidate-heading bonding-heading" id="section-bonding">
            <div>
              <div className="eyebrow">PUMP.FUN · BONDING CURVE ≥ {data?.rules.minCurveProgressPct ?? 60}%</div>
              <h2>Hampir rilis ke DEX <span>{pad2(nearGraduation.length)}</span></h2>
              <p className="section-note">Token pump.fun yang belum "lulus" tapi bonding curve-nya hampir penuh. Diperiksa dengan syarat yang sama (harga &lt; Rp1, umur ≤24 jam, authority, wallet dev, holder, insider, media sosial); likuiditas masih di bonding curve dan pindah ke DEX saat lulus.</p>
            </div>
          </div>
          <section className="candidate-list bonding-list">
            {screening.isLoading && <div className="candidate-card skeleton" aria-hidden="true" />}
            {nearGraduation.map(c => (
              <CandidateCard key={c.mint} candidate={c} review={reviews[c.mint]} reviewing={reviewing[c.mint] === true} onOpen={() => setSelectedMint(c.mint)} onCopy={() => void copyMint(c.mint)} />
            ))}
            {data && nearGraduation.length === 0 && (
              <div className="empty-state compact">
                <Target size={20} />
                <strong>Belum ada token pump.fun yang hampir lulus dan memenuhi syarat</strong>
                <span>{data.bondingScanned} token di bonding curve dicek pada pemindaian ini.</span>
              </div>
            )}
          </section>

          <section className="lower-grid">
            <div className="panel alerts-panel" id="section-alerts">
              <div className="panel-heading">
                <div><div className="eyebrow">PERGERAKAN 1 JAM</div><h2>Alert terbaru</h2></div>
                {unreadAlerts > 0 && <button type="button" className="text-button no-margin" onClick={() => setReadAlerts(new Set(alerts.map(a => a.key)))}>Tandai dibaca</button>}
              </div>
              <div className="alert-list">
                {alerts.length === 0 && <p className="integration-copy">Belum ada kandidat yang bergerak melewati ambang alert Anda dalam 1 jam terakhir.</p>}
                {alerts.map(alert => (
                  <button type="button" className="alert-row as-button" key={alert.key} onClick={() => setSelectedMint(alert.mint)}>
                    <div className={`alert-icon ${alert.kind}`}>{alert.kind === "up" ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}</div>
                    <div className="alert-main">
                      <strong>{alert.symbol} <span>{alert.trigger}</span></strong>
                      <small>{readAlerts.has(alert.key) ? "Sudah dibaca" : "Baru"} · data {lastSync ? formatClock(lastSync) : "—"}</small>
                    </div>
                    <div className={`alert-move ${alert.kind}`}>{fmtChange(alert.move)}</div>
                    <span className="alert-notify" title={settings.push ? "Notifikasi push aktif" : "Notifikasi push nonaktif"}>{settings.push ? <Bell size={14} /> : <BellOff size={14} />}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="panel history-panel">
              <div className="panel-heading"><div><div className="eyebrow">RIWAYAT</div><h2>Jam pemindaian</h2></div><Clock3 size={18} className="panel-icon" /></div>
              {(history.data ?? []).length === 0 && <p className="integration-copy">Belum ada riwayat. Pemindaian tercatat setiap kali data diperbarui.</p>}
              <div className="history-list">
                {(history.data ?? []).slice(0, 12).map(h => (
                  <div key={h.at} className="history-row">
                    <strong>{formatClock(new Date(h.at))}</strong>
                    <span className="history-date">{dateFmt.format(new Date(h.at))}</span>
                    <span className="history-trigger">{h.trigger === "manual" ? "manual" : h.trigger === "jadwal" ? "jadwal" : "buka app"}</span>
                    <span className="history-counts"><b className="positive">{h.lolos}</b> lolos · <b>{h.pantau}</b> pantau · {h.ditolak} tolak</span>
                    {h.sourcesOk < h.sourcesTotal && <span className="history-warn" title="Ada sumber data yang gagal"><AlertTriangle size={12} /></span>}
                  </div>
                ))}
              </div>
              <p className="integration-copy">{autoScanMinutes === 0
                ? "Pemindaian otomatis mati: aplikasi hanya menampilkan hasil terakhir, pemindaian baru hanya lewat \"Pindai sekarang\" (dengan password)."
                : `Pemindaian berjalan saat aplikasi dibuka bila hasil terakhir lebih dari ${autoScanMinutes} menit, otomatis tiap ${autoScanMinutes} menit selama aplikasi terbuka, atau lewat "Pindai sekarang".`} Atur di Pengaturan → Otomatisasi. Zona waktu: {zoneLabel()}.</p>
            </div>
          </section>

          <section className="lower-grid single">
            <div className="panel integration-panel">
              <div className="panel-heading"><div><div className="eyebrow">CARA KERJA</div><h2>Alur screening</h2></div><Zap size={18} className="panel-icon" /></div>
              <div className="integration-flow">
                <FlowNode label="Token baru" status={data ? `${data.scanned} token` : "…"} tone="good" />
                <div className="flow-line" />
                <FlowNode label="Aturan risiko" status={data ? `${data.checked} dicek` : "…"} tone="good" />
                <div className="flow-line" />
                <FlowNode label="Claude" status={claudeReady ? `${Object.keys(reviews).length} direview` : "Belum diatur"} tone={claudeReady ? "good" : "blue"} />
              </div>
              <p className="integration-copy">Setiap pemindaian mengambil token Solana terbaru, membuang yang berumur &gt;24 jam, berharga ≥Rp1, atau likuiditasnya tipis, lalu memeriksa authority, wallet dev, distribusi holder, jaringan insider (pengganti bubble map), dan LP lewat RugCheck. Token yang hanya kurang 1–2 syarat tetap ditampilkan sebagai "Pantau" dengan keterangan syarat yang belum terpenuhi; authority aktif atau token yang sudah di-rug selalu ditolak. Kandidat ditinjau Claude, termasuk riset media sosial dan rencana proyek di web. Hasil review disimpan 24 jam agar kredit tidak terbuang.</p>
            </div>
          </section>
          <footer className="footer-note"><span><Zap size={13} /> Dibuat untuk pemantauan berbasis bukti</span><span>Harga dan status hanya valid pada waktu pemindaian. Bukan saran investasi.</span></footer>
        </div>
      </main>

      {settingsOpen && (
        <SettingsDrawer
          initial={{ ...settings, frequencyMinutes: autoScanMinutes as AlertSettings["frequencyMinutes"], autoReview: autoReviewOn }}
          onClose={() => { setSettingsOpen(false); setSecurityFocus(false); }}
          onSave={next => {
            setSettings(next);
            setSettingsOpen(false);
            saveSettings(next);
            if (next.frequencyMinutes !== autoScanMinutes || next.autoReview !== autoReviewOn) {
              setAutomation.mutate(
                { autoScanMinutes: next.frequencyMinutes, autoReview: next.autoReview },
                {
                  onSuccess: () => notify("Pengaturan disimpan (otomatisasi berlaku di semua perangkat)"),
                  onError: e => notify(`Otomatisasi gagal disimpan: ${e.message}`),
                },
              );
            } else notify("Pengaturan disimpan");
          }}
          notify={notify}
          focusSecurity={securityFocus}
          minPasswordLength={session.data?.minPasswordLength ?? 8}
          passwordPersistent={session.data?.passwordPersistent !== false}
          passwordManagedBy={session.data?.passwordManagedBy ?? "app"}
          onLogout={() => logout.mutate()}
        />
      )}

      {selected && (
        <DetailModal
          candidate={selected}
          claudeReady={claudeReady}
          claudeModel={claudeStatus.data?.model}
          review={reviews[selected.mint]}
          reviewing={reviewing[selected.mint] === true}
          reviewError={reviewErrors[selected.mint]}
          onReview={mode => requestReview(selected.mint, mode)}
          onClose={() => setSelectedMint(null)}
          onCopy={() => void copyMint(selected.mint)}
        />
      )}

      {confirm && <PasswordPrompt {...confirm} onClose={() => setConfirm(null)} />}

      <div className="toast-region" role="status" aria-live="polite">
        {toast && <div className="toast"><Check size={15} /> {toast}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Claude credit: the accurate balance lives in the Claude Console.
// ---------------------------------------------------------------------------
const CONSOLE_BILLING_URL = "https://platform.claude.com/settings/billing";

function CreditCard({ usage, loading, claudeReady }: { usage?: Usage; loading: boolean; claudeReady: boolean; notify?: (m: string) => void }) {
  const totalTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  return (
    <div className="rail-card credit-card">
      <div className="rail-card-head"><span className="eyebrow">KREDIT CLAUDE</span><Coins size={16} /></div>
      <p>Saldo dan tagihan yang akurat hanya ada di Claude Console — angka resmi dari Anthropic.</p>
      <a className="primary-button credit-link" href={CONSOLE_BILLING_URL} target="_blank" rel="noopener noreferrer">
        <Coins size={14} /> Cek saldo di Claude Console <ExternalLink size={13} />
      </a>
      {!loading && (
        <div className="credit-lines">
          <div><span>Review Claude oleh app</span><strong>{usage?.calls ?? 0}×</strong></div>
          <div><span>Pencarian web</span><strong>{usage?.webSearches ?? 0}× (US$0,01/cari)</strong></div>
          <div><span>Token diproses</span><strong>{totalTokens.toLocaleString("id-ID")}</strong></div>
        </div>
      )}
      {!claudeReady && <p className="credit-warn"><AlertTriangle size={12} /> Claude belum diatur — belum ada pemakaian.</p>}
      <p className="credit-note">Biaya terbesar berasal dari pencarian web saat review. Matikan "Review Claude otomatis" di Pengaturan → Otomatisasi untuk menghemat kredit.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Password confirmation for costly actions
// ---------------------------------------------------------------------------
function PasswordPrompt({ title, description, action, onClose }: { title: string; description: string; action: (password: string) => Promise<void>; onClose: () => void }) {
  const ref = useDialog(true, onClose);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!password) return;
    setBusy(true);
    setError("");
    try {
      await action(password);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal");
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <section ref={ref as RefObject<HTMLElement>} className="detail-modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={e => e.stopPropagation()}>
        <div className="modal-top">
          <div><div className="eyebrow">KONFIRMASI</div><h2 id="confirm-title">{title}</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Batal" disabled={busy}><X size={18} /></button>
        </div>
        <p className="drawer-copy">{description}</p>
        <form className="password-form" noValidate onSubmit={e => { e.preventDefault(); void submit(); }}>
          <input type="text" name="username" autoComplete="username" value="solscreen" readOnly hidden />
          <label>Password aplikasi<input type="password" autoComplete="current-password" value={password} onChange={e => { setPassword(e.target.value); setError(""); }} disabled={busy} /></label>
          <div className="field-error" role="alert">{error}</div>
          <div className="password-actions">
            <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>Batal</button>
            <button type="submit" className="primary-button" disabled={!password || busy}>{busy ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />} Lanjutkan</button>
          </div>
        </form>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings drawer — edits a draft; only "Simpan" applies and persists it.
// ---------------------------------------------------------------------------
function SettingsDrawer({ initial, onClose, onSave, notify, focusSecurity, minPasswordLength, passwordPersistent, passwordManagedBy, onLogout }: {
  initial: AlertSettings;
  onClose: () => void;
  onSave: (settings: AlertSettings) => void;
  notify: (message: string) => void;
  focusSecurity: boolean;
  minPasswordLength: number;
  passwordPersistent: boolean;
  passwordManagedBy: "env" | "app";
  onLogout: () => void;
}) {
  const [draft, setDraft] = useState<AlertSettings>(initial);
  const [custom, setCustom] = useState("");
  const [customError, setCustomError] = useState("");
  const ref = useDialog(true, onClose);
  const customThresholds = draft.thresholds.filter(v => !PRESET_THRESHOLDS.includes(v));
  const notificationsSupported = typeof window !== "undefined" && "Notification" in window;

  const setThresholds = (next: number[]) => setDraft(d => ({ ...d, thresholds: [...new Set(next)].sort((a, b) => a - b) }));
  const togglePreset = (value: number) =>
    setThresholds(draft.thresholds.includes(value) ? draft.thresholds.filter(v => v !== value) : [...draft.thresholds, value]);

  const addCustom = () => {
    const value = Number(custom.replace(",", "."));
    if (!custom.trim() || !Number.isInteger(value) || value < 1 || value > 500) {
      setCustomError("Masukkan bilangan bulat 1–500.");
      return;
    }
    if (draft.thresholds.includes(value)) {
      setCustomError(`+${value}% sudah ada.`);
      return;
    }
    if (draft.thresholds.length >= 8) {
      setCustomError("Maksimal 8 ambang.");
      return;
    }
    setThresholds([...draft.thresholds, value]);
    setCustom("");
    setCustomError("");
  };

  const togglePush = async (next: boolean) => {
    if (!next) return setDraft(d => ({ ...d, push: false }));
    if (!notificationsSupported) return notify("Browser ini tidak mendukung notifikasi");
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    if (permission === "granted") setDraft(d => ({ ...d, push: true }));
    else notify("Izin notifikasi ditolak di pengaturan browser");
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside ref={ref as RefObject<HTMLElement>} className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={event => event.stopPropagation()}>
        <div className="drawer-heading">
          <div><div className="eyebrow">PENGATURAN WORKSPACE</div><h2 id="settings-title">Pengaturan</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Tutup"><X size={18} /></button>
        </div>
        <div className="setting-group automation-group">
          <div className="setting-label">Otomatisasi <span className="setting-badge">semua perangkat</span></div>
          <p className="setting-help">Semua yang memakai kredit Claude atau memindai tanpa Anda tekan tombol. Dimatikan = benar-benar berhenti (ditegakkan di server).</p>
          <div className="setting-sublabel">Pemindaian otomatis</div>
          <div className="frequency-grid four">
            {([0, 15, 30, 60] as const).map(item => (
              <button type="button" key={item} aria-pressed={draft.frequencyMinutes === item} className={`frequency-option ${draft.frequencyMinutes === item ? "selected" : ""}`} onClick={() => setDraft(d => ({ ...d, frequencyMinutes: item }))}>
                {item === 0 ? "Mati" : `${item} mnt`}{draft.frequencyMinutes === item && <Check size={14} />}
              </button>
            ))}
          </div>
          <div className="toggle-row"><span><Sparkles size={16} /> Review Claude otomatis</span><Switch label="Review Claude otomatis" checked={draft.autoReview} onChange={next => setDraft(d => ({ ...d, autoReview: next }))} /></div>
          <p className="setting-help">{draft.frequencyMinutes === 0 ? "Aplikasi hanya menampilkan hasil terakhir. Pindai baru hanya lewat tombol \"Pindai sekarang\" (dengan password)." : `Pindai baru bila hasil terakhir lebih dari ${draft.frequencyMinutes} menit, selama aplikasi terbuka.`} {draft.autoReview ? "Token baru langsung direview Claude (± US$0,03/token)." : "Claude hanya berjalan saat Anda menekan tombol review."}</p>
        </div>

        <p className="drawer-copy">Ambang alert dan notifikasi di bawah ini disimpan di browser/perangkat ini.</p>

        <div className="setting-group">
          <div className="setting-label">Alert kenaikan harga</div>
          <div className="threshold-grid">
            {PRESET_THRESHOLDS.map(value => (
              <button type="button" key={value} aria-pressed={draft.thresholds.includes(value)} className={`threshold-chip ${draft.thresholds.includes(value) ? "selected" : ""}`} onClick={() => togglePreset(value)}>
                <span>+</span>{value}%<Check size={14} />
              </button>
            ))}
          </div>
          {customThresholds.length > 0 && (
            <div className="custom-chips">
              {customThresholds.map(value => (
                <span key={value} className="custom-chip">+{value}%
                  <button type="button" aria-label={`Hapus ambang +${value}%`} onClick={() => setThresholds(draft.thresholds.filter(v => v !== value))}><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          <form className="custom-threshold" noValidate onSubmit={event => { event.preventDefault(); addCustom(); }}>
            <input type="number" inputMode="numeric" min={1} max={500} step={1} value={custom} onChange={event => { setCustom(event.target.value); setCustomError(""); }} placeholder="Nilai lain, mis. 50" aria-label="Ambang kustom dalam persen" aria-invalid={Boolean(customError)} aria-describedby="custom-error" />
            <span>%</span>
            <button type="submit" className="add-chip" aria-label="Tambah ambang"><Plus size={14} /></button>
          </form>
          <div id="custom-error" className="field-error">{customError}</div>
        </div>

        <div className="setting-group">
          <label className="setting-label" htmlFor="down-range">Alert penurunan</label>
          <div className="range-row">
            <input id="down-range" type="range" min="1" max="50" value={draft.downThreshold} onChange={event => setDraft(d => ({ ...d, downThreshold: Number(event.target.value) }))} />
            <strong>−{draft.downThreshold}%</strong>
          </div>
        </div>

        <div className="setting-group">
          <div className="setting-label">Notifikasi</div>
          <div className="toggle-row"><span><Bell size={16} /> Notifikasi push browser</span><Switch label="Notifikasi push browser" checked={draft.push} onChange={next => void togglePush(next)} disabled={!notificationsSupported} /></div>
          <div className="toggle-row muted"><span><MessageCircle size={16} /> Telegram (segera hadir)</span><Switch label="Telegram, segera hadir" checked={false} onChange={() => undefined} disabled /></div>
        </div>

        <div className="drawer-footer">
          <button type="button" className="outline-button no-margin" onClick={() => setDraft(DEFAULT_SETTINGS)}>Reset</button>
          <div className="drawer-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Batal</button>
            <button type="button" className="primary-button" onClick={() => onSave(draft)}>Simpan</button>
          </div>
        </div>

        {passwordManagedBy === "env"
          ? <EnvPasswordHelp focus={focusSecurity} onLogout={onLogout} />
          : <SecuritySection focus={focusSecurity} minLength={minPasswordLength} persistent={passwordPersistent} notify={notify} onLogout={onLogout} />}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Password managed by the hosting dashboard (APP_PASSWORD).
// ---------------------------------------------------------------------------
function EnvPasswordHelp({ focus, onLogout }: { focus: boolean; onLogout: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) window.setTimeout(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
  }, [focus]);
  return (
    <div className="setting-group security-group" ref={ref}>
      <div className="setting-label">Keamanan</div>
      <p className="setting-help">Password aplikasi diatur di Vercel, supaya tidak perlu database. Cara menggantinya:</p>
      <ol className="env-steps">
        <li>Buka <strong>vercel.com</strong> → proyek <strong>solscreen</strong> → <strong>Settings</strong> → <strong>Environment Variables</strong>.</li>
        <li>Tambah (atau edit) Key <code>APP_PASSWORD</code>, isi password baru Anda, lalu <strong>Save</strong>.</li>
        <li>Buka <strong>Deployments</strong> → <strong>⋯</strong> → <strong>Redeploy</strong>. Semua perangkat akan diminta login ulang.</li>
      </ol>
      <div className="password-actions">
        <button type="button" className="ghost-button" onClick={onLogout}><LogOut size={14} /> Keluar</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Security: change the shared app password, log out.
// ---------------------------------------------------------------------------
function SecuritySection({ focus, minLength, persistent, notify, onLogout }: { focus: boolean; minLength: number; persistent: boolean; notify: (message: string) => void; onLogout: () => void }) {
  const utils = trpc.useUtils();
  const ref = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState("");
  const change = trpc.appAuth.changePassword.useMutation({
    onSuccess: result => {
      setCurrent(""); setNext(""); setConfirm("");
      void utils.appAuth.session.invalidate();
      notify(result.persisted ? "Password berhasil diganti" : "Password diganti, tetapi belum tersimpan permanen — hubungkan Upstash Redis");
    },
  });

  useEffect(() => {
    if (focus) window.setTimeout(() => {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      ref.current?.querySelector<HTMLInputElement>("input[type=password]")?.focus();
    }, 120);
  }, [focus]);

  const submit = () => {
    if (next.length < minLength) return setLocalError(`Password baru minimal ${minLength} karakter.`);
    if (next !== confirm) return setLocalError("Konfirmasi password tidak sama.");
    setLocalError("");
    change.mutate({ current, next });
  };
  const error = localError || change.error?.message || "";

  return (
    <div className="setting-group security-group" ref={ref}>
      <div className="setting-label">Keamanan</div>
      <p className="setting-help">Satu password untuk semua orang yang membuka aplikasi ini. Mengganti password akan mengeluarkan sesi lain.</p>
      {!persistent && <div className="ai-error storage-warning"><AlertTriangle size={14} /> Penyimpanan Upstash Redis belum dihubungkan di Vercel — password yang diganti bisa kembali ke awal.</div>}
      <form className="password-form" noValidate onSubmit={event => { event.preventDefault(); submit(); }}>
        <input type="text" name="username" autoComplete="username" value="solscreen" readOnly hidden />
        <label>Password saat ini<input type="password" autoComplete="current-password" value={current} onChange={e => { setCurrent(e.target.value); setLocalError(""); change.reset(); }} /></label>
        <label>Password baru<input type="password" autoComplete="new-password" value={next} onChange={e => { setNext(e.target.value); setLocalError(""); change.reset(); }} /></label>
        <label>Ulangi password baru<input type="password" autoComplete="new-password" value={confirm} onChange={e => { setConfirm(e.target.value); setLocalError(""); change.reset(); }} /></label>
        <div className="field-error" role="alert">{error}</div>
        <div className="password-actions">
          <button type="button" className="ghost-button" onClick={onLogout}><LogOut size={14} /> Keluar</button>
          <button type="submit" className="primary-button" disabled={!current || !next || !confirm || change.isPending}>
            {change.isPending ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />} Ganti password
          </button>
        </div>
      </form>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Detail modal with Claude review
// ---------------------------------------------------------------------------
const VERDICT: Record<Review["verdict"], { label: string; tone: Tone }> = {
  layak_dipantau: { label: "Layak dipantau", tone: "good" },
  perlu_review_manual: { label: "Perlu review manual", tone: "warn" },
  hindari: { label: "Hindari", tone: "bad" },
};

const CHECK_LABELS: [keyof Candidate["checks"], string][] = [
  ["authorities", "Authority"],
  ["devWallet", "Wallet dev"],
  ["holders", "Distribusi holder"],
  ["bubble", "Bubble map / insider"],
  ["liquidity", "Likuiditas & LP"],
  ["socials", "Media sosial"],
];

function linkIcon(label: string) {
  return /twitter|x\.com/i.test(label) ? "X" : /telegram/i.test(label) ? "TG" : /discord/i.test(label) ? "DC" : "WEB";
}

function DetailModal({ candidate, claudeReady, claudeModel, review, reviewing, reviewError, onReview, onClose, onCopy }: {
  candidate: Candidate;
  claudeReady: boolean;
  claudeModel?: string;
  review?: Review;
  reviewing: boolean;
  reviewError?: string;
  onReview: (mode: "auto" | "deep") => void;
  onClose: () => void;
  onCopy: () => void;
}) {
  const ref = useDialog(true, onClose);
  const accent = accentFor(candidate.mint);
  const links = [...candidate.websites, ...candidate.socials];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section ref={ref as RefObject<HTMLElement>} className="detail-modal" role="dialog" aria-modal="true" aria-labelledby="detail-title" onClick={event => event.stopPropagation()}>
        <div className="modal-top">
          <div className="token-identity">
            <TokenOrb candidate={candidate} large />
            <div>
              <div className="eyebrow">{candidate.curve ? `PUMP.FUN · BONDING ${Math.round(candidate.curve.progressPct)}%` : "REVIEW TOKEN / LIVE"} · {formatAgo(candidate.ageMinutes).toUpperCase()}</div>
              <h2 id="detail-title">{candidate.name} <span>{candidate.symbol}</span></h2>
            </div>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Tutup"><X size={18} /></button>
        </div>
        <div className="mint-full">
          <span className="eyebrow">ALAMAT TOKEN (MINT)</span>
          <code>{candidate.mint}</code>
          <button type="button" className="outline-button no-margin" onClick={onCopy}><Copy size={13} /> Salin alamat</button>
        </div>
        <div className="detail-status-row">
          <span className={`risk-badge ${candidate.risk.toLowerCase()}`}><span /> {RISK_LABEL[candidate.risk]}</span>
          <StatusBadge status={candidate.status} />
          <span className="detail-price">{formatIdr(candidate.priceIdr)} <small>{formatUsdPrice(candidate.priceUsd)}</small></span>
          <span className={`detail-change ${(candidate.change.h24 ?? 0) >= 0 ? "positive" : "negative"}`}>{fmtChange(candidate.change.h24)}</span>
        </div>
        <div className="detail-grid">
          {candidate.curve
            ? <div className="detail-stat"><span>Bonding curve</span><strong>{candidate.curve.progressPct.toLocaleString("id-ID", { maximumFractionDigits: 1 })}%</strong><small>{candidate.curve.solInCurve.toLocaleString("id-ID", { maximumFractionDigits: 1 })} SOL terkumpul</small></div>
            : <div className="detail-stat"><span>Likuiditas</span><strong>{formatUsdShort(candidate.liquidityUsd)}</strong><small>{candidate.checks.liquidity.lpLockedPct !== null ? `LP ${Math.round(candidate.checks.liquidity.lpLockedPct)}% terkunci` : "LP tidak diketahui"}</small></div>}
          <div className="detail-stat"><span>Volume 24j</span><strong>{formatUsdShort(candidate.volume24hUsd)}</strong><small>Market cap {formatUsdShort(candidate.marketCapUsd)}</small></div>
          <div className="detail-stat"><span>Holder</span><strong>{candidate.checks.holders.totalHolders?.toLocaleString("id-ID") ?? "—"}</strong><small>{candidate.checks.holders.label}</small></div>
          <div className="detail-stat"><span>RugCheck</span><strong>{candidate.rugScore ?? "—"}/100</strong><small>Makin rendah makin aman</small></div>
        </div>

        <div className={`terms-box ${candidate.unmet.length ? "warn" : "good"}`}>
          <div className="eyebrow">KETENTUAN</div>
          {candidate.unmet.length === 0
            ? <p><Check size={13} /> Memenuhi semua syarat screening.</p>
            : <>
                <p>Ditampilkan sebagai <b>Pantau</b> karena belum memenuhi {candidate.unmet.length} dari syarat berikut (maksimal 2 boleh kurang):</p>
                <ul>{candidate.unmet.map(u => <li key={u}><SignalDot tone="warn" /> {u}</li>)}</ul>
              </>}
        </div>
        <div className="check-grid">
          {CHECK_LABELS.map(([key, label]) => (
            <div key={key} className={`check-item ${candidate.checks[key].tone}`}><SignalDot tone={candidate.checks[key].tone} /><div><span>{label}</span><strong>{candidate.checks[key].label}</strong></div></div>
          ))}
        </div>

        <div className="detail-columns">
          <div>
            <div className="eyebrow">TEMUAN ATURAN</div>
            <div className="signal-list">
              {candidate.reasons.map(reason => (
                <div className="signal-list-row" key={reason.text}><SignalDot tone={reason.tone} /><span>{reason.text}</span></div>
              ))}
            </div>
          </div>
          <div className="detail-spark">
            <div className="eyebrow">HARGA · 24J → SEKARANG</div>
            <div className="large-spark"><Sparkline data={candidate.spark} color={accent} /></div>
            <div className="spark-caption"><span>1j {fmtChange(candidate.change.h1)}</span><strong>24j {fmtChange(candidate.change.h24)}</strong></div>
          </div>
        </div>

        {(candidate.description || links.length > 0) && (
          <div className="project-box">
            <div className="eyebrow">PROYEK & MEDIA SOSIAL</div>
            {candidate.description && <p>{candidate.description}</p>}
            <div className="link-chips">
              {links.map(l => <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="link-chip"><span>{linkIcon(`${l.label} ${l.url}`)}</span>{l.label}<ExternalLink size={11} /></a>)}
            </div>
          </div>
        )}

        <div className="ai-review" aria-live="polite">
          <div className="ai-review-head">
            <div className="eyebrow"><Sparkles size={12} /> REVIEW AI / CLAUDE</div>
            {review && <span className="ai-meta">{review.mode === "deep" ? "Mendalam" : "Otomatis"} · {review.model}{review.webSearches ? ` · ${review.webSearches} pencarian web` : ""} · {formatClock(new Date(review.reviewedAt))}</span>}
          </div>
          {reviewing && <div className="ai-placeholder"><Loader2 size={15} className="spin" /> Claude sedang meninjau data on-chain dan mencari media sosial serta rencana proyek…</div>}
          {!reviewing && reviewError && <div className="ai-error"><AlertTriangle size={14} /> {reviewError}</div>}
          {!reviewing && !review && !reviewError && (
            <div className="ai-placeholder">
              {claudeReady
                ? "Belum ada review. Review otomatis berjalan untuk kandidat teratas; klik tombol di bawah untuk meninjau token ini."
                : "Claude API belum dikonfigurasi. Isi ANTHROPIC_API_KEY di server untuk mengaktifkan review AI."}
            </div>
          )}
          {!reviewing && review && <ReviewView review={review} />}
        </div>

        <div className="modal-footer">
          <div className="external-links">
            <a href={candidate.links.dexscreener} target="_blank" rel="noopener noreferrer"><Globe2 size={14} /> DexScreener</a>
            <a href={candidate.links.rugcheck} target="_blank" rel="noopener noreferrer"><ShieldCheck size={14} /> RugCheck</a>
            <a href={candidate.links.solscan} target="_blank" rel="noopener noreferrer"><Database size={14} /> Solscan</a>
            {candidate.links.pumpfun && <a href={candidate.links.pumpfun} target="_blank" rel="noopener noreferrer"><Zap size={14} /> pump.fun</a>}
          </div>
          <div className="modal-actions">
            {!review && (
              <button type="button" className="outline-button no-margin" onClick={() => onReview("auto")} disabled={!claudeReady || reviewing}>
                <Sparkles size={14} /> Review cepat
              </button>
            )}
            <button type="button" className="primary-button" onClick={() => onReview("deep")} disabled={!claudeReady || reviewing} title={`Model ${claudeModel ?? ""} + riset web lebih luas`}>
              {reviewing ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} Review mendalam
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function ReviewView({ review }: { review: Review }) {
  const verdict = VERDICT[review.verdict];
  const lists: { title: string; items: string[]; tone: Tone }[] = [
    { title: "Red flag", items: review.redFlags, tone: "bad" },
    { title: "Sinyal positif", items: review.positiveSignals, tone: "good" },
    { title: "Media sosial", items: review.socialFindings, tone: "warn" },
    { title: "Rencana proyek", items: review.projectPlans, tone: "warn" },
    { title: "Data yang kurang", items: review.missingData, tone: "warn" },
    { title: "Cek berikutnya", items: review.nextChecks, tone: "warn" },
  ];
  return (
    <div className="ai-result">
      <div className="ai-scores">
        <span className={`verdict-badge ${verdict.tone}`}><SignalDot tone={verdict.tone} /> {verdict.label}</span>
        <span className="ai-score">Skor risiko <strong>{review.riskScore}</strong>/100</span>
        <span className="ai-score">Keyakinan <strong>{review.confidence}</strong>/100</span>
        <span className="ai-score">Biaya <strong>{formatUsdMoney(review.costUsd)}</strong></span>
      </div>
      <p className="ai-summary">{review.summary}</p>
      <div className="ai-lists">
        {lists.filter(list => list.items.length > 0).map(list => (
          <div key={list.title}>
            <div className="ai-list-title">{list.title}</div>
            <ul>{list.items.map(item => <li key={item}><SignalDot tone={list.tone} /><span>{item}</span></li>)}</ul>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Metric({ label, value, detail, icon, tone }: { label: string; value: string; detail: string; icon: ReactNode; tone: string }) {
  return (
    <div className="metric-card">
      <div className={`metric-icon ${tone}`}>{icon}</div>
      <div><span>{label}</span><strong>{value}</strong><small className={tone === "coral" ? "negative" : tone === "lime" ? "positive" : ""}>{detail}</small></div>
    </div>
  );
}

function TokenOrb({ candidate, large }: { candidate: Candidate; large?: boolean }) {
  const [broken, setBroken] = useState(false);
  const accent = accentFor(candidate.mint);
  return (
    <div className={`token-orb ${large ? "large" : ""}`} style={{ background: `linear-gradient(135deg, ${accent}, #18243e)` }}>
      {candidate.imageUrl && !broken
        ? <img src={candidate.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        : candidate.symbol.slice(0, 1)}
    </div>
  );
}

function CandidateCard({ candidate, review, reviewing, onOpen, onCopy }: { candidate: Candidate; review?: Review; reviewing: boolean; onOpen: () => void; onCopy: () => void }) {
  const h24 = candidate.change.h24 ?? 0;
  const links = [...candidate.websites, ...candidate.socials].slice(0, 4);
  return (
    <article className="candidate-card">
      <div className="candidate-top">
        <div className="token-identity">
          <TokenOrb candidate={candidate} />
          <div>
            <div className="token-name-row"><h3>{candidate.name}</h3><span className="symbol-label">{candidate.symbol}</span></div>
            <div className="mint-row"><code>{shortMint(candidate.mint)}</code><button type="button" className="mini-copy" onClick={onCopy} aria-label={`Salin mint ${candidate.symbol}`}><Copy size={12} /></button></div>
          </div>
        </div>
        <div className="card-actions">
          {reviewing && <span className="ai-done" title="Claude sedang meninjau"><Loader2 size={12} className="spin" /></span>}
          {review && <span className={`verdict-badge small ${VERDICT[review.verdict].tone}`} title={`Review Claude: ${VERDICT[review.verdict].label}`}><Sparkles size={11} /> {VERDICT[review.verdict].label}</span>}
          <StatusBadge status={candidate.status} />
          <button type="button" className="icon-button small" onClick={onOpen} aria-label={`Buka detail ${candidate.symbol}`}><ChevronRight size={16} /></button>
        </div>
      </div>
      <div className="candidate-main">
        <div className="price-block"><span className="eyebrow">HARGA / IDR</span><strong>{formatIdr(candidate.priceIdr)}</strong><span className="usd-price">{formatUsdPrice(candidate.priceUsd)}</span></div>
        <div className={`change-pill ${h24 >= 0 ? "positive" : "negative"}`}>
          {h24 >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}{fmtChange(candidate.change.h24).replace(/^[+-]/, "")}
        </div>
        <div className="mini-chart"><Sparkline data={candidate.spark} color={accentFor(candidate.mint)} /></div>
        <div className="detected"><Clock3 size={13} /> {formatAgo(candidate.ageMinutes)}</div>
      </div>
      <div className="candidate-signals">
        <SignalItem label="Wallet dev" value={candidate.checks.devWallet.label} tone={candidate.checks.devWallet.tone} />
        <SignalItem label="Sebaran holder" value={candidate.checks.holders.label} tone={candidate.checks.holders.tone} />
        <SignalItem label="Bubble map" value={candidate.checks.bubble.label} tone={candidate.checks.bubble.tone} />
        <SignalItem label="Media sosial" value={candidate.checks.socials.label} tone={candidate.checks.socials.tone} />
      </div>
      {candidate.curve && (
        <div className="curve-row" title="Progres bonding curve pump.fun">
          <span className="curve-label">Bonding curve</span>
          <div className="curve-bar"><span style={{ width: `${Math.min(100, candidate.curve.progressPct)}%` }} /></div>
          <strong>{candidate.curve.progressPct.toLocaleString("id-ID", { maximumFractionDigits: 1 })}%</strong>
          <small>{candidate.curve.solInCurve.toLocaleString("id-ID", { maximumFractionDigits: 1 })} SOL</small>
        </div>
      )}
      {candidate.unmet.length > 0 && (
        <div className="unmet-line"><AlertTriangle size={13} /><span><b>Belum memenuhi {candidate.unmet.length} syarat:</b> {candidate.unmet.join(" · ")}</span></div>
      )}
      <div className="candidate-bottom">
        {candidate.curve
          ? <div className="metric-inline"><span>Market cap</span><strong>{formatUsdShort(candidate.marketCapUsd)}</strong></div>
          : <div className="metric-inline"><span>Likuiditas</span><strong>{formatUsdShort(candidate.liquidityUsd)}</strong></div>}
        <div className="metric-inline"><span>Volume 24j</span><strong>{formatUsdShort(candidate.volume24hUsd)}</strong></div>
        <div className="tag-list">
          {links.map(l => <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer nofollow" title={l.url}>{linkIcon(`${l.label} ${l.url}`)}</a>)}
        </div>
        <button type="button" className="review-button" onClick={onOpen}>Tinjau kandidat <ChevronRight size={14} /></button>
      </div>
    </article>
  );
}

function SignalItem({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return <div className="signal-item"><span>{label}</span><div><SignalDot tone={tone} /><strong title={value}>{value}</strong></div></div>;
}

function StatusBadge({ status }: { status: Status }) {
  return <span className={`status-badge ${STATUS_CLASS[status]}`}>{status}</span>;
}

function SourceRow({ name, meta, tone }: { name: string; meta: string; tone: Tone }) {
  return <div className="source-row"><SignalDot tone={tone} /><div><strong>{name}</strong><span>{meta}</span></div></div>;
}

function FlowNode({ label, status, tone }: { label: string; status: string; tone: "good" | "warn" | "blue" }) {
  return <div className="flow-node"><span className={`flow-icon ${tone}`}><span /></span><div><strong>{label}</strong><small>{status}</small></div></div>;
}
