// SIMULATION DATASET — contoh untuk pengembangan UI.
// Ganti file ini dengan query tRPC ke provider data Solana saat backend siap.

export type Tone = "good" | "warn" | "bad";
export type Risk = "Low" | "Medium" | "High";
export type CandidateStatus = "Review" | "Watch" | "Rejected";

export type Candidate = {
  name: string;
  symbol: string;
  accent: string;
  status: CandidateStatus;
  risk: Risk;
  price: string;
  priceUsd: string;
  change: number;
  liquidity: string;
  volume: string;
  /** Menit sejak token terdeteksi. */
  detectedMinutesAgo: number;
  holders: string;
  holderTone: Tone;
  dev: string;
  devTone: Tone;
  bubble: string;
  bubbleTone: Tone;
  socials: string;
  roadmap: string;
  roadmapTone: Tone;
  mint: string;
  reasons: { text: string; tone: Tone }[];
  tags: string[];
  /** Harga relatif (unit bebas). Dinormalisasi oleh Sparkline. */
  spark: number[];
};

export const candidates: Candidate[] = [
  {
    name: "NOVA SIGNAL",
    symbol: "NOVA",
    accent: "#b7ef5e",
    status: "Review",
    risk: "Medium",
    price: "Rp0,084",
    priceUsd: "$0.00000468",
    change: 18.4,
    liquidity: "$24.8K",
    volume: "$61.2K",
    detectedMinutesAgo: 32,
    holders: "Top 10 · 42%",
    holderTone: "warn",
    dev: "Authority off",
    devTone: "good",
    bubble: "Tidak tuntas",
    bubbleTone: "warn",
    socials: "X + situs",
    roadmap: "Belum terverifikasi",
    roadmapTone: "bad",
    mint: "7wN...r4qP",
    reasons: [
      { text: "Authority mint dan freeze nonaktif", tone: "good" },
      { text: "Top 10 holder masih di atas ambang ideal", tone: "warn" },
      { text: "Cluster wallet belum dapat dipetakan penuh", tone: "warn" },
    ],
    tags: ["baru", "authority off"],
    spark: [18, 22, 20, 27, 31, 38, 45, 43, 52, 59, 65, 72],
  },
  {
    name: "CIRCUIT CAT",
    symbol: "CCAT",
    accent: "#8fa7ff",
    status: "Watch",
    risk: "Medium",
    price: "Rp0,031",
    priceUsd: "$0.00000174",
    change: 8.7,
    liquidity: "$11.4K",
    volume: "$18.9K",
    detectedMinutesAgo: 64,
    holders: "Top 10 · 29%",
    holderTone: "good",
    dev: "Wallet aktif",
    devTone: "warn",
    bubble: "Bersih sementara",
    bubbleTone: "good",
    socials: "Hanya X",
    roadmap: "Ada, belum valid",
    roadmapTone: "warn",
    mint: "Ckt...9Lx2",
    reasons: [
      { text: "Distribusi awal relatif tersebar", tone: "good" },
      { text: "Wallet creator masih melakukan transfer kecil", tone: "warn" },
      { text: "Tidak ada website resmi yang dapat diverifikasi", tone: "warn" },
    ],
    tags: ["watchlist", "sosial tipis"],
    spark: [24, 26, 21, 30, 29, 35, 31, 42, 38, 44, 47, 51],
  },
  {
    name: "MINTY LABS",
    symbol: "MINTY",
    accent: "#f3a55e",
    status: "Rejected",
    risk: "High",
    price: "Rp0,012",
    priceUsd: "$0.00000067",
    change: -6.2,
    liquidity: "$2.1K",
    volume: "$9.3K",
    detectedMinutesAgo: 131,
    holders: "Top 10 · 78%",
    holderTone: "bad",
    dev: "Riwayat creator buruk",
    devTone: "bad",
    bubble: "Cluster kuat",
    bubbleTone: "bad",
    socials: "Tidak ada",
    roadmap: "Tidak ditemukan",
    roadmapTone: "bad",
    mint: "Mnt...k8Vd",
    reasons: [
      { text: "Konsentrasi top holder sangat tinggi", tone: "bad" },
      { text: "Riwayat creator perlu dihindari", tone: "bad" },
      { text: "Likuiditas rendah dan pola cluster wallet mencurigakan", tone: "bad" },
    ],
    tags: ["ditolak", "risiko cluster"],
    spark: [55, 51, 58, 48, 44, 39, 42, 31, 28, 25, 21, 18],
  },
];

export type AlertEvent = { token: string; trigger: string; move: string; minutesAgo: number; kind: "up" | "down" };

export const alerts: AlertEvent[] = [
  { token: "NOVA", trigger: "Melewati ambang +10%", move: "+18.4%", minutesAgo: 4, kind: "up" },
  { token: "MINTY", trigger: "Peringatan likuiditas", move: "−22.0%", minutesAgo: 27, kind: "down" },
  { token: "CCAT", trigger: "Kandidat baru", move: "+8.7%", minutesAgo: 49, kind: "up" },
];

/** Ringkasan screening simulasi (pool yang dipindai hari ini). */
export const screeningSummary = { scanned: 148, scannedYesterday: 122, passed: 7 };
