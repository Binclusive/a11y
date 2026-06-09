# Binclusive a11y-checker — Turkcell özeti

> Bu sayfa Atakan'ın Turkcell görüşmesi için hazırlanmıştır. Bölüm 3'teki tüm
> bulgular bugün, turkcell.com.tr'nin **canlı** sayfaları üzerinde, gerçek bir
> tarayıcıda alınmıştır. Hiçbir sayı yuvarlanmamış veya uydurulmamıştır.

---

## 1. Bu araç ne?

Erişilebilirlik (WCAG) hatalarını **iki katmanda** yakalayan, geliştiricinin
olduğu her yerde çalışan bir araç:

1. **Kaynak kodun içinde** — Turkcell'in kendi deposunda, Turkcell
   geliştiricileri tarafından. Onlar kodu yazarken hatayı gösterir.
2. **Canlı sayfada** — dağıtılmış sayfa gerçek tarayıcıda açılıp denetlenir;
   yalnızca sayfa çalışırken ortaya çıkan hataları yakalar.

Her bulgu dört şeyi birlikte söyler: **ne** olduğu, hangi **WCAG kriteri**,
denetlediğimiz **26 markalık gerçek havuzda ne kadar yaygın** olduğu, ve
**nasıl düzeltileceği**. Ekranda "bilinmeyen hata" çıkmaz — her satır eyleme
dönüştürülebilir.

---

## 2. İki katman neden birlikte?

Çünkü **farklı şeyleri** yakalarlar — biri diğerinin kör noktasını kapatır.

| Katman | Nerede çalışır | Neyi yakalar |
|---|---|---|
| **Kaynak denetimi** (Turkcell için birincil) | depo — editör, commit/CI | kod yazılırken, geliştiricinin sahip olduğu kodda |
| **Canlı render denetimi** (tamamlayıcı) | dağıtılmış sayfa / localhost | yalnızca **render sonrası** var olan: renk kontrastı, hesaplanmış roller, üçüncü-parti bileşen tuzakları |

**Köprü örnek — karusel klavye tuzağı.** Ana sayfada **45 kez** bulduğumuz,
denetlediğimiz **26 markanın 21'inde** görülen bu hata her iki katmanın da
neden gerektiğini tek başına gösteriyor: en yaygın corpus desenlerimizden biri,
**ama yalnızca sayfa çalışırken görünür**. Karusel, ekran dışındaki slaytları
`aria-hidden` ile gizliyor ama içlerindeki bağlantılar klavyeyle hâlâ
odaklanabilir — klavyeyle gezen kullanıcı görünmeyen bir bağlantıya düşüyor.
Kaynak kodu tarayan hiçbir linter bunu göremez; çalışan sayfayı denetlemek gerekir.

---

## 3. Turkcell'de bugün ne bulduk? (canlı katman)

Aşağıdakiler **canlı render denetiminin** turkcell.com.tr üzerinde bulduklarıdır
(kaynak katmanı, bunların bir kısmını Turkcell geliştiricileri daha kodu
yazarken, depo içinde yakalardı):

| Sayfa | Toplam | Kritik | Ciddi | Orta | Kontrast (1.4.3) |
|---|---:|---:|---:|---:|---:|
| Ana sayfa `/` | 63 | 0 | 58 | 5 | 5 |
| `/cep-telefonlari` | 13 | 1 | 9 | 3 | 8 |
| `/yardim` | 8 | 0 | 3 | 5 | 3 |
| **Toplam** | **84** | **1** | **70** | **13** | **16** |

**Üç çarpıcı örnek:**

- **Karusel klavye tuzağı** (yukarıda) — 45 kez, 26 markanın 21'inde. Runtime-only.
- **Ürün görseli, alt metni yok** — telefon listesindeki tek **kritik** hata, 26
  markanın 16'sında. Görme engelli müşteri, telefonun yerinde hiçbir şey duymuyor.
- **Okunamayan renk kontrastı** — üç sayfada toplam **16** öğe; üst menü
  bağlantıları ve dil bayrakları 4.5:1 eşiğini geçemiyor. Bunu görmek için sayfayı
  gerçek piksellerle çizmek gerekir — statik analiz bu kategoriyi tamamen kaçırır.

---

## 4. Turkcell ekibi bunu nasıl kullanır? (birincil katman)

Araç **Turkcell'in deposuna kurulur** ve geliştiricilerin akışına girer —
denetimi biz değil, onlar çalıştırır:

- **Editörde, yazarken** — Cursor / Copilot / Claude içinde `check_a11y` ve
  `get_a11y_rules` MCP araçları; geliştirici daha kodu yazarken hatayı görür,
  hatta kuralı yazmadan önce sorabilir.
- **Otomatik geri bildirim** — her `.tsx` düzenlemesinden sonra çalışan kanca,
  bulguları aynı anda yapay zekâya geri besler; düzeltme aynı turda yapılır.
- **CI / commit öncesi** — `a11y-checker check ./src` ciddi/kritik hata varsa
  derlemeyi durdurur; hata müşteriye ulaşmadan yakalanır.
- **Canlı doğrulama (tamamlayıcı)** — `a11y-checker check-url http://localhost:3000`
  veya dağıtılmış sayfa; render sonrası hataları (kontrast, karusel tuzağı) yakalar.

Hepsi **26 markalık gerçek denetim havuzuna** dayanır: en yaygın, en yüksek
etkili hatalar önce gösterilir ("26 markanın 21'inde görüldü").

---

## 5. Binclusive bunu nasıl kullanır?

- **Kaynak kod gerekmeden** herhangi bir canlı siteyi yalnızca adresinden
  denetleriz — React, ASP.NET, jQuery fark etmez. Kaynağına erişmediğimiz
  markaları (ve rakip kıyaslamasını) bu canlı katmanla denetleriz.
- Bulguları aynı 26-marka havuzuna göre sıralar, her birini düzeltme önerisiyle
  veririz. Bir sayfa da, yüzlerce sayfa da aynı motorla taranır.

---

## 6. Canlı demo (3 komut)

Ayrıntılı betik: [`live-demo.md`](./live-demo.md). Özet:

```bash
# Tek seferlik kurulum (tarayıcıyı indirir)
pnpm exec playwright install chromium

# Canlı bir Turkcell sayfasını tara (canlı katman)
pnpm scan:url https://www.turkcell.com.tr

# Lokal bir HTML dosyasını tara
pnpm scan:url ./ornek-sayfa.html
```

> Not: Kaynak katmanı Turkcell'in React deposunda çalışır (editör/CI). Canlı
> katman için sunucu tarafı şablonları (Razor `.cshtml` vb.) tek başına geçerli
> HTML olmadığından çalışan uygulamayı (`localhost`) tarayın; düz `.html`
> sayfalar ve canlı URL'ler doğrudan açılır.

---

*Bulguların ham çıktısı ve sayfa bazlı dökümü: [`findings.md`](./findings.md).*
