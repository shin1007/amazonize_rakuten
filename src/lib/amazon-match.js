/* Amazonize Rakuten - 楽天の商品名からAmazonを引くための言葉の処理
 *
 * 楽天の商品名は宣伝文句の置き場でもある。
 *   "＼9/4～9/11限定ポイント15倍！／［サンプル付き］【公式】ラ・カスタ アロマエステ シャンプー 〈詰替用 570ml〉"
 * このまま検索しても何も当たらないので、宣伝を落として「商品そのものの名前」だけにする。
 *
 * 当たりの良し悪しは呼び出し側（service worker）が scoreMatch で決める。
 * このファイルは window と self のどちらでも動く（商品ページと service worker の両方で読む）。
 */
(() => {
  const g = typeof window !== 'undefined' ? window : self;
  const AZR = (g.AZR = g.AZR || {});

  /** 全角の英数字・記号を半角に。楽天の商品名は全角と半角が混ざる。 */
  const toHalf = (s) => String(s || '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');

  /*
   * 括弧の中身が宣伝かどうかの判定に使う言葉。
   * 【公式】【送料無料】のような括弧は丸ごと捨てるが、〈詰替用 570ml〉のように
   * 商品を言い当てている括弧もあるので、中身を見て決める。
   */
  const NOISE = new RegExp([
    // 正規表現の断片なので、\\d と書いて文字列の中で \d にする（'\d' は ただの d になる）
    '公式', '正規品', '企画品', '送料無料', 'ポイント', '\\d+倍', 'クーポン', 'OFF', 'オフ', '割引', '値引',
    'セール', 'SALE', '限定', '最大', 'あす楽', '即納', '在庫', '新発売', '出荷', '返品', '無料',
    'プレゼント', '特典', 'ラッピング', 'レビュー', '楽天', '\\d+円', '%', '＼', '／',
    '\\d+月\\d+日', '\\d+/\\d+', 'まとめ買い', '買い回り', 'エントリー', '医薬部外品', '付き'
  ].join('|'), 'i');

  /* 括弧の組。対ごとに書く（[ ] を文字クラスへ入れる書き方を間違えやすいので、動的に組み立てない）。 */
  const BRACKET_RES = [
    /【([^【】]*)】/g,
    /［([^［］]*)］/g,
    /\[([^[\]]*)\]/g,
    /《([^《》]*)》/g,
    /≪([^≪≫]*)≫/g,
    /〔([^〔〕]*)〕/g,
    /（([^（）]*)）/g,
    /\(([^()]*)\)/g,
    /〈([^〈〉]*)〉/g,
    /＜([^＜＞]*)＞/g,
    /<([^<>]*)>/g
  ];

  /** ＼…／ で囲まれた煽り文句。中身に関係なく宣伝なので落とす（中に "9/4" が入るので、半角に倒す前に落とす）。 */
  const stripShout = (s) => s.replace(/＼[^／]*／/g, ' ');

  /**
   * 括弧を外す。中身が宣伝なら丸ごと捨て、そうでなければ括弧だけ外して中身は残す。
   * 入れ子は浅いので、内側から数回まわせば足りる。
   */
  function unbracket(s) {
    let out = s;
    for (const re of BRACKET_RES) {
      for (let i = 0; i < 3; i++) {
        const next = out.replace(re, (_, inner) => (NOISE.test(inner) ? ' ' : ` ${inner} `));
        if (next === out) break;
        out = next;
      }
    }
    return out;
  }

  /** 商品名から宣伝を落とす。検索語にも突き合わせにも、この形を使う。 */
  function normalizeTitle(title) {
    // 括弧を外すのは半角に倒した後（［］と[]の両方が来る）。煽り文句だけは倒す前に落とす。
    let s = toHalf(stripShout(String(title || '').replace(/<br\s*\/?>/gi, ' ')));
    s = unbracket(s);
    // 区切り記号は空白に倒す（"シャンプー/トリートメント" を1語にしない）
    s = s.replace(/[|/・,、。!?"'`“”‘’*#♪★☆◆■▼▲→←~〜:;+]+/g, ' ');
    // 括弧の外に裸で残った宣伝句
    s = s.replace(/(?:送料無料|あす楽|最大\s*\d+\s*(?:%|倍)|ポイント\s*\d+\s*倍|\d+\s*%\s*(?:OFF|オフ)|\d+月\d+日)/gi, ' ');
    return s.replace(/\s+/g, ' ').trim();
  }

  /** "350ml" "1kg" "3個セット" のような数量。同じ商品名でも容量違いは別物なので、突き合わせで重く見る。 */
  function sizeTokens(s) {
    const found = toHalf(s).toLowerCase().match(/\d+(?:\.\d+)?\s*(?:ml|l|g|kg|mg|cm|mm|個|枚|本|袋|包|錠|回|セット)/g) || [];
    return [...new Set(found.map((t) => t.replace(/\s+/g, '')))];
  }

  /**
   * 突き合わせに使う語。日本語は分かち書きしないので、ラテン文字・数字・カタカナ・漢字の
   * まとまりを語とみなす（ひらがなは助詞ばかりで雑音になるので拾わない）。
   *
   * カタカナの直後に続くラテン文字は切り離さない。「スカルプD」を「スカルプ」と「d」に割ると、
   * h&s の「ドライスカルプ」にも「スカルプ」が含まれるので、別ブランドが同じだけ当たってしまう。
   * ブランド名の末尾の1文字（スカルプD / ケアミーS など）は、商品を言い当てる大事な手がかり。
   */
  function titleTokens(s) {
    const t = normalizeTitle(s).toLowerCase();
    const words = t.match(/[a-z0-9][a-z0-9.-]*|[ァ-ヴー]{2,}[a-z0-9]*|[一-龠々]{2,}/g) || [];
    return [...new Set(words.filter((w) => w.length >= 2))];
  }

  /** JANは13桁（8桁もある）。チェックディジットまで見て、店舗の品番と取り違えないようにする。 */
  function isJan(code) {
    const s = String(code || '').replace(/[^\d]/g, '');
    if (s.length !== 13 && s.length !== 8) return false;
    const digits = [...s].map(Number);
    const check = digits.pop();
    // チェックディジットの隣から 3,1,3,1…
    const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
    return (10 - (sum % 10)) % 10 === check;
  }

  /**
   * 検索語。長すぎるとAmazonは何も返さない。楽天の商品名は宣伝を落とすと
   * 「ブランド 商品名 容量」の順に残ることが多いので、頭から数語を使う。
   */
  const QUERY_WORDS = 8;
  const QUERY_MAX = 60;

  function buildQuery(title) {
    const words = normalizeTitle(title).split(' ').filter(Boolean);
    const query = [];
    for (const w of words) {
      if (query.length >= QUERY_WORDS) break;
      if (query.join(' ').length + 1 + w.length > QUERY_MAX) break;
      query.push(w);
    }
    return query.join(' ');
  }

  /**
   * 楽天の商品名とAmazonの商品名がどれだけ重なるか（0〜1）。
   * 楽天側の語がAmazon側にどれだけ含まれるかで見る（Amazonの商品名の方が短いことが多く、
   * 双方向で見ると同じ商品でも低く出る）。容量が食い違うものは別の商品なので大きく下げる。
   *
   * 語は長さで重みを付ける。「薬用」「頭皮」「フケ」のような短い語はどのシャンプーにも出てくるので、
   * 数だけで見ると別ブランドの商品が上位に来る（実際に「スカルプD 薬用スカルプシャンプー 350ml」に対して
   * h&s の薬用シャンプーが同点で並んだ）。「スカルプシャンプー」のような長い語ほど商品を言い当てている。
   *
   * さらに、先頭の語は3倍で数える。楽天の商品名は宣伝を落とすとブランド名から始まることが多く、
   * そこが合っているかどうかがいちばん効く。実測（スカルプD 350ml の検索結果）:
   *   同じ重み  h&s 0.35 > スカルプD 0.32   ← 別ブランドが勝ってしまう
   *   3倍       h&s 0.27 < スカルプD 0.49
   */
  const FIRST_TOKEN_WEIGHT = 3;

  function scoreMatch(rakutenTitle, amazonTitle) {
    const want = titleTokens(rakutenTitle);
    const got = titleTokens(amazonTitle);
    if (!want.length || !got.length) return 0;
    const hay = got.join(' ');
    const weigh = (w, i) => w.length * (i === 0 ? FIRST_TOKEN_WEIGHT : 1);
    const total = want.reduce((sum, w, i) => sum + weigh(w, i), 0);
    const hit = want.reduce((sum, w, i) => sum + (hay.includes(w) ? weigh(w, i) : 0), 0);
    let score = hit / total;

    const wantSize = sizeTokens(rakutenTitle);
    const gotSize = sizeTokens(amazonTitle);
    if (wantSize.length && gotSize.length && !wantSize.some((s) => gotSize.includes(s))) score *= 0.5;
    return Math.round(score * 100) / 100;
  }

  /**
   * 名前で引いたとき、これだけ重なれば同じ商品とみなす（= 値差まで出す）。
   * 実測では、同じ商品で0.8〜0.9、同じブランドの別の内容量で0.5前後だったので、その上に置く。
   */
  const SURE_SCORE = 0.6;

  /**
   * 商品ページに出す見出し。何を根拠に当てたのかを、そのまま言葉にする。
   *
   * JANで引いたものは「似た商品」ではなく、同じJANコードの商品そのもの。言い切ってよい。
   * 名前で引いたものは当てずっぽうが混じるので、重なりが薄いか、楽天側が選択肢で
   * 値段の変わる商品（どの選択肢と突き合わせたのか決められない）なら「参考」を付ける。
   */
  function matchLabel({ byJan = false, score = 0, variants = 0 } = {}) {
    if (byJan) return { label: 'の同じ商品', badge: 'JANコード一致', sure: true };
    if (score >= SURE_SCORE && !variants) return { label: 'での価格', badge: null, sure: true };
    return { label: 'の似た商品', badge: '参考', sure: false };
  }

  AZR.amazon = { normalizeTitle, titleTokens, sizeTokens, buildQuery, scoreMatch, isJan, matchLabel };
})();
