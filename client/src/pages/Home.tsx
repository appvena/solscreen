import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
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
  Code2,
  Copy,
  Database,
  Filter,
  Gauge,
  Globe2,
  LayoutDashboard,
  KeyRound,
  Loader2,
  LogOut,
  MessageCircle,
  PanelRight,
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
import {
  alerts,
  candidates,
  screeningSummary,
  type Candidate,
  type CandidateStatus,
  type Risk,
  type Tone,
} from "@/data/mockScreening";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const dateFmt = new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

const formatClock = (date: Date) => timeFmt.format(date).replace(/\./g, ":");
const formatAgo = (minutes: number) => {
  if (minutes < 1) return "baru saja";
  if (minutes < 60) return `${minutes} mnt lalu`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} jam lalu` : `${Math.floor(hours / 24)} hari lalu`;
};
const pad2 = (value: number) => String(value).padStart(2, "0");

const RISK_LABEL: Record<Risk, string> = { Low: "Risiko rendah", Medium: "Risiko sedang", High: "Risiko tinggi" };
const STATUS_LABEL: Record<CandidateStatus, string> = { Review: "Review", Watch: "Pantau", Rejected: "Ditolak" };

// ---------------------------------------------------------------------------
// Persisted alert settings (localStorage, per browser)
// ---------------------------------------------------------------------------
type AlertSettings = {
  thresholds: number[];
  downThreshold: number;
  frequencyMinutes: 1 | 5 | 15;
  push: boolean;
};

const SETTINGS_KEY = "solscreen.alertSettings.v1";
const PRESET_THRESHOLDS = [10, 20, 30];
const DEFAULT_SETTINGS: AlertSettings = { thresholds: [10, 20, 30], downThreshold: 10, frequencyMinutes: 5, push: false };

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
      frequencyMinutes: parsed.frequencyMinutes === 1 || parsed.frequencyMinutes === 15 ? parsed.frequencyMinutes : 5,
      push: parsed.push === true,
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
type NavKey = "overview" | "candidates" | "alerts" | "sources";
const NAV_MONITOR: { key: NavKey; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "overview", label: "Ringkasan", icon: LayoutDashboard },
  { key: "candidates", label: "Kandidat", icon: Target },
  { key: "alerts", label: "Alert", icon: Bell },
];
const NAV_LABEL: Record<NavKey, string> = { overview: "Ringkasan", candidates: "Kandidat", alerts: "Alert", sources: "Sumber data" };

type ReviewResult = {
  verdict: "layak_dipantau" | "perlu_review_manual" | "hindari";
  riskScore: number;
  confidence: number;
  summary: string;
  redFlags: string[];
  positiveSignals: string[];
  missingData: string[];
  nextChecks: string[];
  model: string;
  reviewedAt: string;
};

export default function Home() {
  const [activeNav, setActiveNav] = useState<NavKey>("overview");
  const [query, setQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState<"All" | Risk>("All");
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AlertSettings>(() => loadSettings());
  const [lastSync, setLastSync] = useState(() => new Date());
  const [unreadAlerts, setUnreadAlerts] = useState(alerts.length);
  const [showScoring, setShowScoring] = useState(false);
  const [showChecklist, setShowChecklist] = useState(false);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | undefined>(undefined);
  const [reviews, setReviews] = useState<Record<string, ReviewResult>>({});

  const utils = trpc.useUtils();
  const session = trpc.appAuth.session.useQuery(undefined, { refetchOnWindowFocus: false });
  const usingDefaultPassword = session.data?.usingDefaultPassword === true;
  const [securityFocus, setSecurityFocus] = useState(false);
  const logout = trpc.appAuth.logout.useMutation({ onSuccess: () => utils.invalidate() });
  const claudeStatus = trpc.ai.status.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const claudeReady = claudeStatus.data?.configured === true;

  const filtered = useMemo(
    () =>
      candidates.filter(candidate => {
        const matchesQuery = `${candidate.name} ${candidate.symbol} ${candidate.mint}`.toLowerCase().includes(query.trim().toLowerCase());
        const matchesRisk = riskFilter === "All" || candidate.risk === riskFilter;
        return matchesQuery && matchesRisk;
      }),
    [query, riskFilter],
  );

  const today = dateFmt.format(lastSync).toUpperCase();
  const scannedDelta = screeningSummary.scanned - screeningSummary.scannedYesterday;
  const rejectedCount = screeningSummary.scanned - screeningSummary.passed;
  const pct = (part: number) => ((part / screeningSummary.scanned) * 100).toFixed(1).replace(".", ",");
  const watchCount = candidates.filter(c => c.status !== "Rejected").length;

  const notify = useCallback((message: string) => {
    window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(""), 2800);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const copyMint = async (mint: string) => {
    try {
      await navigator.clipboard.writeText(mint);
      notify(`Alamat ${mint} disalin`);
    } catch {
      notify("Gagal menyalin — izin clipboard ditolak browser");
    }
  };

  const goTo = (key: NavKey) => {
    setActiveNav(key);
    navLockUntil.current = Date.now() + 1200;
    if (key === "alerts") setUnreadAlerts(0);
    const target = key === "overview" ? null : document.getElementById(`section-${key}`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    else window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Highlight the nav item for the section currently in view. A click locks the
  // highlight briefly so smooth scrolling past other sections doesn't override it.
  const navLockUntil = useRef(0);
  useEffect(() => {
    const ids: NavKey[] = ["candidates", "sources", "alerts"];
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

  const refresh = () => {
    setLastSync(new Date());
    notify("Data simulasi dimuat ulang — belum ada sumber live");
  };

  const sources: { name: string; meta: string; tone: Tone }[] = [
    { name: "Pool Solana", meta: "GeckoTerminal · belum tersambung (simulasi)", tone: "warn" },
    { name: "Profil token", meta: "DexScreener · belum tersambung (simulasi)", tone: "warn" },
    { name: "Laporan risiko", meta: "RugCheck · belum tersambung (simulasi)", tone: "warn" },
    { name: "Bubble map", meta: "Belum tersambung", tone: "warn" },
    claudeStatus.isLoading
      ? { name: "Claude API", meta: "Memeriksa…", tone: "warn" }
      : claudeReady
        ? { name: "Claude API", meta: `API key diatur · ${claudeStatus.data?.model}`, tone: "good" }
        : { name: "Claude API", meta: claudeStatus.isError ? "Server tidak terjangkau" : "API key belum diatur di server", tone: "bad" },
  ];
  const healthyCount = sources.filter(s => s.tone === "good").length;

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
          <div className="connection-card">
            <div className="connection-head"><span className="eyebrow">STATUS RUNTIME</span><span className="live-dot" /></div>
            <strong>Mode simulasi</strong>
            <span>{claudeReady ? "Claude aktif · data Solana belum live" : "Data Solana & Claude belum tersambung"}</span>
          </div>
          <div className="profile-row"><div className="avatar">OP</div><div><strong>Operator</strong><span>Workspace pribadi</span></div><button type="button" className="icon-button small logout-button" title="Keluar" aria-label="Keluar" onClick={() => logout.mutate()} disabled={logout.isPending}><LogOut size={15} /></button></div>
        </div>
      </aside>

      <main className="main-canvas" id="main">
        <header className="topbar">
          <div className="mobile-brand"><AppMark /><span>solscreen</span></div>
          <div className="breadcrumb"><span>Workspace</span><ChevronRight size={14} /><strong>{NAV_LABEL[activeNav]}</strong></div>
          <div className="top-actions">
            <button type="button" className="last-sync" onClick={refresh} title="Muat ulang data simulasi">
              <RefreshCw size={12} /> Sinkron terakhir <strong>{formatClock(lastSync)}</strong>
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
              <div className="eyebrow accent-eyebrow"><span className="tiny-square" /> INTELIJEN HARIAN / {today}</div>
              <h1>Sinyal sebelum <em>momentum.</em></h1>
              <p className="hero-copy">Pantau token baru Solana dengan filter risiko yang mengutamakan bukti. Satu tempat untuk melihat kandidat, distribusi holder, dan pemicu alert.</p>
            </div>
            <div className="hero-note">
              <Sparkles size={16} /><span>Review AI · Claude</span>
              <strong className={claudeReady ? "" : "pending"}>{claudeStatus.isLoading ? "memeriksa" : claudeReady ? "siap" : "belum diatur"}</strong>
            </div>
          </section>

          {usingDefaultPassword && (
            <section className="password-banner" role="alert">
              <KeyRound size={16} />
              <span><strong>Password masih bawaan.</strong> Siapa pun yang tahu password awal bisa masuk. Ganti sekarang supaya API key Claude Anda aman.</span>
              <button type="button" className="primary-button" onClick={() => { setSecurityFocus(true); setSettingsOpen(true); }}>Ganti password</button>
            </section>
          )}

          <section className="simulation-banner" aria-label="Pemberitahuan data simulasi">
            <div className="scan-line" />
            <div className="banner-icon"><Radio size={18} /></div>
            <div className="banner-copy">
              <strong>DATASET SIMULASI</strong>
              <span>Harga, holder, dan alert di layar ini adalah contoh untuk pengembangan UI — belum ada koneksi live ke Solana atau provider on-chain. {claudeReady ? "Review AI memakai Claude sungguhan, tetapi menilai data simulasi ini." : ""}</span>
            </div>
            <button type="button" className="banner-action" onClick={() => goTo("sources")}>Lihat peta integrasi <ChevronRight size={15} /></button>
          </section>

          <section className="metrics-grid" aria-label="Ringkasan screening">
            <Metric label="Pool baru dipindai" value={String(screeningSummary.scanned)} detail={`${scannedDelta >= 0 ? "+" : ""}${scannedDelta} vs kemarin`} icon={<Activity size={16} />} tone="lime" />
            <Metric label="Lolos filter awal" value={pad2(screeningSummary.passed)} detail={`${pct(screeningSummary.passed)}% dari yang dipindai`} icon={<ShieldCheck size={16} />} tone="blue" />
            <Metric label="Perlu review manual" value={pad2(watchCount)} detail={`${unreadAlerts} alert belum dibaca`} icon={<CircleHelp size={16} />} tone="amber" />
            <Metric label="Ditolak / risiko tinggi" value={String(rejectedCount)} detail={`${pct(rejectedCount)}% diblokir`} icon={<AlertTriangle size={16} />} tone="coral" />
          </section>

          <div className="section-heading candidate-heading" id="section-candidates">
            <div><div className="eyebrow">HASIL SCREENING</div><h2>Watchlist kandidat <span>{pad2(filtered.length)}</span></h2></div>
            <div className="filter-bar">
              <label className="search-box"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Cari simbol atau mint" aria-label="Cari simbol atau mint" /></label>
              <label className="filter-select"><Filter size={14} />
                <select value={riskFilter} onChange={event => setRiskFilter(event.target.value as "All" | Risk)} aria-label="Filter risiko">
                  <option value="All">Semua</option><option value="Low">Rendah</option><option value="Medium">Sedang</option><option value="High">Tinggi</option>
                </select>
              </label>
            </div>
          </div>

          <section className="candidate-layout">
            <div className="candidate-list">
              {filtered.map(candidate => (
                <CandidateCard key={candidate.symbol} candidate={candidate} hasReview={Boolean(reviews[candidate.symbol])} onOpen={() => setSelected(candidate)} onCopy={() => copyMint(candidate.mint)} />
              ))}
              {filtered.length === 0 && (
                <div className="empty-state"><Search size={22} /><strong>Tidak ada kandidat yang cocok</strong><span>Coba ubah kata kunci atau filter risiko.</span></div>
              )}
            </div>
            <aside className="right-rail">
              <div className="rail-card confidence-card">
                <div className="rail-card-head"><span className="eyebrow">KEYAKINAN SCREENING</span><Gauge size={16} /></div>
                <div className="confidence-value">72<span>/100</span></div>
                <div className="confidence-bar"><span style={{ width: "72%" }} /></div>
                <p>Skor simulasi. Keyakinan turun karena data bubble map dan roadmap belum lengkap.</p>
                <button type="button" className="text-button" aria-expanded={showScoring} onClick={() => setShowScoring(v => !v)}>
                  Bagaimana skor dihitung? <ChevronRight size={14} className={showScoring ? "rotate" : ""} />
                </button>
                {showScoring && (
                  <ul className="inline-explain">
                    <li>Kelengkapan data: berapa banyak sumber yang memberi jawaban.</li>
                    <li>Kesepakatan antar-sumber: apakah sumber saling menguatkan.</li>
                    <li>Kesegaran: umur data sejak pemeriksaan terakhir.</li>
                  </ul>
                )}
              </div>
              <div className="rail-card source-card" id="section-sources">
                <div className="rail-card-head"><span className="eyebrow">KESEHATAN SUMBER</span><span className={`healthy-pill ${healthyCount === 0 ? "warn" : ""}`}><span /> {healthyCount} / {sources.length} siap</span></div>
                {sources.map(source => <SourceRow key={source.name} {...source} />)}
              </div>
              <div className="rail-card rule-card">
                <div className="rail-card-head"><span className="eyebrow">ATURAN AKTIF</span><Settings2 size={15} /></div>
                <div className="rule-line"><span>Batas harga</span><strong>Rp1,00</strong></div>
                <div className="rule-line"><span>Likuiditas min.</span><strong>$10K</strong></div>
                <div className="rule-line"><span>Top 10 holder</span><strong>&lt; 55%</strong></div>
                <div className="rule-line"><span>Ambang naik</span><strong>{settings.thresholds.length ? `+${settings.thresholds.join(" / +")}%` : "nonaktif"}</strong></div>
                <div className="rule-line"><span>Ambang turun</span><strong>−{settings.downThreshold}%</strong></div>
                <div className="rule-line"><span>Frekuensi cek</span><strong>{settings.frequencyMinutes} mnt</strong></div>
                <button type="button" className="outline-button" onClick={() => setSettingsOpen(true)}>Ubah ambang alert <Settings2 size={14} /></button>
              </div>
            </aside>
          </section>

          <section className="lower-grid">
            <div className="panel alerts-panel" id="section-alerts">
              <div className="panel-heading">
                <div><div className="eyebrow">ALIRAN EVENT</div><h2>Alert terbaru</h2></div>
                {unreadAlerts > 0 && <button type="button" className="text-button no-margin" onClick={() => setUnreadAlerts(0)}>Tandai dibaca</button>}
              </div>
              <div className="alert-list">
                {alerts.map(alert => (
                  <div className="alert-row" key={`${alert.token}-${alert.minutesAgo}`}>
                    <div className={`alert-icon ${alert.kind}`}>{alert.kind === "up" ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}</div>
                    <div className="alert-main">
                      <strong>{alert.token} <span>{alert.trigger}</span></strong>
                      <small>Event simulasi · {formatClock(new Date(lastSync.getTime() - alert.minutesAgo * 60_000))}</small>
                    </div>
                    <div className={`alert-move ${alert.kind}`}>{alert.move}</div>
                    <span className="alert-notify" title={settings.push ? "Notifikasi push aktif" : "Notifikasi push nonaktif"}>{settings.push ? <Bell size={14} /> : <BellOff size={14} />}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="panel integration-panel">
              <div className="panel-heading"><div><div className="eyebrow">PETA INTEGRASI</div><h2>Status koneksi</h2></div><Code2 size={18} className="panel-icon" /></div>
              <div className="integration-flow">
                <FlowNode label="Data Solana" status="Simulasi" tone="warn" />
                <div className="flow-line" />
                <FlowNode label="Aturan risiko" status="Aktif" tone="good" />
                <div className="flow-line" />
                <FlowNode label="Claude API" status={claudeReady ? "Siap" : "Belum diatur"} tone={claudeReady ? "good" : "blue"} />
              </div>
              <p className="integration-copy">Kandidat yang lolos filter dikirim ke Claude lewat server. Claude mengembalikan JSON terstruktur berisi verdict, skor risiko, red flag, dan langkah verifikasi. API key tidak pernah dikirim ke browser.</p>
              <button type="button" className="outline-button full" aria-expanded={showChecklist} onClick={() => setShowChecklist(v => !v)}>
                {showChecklist ? "Sembunyikan checklist" : "Lihat checklist integrasi"} <ChevronRight size={14} className={showChecklist ? "rotate" : ""} />
              </button>
              {showChecklist && (
                <ul className="checklist">
                  <li className={claudeReady ? "done" : ""}>{claudeReady ? <Check size={13} /> : <span className="dot" />} ANTHROPIC_API_KEY diatur di server</li>
                  <li><span className="dot" /> Sambungkan provider data Solana (GeckoTerminal / DexScreener / RugCheck)</li>
                  <li><span className="dot" /> Simpan hasil screening & review ke database</li>
                  <li><span className="dot" /> Kirim notifikasi push / Telegram dari server</li>
                </ul>
              )}
            </div>
          </section>
          <footer className="footer-note"><span><Zap size={13} /> Dibuat untuk pemantauan berbasis bukti</span><span>Harga dan status hanya valid pada waktu pemeriksaan. Bukan saran investasi.</span></footer>
        </div>
      </main>

      {settingsOpen && (
        <SettingsDrawer
          initial={settings}
          onClose={() => { setSettingsOpen(false); setSecurityFocus(false); }}
          onSave={next => {
            setSettings(next);
            setSettingsOpen(false);
            notify(saveSettings(next) ? "Pengaturan alert disimpan di browser ini" : "Pengaturan diterapkan, tetapi browser menolak penyimpanan");
          }}
          notify={notify}
          focusSecurity={securityFocus}
          minPasswordLength={session.data?.minPasswordLength ?? 8}
          passwordPersistent={session.data?.passwordPersistent !== false}
          onLogout={() => logout.mutate()}
        />
      )}

      {selected && (
        <DetailModal
          candidate={selected}
          claudeReady={claudeReady}
          claudeModel={claudeStatus.data?.model}
          review={reviews[selected.symbol]}
          onReview={result => setReviews(prev => ({ ...prev, [selected.symbol]: result }))}
          onClose={() => setSelected(null)}
          onCopy={() => copyMint(selected.mint)}
        />
      )}

      <div className="toast-region" role="status" aria-live="polite">
        {toast && <div className="toast"><Check size={15} /> {toast}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings drawer — edits a draft; only "Simpan" applies and persists it.
// ---------------------------------------------------------------------------
function SettingsDrawer({ initial, onClose, onSave, notify, focusSecurity, minPasswordLength, passwordPersistent, onLogout }: {
  initial: AlertSettings;
  onClose: () => void;
  onSave: (settings: AlertSettings) => void;
  notify: (message: string) => void;
  focusSecurity: boolean;
  minPasswordLength: number;
  passwordPersistent: boolean;
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
          <div><div className="eyebrow">PENGATURAN WORKSPACE</div><h2 id="settings-title">Kontrol alert</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Tutup"><X size={18} /></button>
        </div>
        <p className="drawer-copy">Atur pemicu notifikasi untuk watchlist. Pengaturan disimpan di browser ini (localStorage) sampai backend tersedia.</p>

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
          <div className="setting-label">Frekuensi pengecekan</div>
          <div className="frequency-grid">
            {([1, 5, 15] as const).map(item => (
              <button type="button" key={item} aria-pressed={draft.frequencyMinutes === item} className={`frequency-option ${draft.frequencyMinutes === item ? "selected" : ""}`} onClick={() => setDraft(d => ({ ...d, frequencyMinutes: item }))}>
                {item} menit{draft.frequencyMinutes === item && <Check size={14} />}
              </button>
            ))}
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

        <SecuritySection focus={focusSecurity} minLength={minPasswordLength} persistent={passwordPersistent} notify={notify} onLogout={onLogout} />
      </aside>
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
const VERDICT: Record<ReviewResult["verdict"], { label: string; tone: Tone }> = {
  layak_dipantau: { label: "Layak dipantau", tone: "good" },
  perlu_review_manual: { label: "Perlu review manual", tone: "warn" },
  hindari: { label: "Hindari", tone: "bad" },
};

function DetailModal({ candidate, claudeReady, claudeModel, review, onReview, onClose, onCopy }: {
  candidate: Candidate;
  claudeReady: boolean;
  claudeModel?: string;
  review?: ReviewResult;
  onReview: (result: ReviewResult) => void;
  onClose: () => void;
  onCopy: () => void;
}) {
  const ref = useDialog(true, onClose);
  const mutation = trpc.ai.reviewToken.useMutation({ onSuccess: data => onReview(data) });

  const requestReview = () =>
    mutation.mutate({
      name: candidate.name,
      symbol: candidate.symbol,
      mint: candidate.mint,
      isSimulated: true,
      status: candidate.status,
      risk: candidate.risk,
      priceIdr: candidate.price,
      priceUsd: candidate.priceUsd,
      change24hPct: candidate.change,
      liquidityUsd: candidate.liquidity,
      volume24hUsd: candidate.volume,
      detected: formatAgo(candidate.detectedMinutesAgo),
      holders: candidate.holders,
      devWallet: candidate.dev,
      bubbleMap: candidate.bubble,
      socials: candidate.socials,
      roadmap: candidate.roadmap,
      ruleSignals: candidate.reasons.map(r => r.text),
    });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section ref={ref as RefObject<HTMLElement>} className="detail-modal" role="dialog" aria-modal="true" aria-labelledby="detail-title" onClick={event => event.stopPropagation()}>
        <div className="modal-top">
          <div className="token-identity">
            <div className="token-orb large" style={{ background: `linear-gradient(135deg, ${candidate.accent}, #18243e)` }}>{candidate.symbol.slice(0, 1)}</div>
            <div>
              <div className="eyebrow">REVIEW TOKEN / SIMULASI</div>
              <h2 id="detail-title">{candidate.name} <span>{candidate.symbol}</span></h2>
              <div className="mint-row"><code>{candidate.mint}</code><button type="button" className="mini-copy" onClick={onCopy} aria-label="Salin alamat mint"><Copy size={13} /></button></div>
            </div>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Tutup"><X size={18} /></button>
        </div>
        <div className="detail-status-row">
          <RiskBadge risk={candidate.risk} />
          <StatusBadge status={candidate.status} />
          <span className="detail-price">{candidate.price} <small>{candidate.priceUsd}</small></span>
          <span className={`detail-change ${candidate.change >= 0 ? "positive" : "negative"}`}>{candidate.change >= 0 ? "+" : ""}{candidate.change}%</span>
        </div>
        <div className="detail-grid">
          <div className="detail-stat"><span>Likuiditas</span><strong>{candidate.liquidity}</strong><small>Kedalaman pool (simulasi)</small></div>
          <div className="detail-stat"><span>Volume 24j</span><strong>{candidate.volume}</strong><small>Belum dicek silang</small></div>
          <div className="detail-stat"><span>Distribusi holder</span><strong>{candidate.holders}</strong><small>Snapshot saat deteksi</small></div>
          <div className="detail-stat"><span>Wallet dev</span><strong>{candidate.dev}</strong><small>Authority ≠ kesehatan wallet</small></div>
        </div>
        <div className="detail-columns">
          <div>
            <div className="eyebrow">SINYAL ATURAN</div>
            <div className="signal-list">
              {candidate.reasons.map(reason => (
                <div className="signal-list-row" key={reason.text}><SignalDot tone={reason.tone} /><span>{reason.text}</span></div>
              ))}
            </div>
          </div>
          <div className="detail-spark">
            <div className="eyebrow">JALUR HARGA / SIMULASI</div>
            <div className="large-spark"><Sparkline data={candidate.spark} color={candidate.accent} /></div>
            <div className="spark-caption"><span>Terdeteksi {formatAgo(candidate.detectedMinutesAgo)}</span><strong>Sekarang</strong></div>
          </div>
        </div>

        <div className="ai-review" aria-live="polite">
          <div className="ai-review-head">
            <div className="eyebrow"><Sparkles size={12} /> REVIEW AI / CLAUDE</div>
            {review && <span className="ai-meta">{review.model} · {formatClock(new Date(review.reviewedAt))}</span>}
          </div>
          {mutation.isPending && <div className="ai-placeholder"><Loader2 size={15} className="spin" /> Claude sedang meninjau data token…</div>}
          {!mutation.isPending && mutation.error && <div className="ai-error"><AlertTriangle size={14} /> {mutation.error.message}</div>}
          {!mutation.isPending && !review && !mutation.error && (
            <div className="ai-placeholder">
              {claudeReady
                ? `Minta Claude (${claudeModel}) menilai sinyal token ini. Hasilnya berupa penilaian risiko, bukan saran membeli atau menjual.`
                : "Claude API belum dikonfigurasi. Isi ANTHROPIC_API_KEY di server untuk mengaktifkan review AI."}
            </div>
          )}
          {!mutation.isPending && review && <ReviewView review={review} />}
        </div>

        <div className="modal-footer">
          <div className="external-links">
            <span><Globe2 size={14} /> {candidate.socials}</span>
            <span><PanelRight size={14} /> {candidate.roadmap}</span>
          </div>
          <button type="button" className="primary-button" onClick={requestReview} disabled={!claudeReady || mutation.isPending}>
            {mutation.isPending ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} {review ? "Review ulang" : "Minta review AI"}
          </button>
        </div>
      </section>
    </div>
  );
}

function ReviewView({ review }: { review: ReviewResult }) {
  const verdict = VERDICT[review.verdict];
  const lists: { title: string; items: string[]; tone: Tone }[] = [
    { title: "Red flag", items: review.redFlags, tone: "bad" },
    { title: "Sinyal positif", items: review.positiveSignals, tone: "good" },
    { title: "Data yang kurang", items: review.missingData, tone: "warn" },
    { title: "Cek berikutnya", items: review.nextChecks, tone: "warn" },
  ];
  return (
    <div className="ai-result">
      <div className="ai-scores">
        <span className={`verdict-badge ${verdict.tone}`}><SignalDot tone={verdict.tone} /> {verdict.label}</span>
        <span className="ai-score">Skor risiko <strong>{review.riskScore}</strong>/100</span>
        <span className="ai-score">Keyakinan <strong>{review.confidence}</strong>/100</span>
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

function CandidateCard({ candidate, hasReview, onOpen, onCopy }: { candidate: Candidate; hasReview: boolean; onOpen: () => void; onCopy: () => void }) {
  return (
    <article className="candidate-card">
      <div className="candidate-top">
        <div className="token-identity">
          <div className="token-orb" style={{ background: `linear-gradient(135deg, ${candidate.accent}, #18243e)` }}>{candidate.symbol.slice(0, 1)}</div>
          <div>
            <div className="token-name-row"><h3>{candidate.name}</h3><span className="symbol-label">{candidate.symbol}</span></div>
            <div className="mint-row"><code>{candidate.mint}</code><button type="button" className="mini-copy" onClick={onCopy} aria-label={`Salin mint ${candidate.symbol}`}><Copy size={12} /></button></div>
          </div>
        </div>
        <div className="card-actions">
          {hasReview && <span className="ai-done" title="Sudah direview Claude"><Sparkles size={12} /></span>}
          <StatusBadge status={candidate.status} />
          <button type="button" className="icon-button small" onClick={onOpen} aria-label={`Buka detail ${candidate.symbol}`}><ChevronRight size={16} /></button>
        </div>
      </div>
      <div className="candidate-main">
        <div className="price-block"><span className="eyebrow">HARGA / IDR</span><strong>{candidate.price}</strong><span className="usd-price">{candidate.priceUsd}</span></div>
        <div className={`change-pill ${candidate.change >= 0 ? "positive" : "negative"}`}>
          {candidate.change >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}{Math.abs(candidate.change)}%
        </div>
        <div className="mini-chart"><Sparkline data={candidate.spark} color={candidate.accent} /></div>
        <div className="detected"><Clock3 size={13} /> {formatAgo(candidate.detectedMinutesAgo)}</div>
      </div>
      <div className="candidate-signals">
        <SignalItem label="Wallet dev" value={candidate.dev} tone={candidate.devTone} />
        <SignalItem label="Sebaran holder" value={candidate.holders} tone={candidate.holderTone} />
        <SignalItem label="Bubble map" value={candidate.bubble} tone={candidate.bubbleTone} />
        <SignalItem label="Bukti proyek" value={candidate.roadmap} tone={candidate.roadmapTone} />
      </div>
      <div className="candidate-bottom">
        <div className="metric-inline"><span>Likuiditas</span><strong>{candidate.liquidity}</strong></div>
        <div className="metric-inline"><span>Volume 24j</span><strong>{candidate.volume}</strong></div>
        <div className="tag-list">{candidate.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
        <button type="button" className="review-button" onClick={onOpen}>Tinjau kandidat <ChevronRight size={14} /></button>
      </div>
    </article>
  );
}

function SignalItem({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return <div className="signal-item"><span>{label}</span><div><SignalDot tone={tone} /><strong title={value}>{value}</strong></div></div>;
}

function RiskBadge({ risk }: { risk: Risk }) {
  return <span className={`risk-badge ${risk.toLowerCase()}`}><span /> {RISK_LABEL[risk]}</span>;
}

function StatusBadge({ status }: { status: CandidateStatus }) {
  return <span className={`status-badge ${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>;
}

function SourceRow({ name, meta, tone }: { name: string; meta: string; tone: Tone }) {
  return <div className="source-row"><SignalDot tone={tone} /><div><strong>{name}</strong><span>{meta}</span></div></div>;
}

function FlowNode({ label, status, tone }: { label: string; status: string; tone: "good" | "warn" | "blue" }) {
  return <div className="flow-node"><span className={`flow-icon ${tone}`}><span /></span><div><strong>{label}</strong><small>{status}</small></div></div>;
}
