# Instagram günlük görevi

Bu dosya zamanlanmış görevin talimatıdır. Görev her sabah bu dosyayı okur ve aşağıdaki adımları sırayla uygular.
Talimatı değiştirmek için bu dosyayı düzenleyin. Zamanlanmış görevin kendisi yalnızca "bu dosyayı oku ve uygula" der.

## Amaç

Canlı ligin **bir önceki gününden** (İstanbul saatiyle 00:00–24:00; maçlar 07:00–23:44 arası, her gün tam bir sezon) kritik öneme sahip maçları seçip kullanıcıya göndermek:

- **2 Reels videosu:** tam maç, yaklaşık 105 sn. İlk 3 saniyede maçın neden kritik olduğunu söyleyen bir yazı, ardından maç ve animasyonlu lig tablosu.
- **3 Story videosu:** aynı biçimde, en fazla ~50 sn'lik kesit. Kanca yazısı, önemli goller, son düdük ve tablo.
- **Açıklama metinleri:** her video için İngilizce ve Türkçe metin, hashtag'ler ve maçın tekrar bağlantısı (`captions.txt`).

Kritik maç ölçütleri `tools/instagram.js` dosyasının başında yazar:

- şampiyonluğu belirleyen maç
- yükselme finali
- lideri değiştiren maç
- farklı skor
- çok gollü maç
- geriden gelme
- son saniye golü
- altın gol ya da penaltılar
- zirve maçı
- sürpriz sonuç

## Adımlar

Bütün komutları deponun kök klasöründe çalıştırın.

1. **Önceki günün lig durumunu al.** Bu durum `instagram-data` dalında saklanır. Dal yoksa sorun değil; araç daha yavaş da olsa kendisi hesaplar.
   ```sh
   mkdir -p data/instagram
   git fetch -q origin instagram-data && git show FETCH_HEAD:data/instagram/state.json > data/instagram/state-branch.json || rm -f data/instagram/state-branch.json
   ```

2. **Seçimi yap ve videoları üret.** Bu adım yaklaşık 20–30 dakika sürer. Komutu arka planda çalıştırın (Bash `run_in_background`) ve bitmesini bekleyin. Aynı komutu ikinci kez başlatmayın.
   ```sh
   node tools/instagram.js
   ```
   - Tarih vermezseniz **dün** (İstanbul) seçilir. Çıktı `out/instagram/<tarih>/` klasörüne yazılır: `reel-1.mp4`, `reel-2.mp4`, `story-1.mp4`, `story-2.mp4`, `story-3.mp4`, `captions.txt`, `summary.json`.
   - **"Yayındaki sitenin simülasyonu repodakinden farklı" hatası** çıkarsa site henüz son kodla yayınlanmamıştır. Videoları üretmeyin. Kullanıcıya durumu yazın, ardından `node tools/instagram.js --no-render` ile yalnızca seçimi ve açıklama metinlerini gönderin.
   - Başka bir hata çıkarsa komutu bir kez daha deneyin. Yine olmazsa hatanın son satırlarını kullanıcıya yazın.

3. **Dosyaları kullanıcıya gönder.** `SendUserFile` aracını `status: "proactive"` ile kullanın:
   - önce iki Reels videosu,
   - sonra üç Story videosu,
   - en sonda `captions.txt`.

   Her dosyanın kısa açıklamasına (caption) Türkçe olarak hangi maç olduğunu, skoru ve neden seçildiğini yazın. Bu bilgiler `summary.json` dosyasında `picks` altında: `what`, `home`, `away`, `score`, `critical`.

4. **Kullanıcıya kısa bir Türkçe özet yaz.** Özette şunlar olsun:
   - Hangi gün işlendi ve o gün kaç maç oynandı.
   - Seçilen 5 maç: dosya adı, maç, skor, neden kritik olduğu.
   - Hangi metnin hangi videoya ait olduğu (`captions.txt` içinde `=== reel-1.mp4 ===` gibi başlıklar var).

5. **Lig durumunu kaydet.** Ertesi günün görevi buradan devam eder:
   ```sh
   sh tools/instagram-save.sh <tarih>
   ```
   `<tarih>` işlenen gündür (`summary.json` içindeki `day`). Betik yalnızca `instagram-data` dalına yazar. Gönderim başarısız olursa kullanıcıya bildirin. Bu durumda ertesi gün araç daha yavaş çalışır ama yine çalışır.

## Kurallar

- Videoları ve `out/` klasörünü hiçbir dala commit etmeyin.
- `main` dalına ve kaynak kodlara dokunmayın; pull request açmayın.
- Görevin yaptığı tek git değişikliği 5. adımdaki `instagram-data` kaydıdır.
- Instagram'a kendiniz paylaşım yapmayın. Paylaşımı kullanıcı yapar.
