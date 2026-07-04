/**
 * Closed, generic journey-category enum + a bilingual (Turkish/English)
 * categorizer.
 *
 * The corpus' raw `journey_name` / `journey_step` are free text in two
 * languages with heavy customer-specific phrasing (177 distinct names:
 * "tour the X university home page", "kredi bilgileri", "QNB deneme"). For the
 * patterns to generalize to ANY customer, each finding's journey collapses to
 * one of these ~14 generic categories. The enum is the deliverable; the
 * keyword map is how we derive it from the messy source.
 *
 * `other` is the explicit floor — test garbage ("asd", "test") and ultra
 * long-tail flows land here rather than being force-fit. We do not chase 100%
 * recall; over-fitting to this corpus would defeat the point.
 */
export const JOURNEY_CATEGORIES = [
  "sign-in",
  "registration",
  "checkout",
  "booking",
  "search",
  "navigation",
  "browse-discovery",
  "content-consumption",
  "product-detail",
  "account-management",
  "form-submission",
  "consent",
  "promotion",
  "other",
] as const;

export type JourneyCategory = (typeof JOURNEY_CATEGORIES)[number];

/**
 * Priority-ordered keyword rules (Turkish + English). First match wins, so the
 * more specific intents (sign-in, registration, checkout) are tested before the
 * broad ones (browse-discovery). Each rule is `[category, keywords]`.
 */
const RULES: ReadonlyArray<readonly [JourneyCategory, readonly string[]]> = [
  [
    "sign-in",
    ["login", "log in", "sign in", "signin", "giriş yap", "giris yap", "oturum aç", "üye giriş"],
  ],
  [
    "registration",
    [
      "kayıt",
      "kayit",
      "hesap oluştur",
      "hesap olustur",
      "register",
      "signup",
      "sign up",
      "onboard",
      "üye ol",
      "uye ol",
    ],
  ],
  [
    "checkout",
    [
      "checkout",
      "ödeme",
      "odeme",
      "sepet",
      "cart",
      "satın al",
      "satin al",
      "purchase",
      "payment",
      "bilet",
      "ticket",
    ],
  ],
  ["booking", ["randevu", "rezervasyon", "booking", "reserve", "appointment", "başvuru tarih"]],
  ["search", ["arama", "ara ", "search", "sorgu", "find", "query", "hizmet arama", "filtrele"]],
  [
    "navigation",
    ["menü", "menu", "navigasyon", "navigation", "navbar", "footer", "header", "breadcrumb"],
  ],
  [
    "content-consumption",
    [
      "izle",
      "video",
      "player",
      "radyo",
      "radio",
      "watch",
      "oku",
      "makale",
      "article",
      "içerik",
      "icerik",
      "dinle",
      "podcast",
      "blog",
    ],
  ],
  [
    "account-management",
    [
      "hesap",
      "account",
      "profil",
      "profile",
      "ayar",
      "setting",
      "paket",
      "plan",
      "abonelik",
      "subscription",
      "parola",
      "password",
      "şifre",
      "sifre",
    ],
  ],
  [
    "form-submission",
    [
      "form",
      "apply",
      "lead",
      "application",
      "talep",
      "iletişim",
      "iletisim",
      "contact",
      "bize ulaş",
      "quote",
      "teklif al",
    ],
  ],
  ["consent", ["consent", "cookie", "çerez", "cerez", "kvkk", "gdpr", "onay", "aydınlatma"]],
  [
    "promotion",
    [
      "kampanya",
      "campaign",
      "promosyon",
      "promotion",
      "fırsat",
      "firsat",
      "çekiliş",
      "cekilis",
      "hediye",
    ],
  ],
  [
    "product-detail",
    [
      "kredi",
      "loan",
      "credit",
      "ürün",
      "urun",
      "product",
      "detay",
      "detail",
      "fiyat",
      "price",
      "mevduat",
      "incele",
    ],
  ],
  [
    "browse-discovery",
    [
      "ana sayfa",
      "anasayfa",
      "ana sayfya",
      "home",
      "homepage",
      "tour the",
      "keşif",
      "kesif",
      "discovery",
      "browsing",
      "browse",
      "genel",
      "general",
    ],
  ],
];

/**
 * Categorize a journey from its raw name/step into one closed generic category.
 * Unmatched input -> `"other"` (never thrown away, never force-fit).
 */
export function categorizeJourney(
  journeyName: string | null | undefined,
  journeyStep?: string | null,
): JourneyCategory {
  const text = `${journeyName ?? ""} ${journeyStep ?? ""}`.toLowerCase();
  if (text.trim() === "") return "other";
  for (const [category, keywords] of RULES) {
    if (keywords.some((kw) => text.includes(kw))) return category;
  }
  return "other";
}
