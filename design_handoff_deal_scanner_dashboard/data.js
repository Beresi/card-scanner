/* ============================================================
   MOCK DATA — believable MTG marketplace state
   All money in integer cents (USD), per the PRD.
   Exposed on window.CB
   ============================================================ */
(function () {
  const usd = (cents) => "$" + (cents / 100).toFixed(2);

  // ---- expansions cache (subset) ----
  const expansions = [
    { id: 1623, code: "mh2",  name: "Modern Horizons 2" },
    { id: 1801, code: "ltr",  name: "LotR: Tales of Middle-earth" },
    { id: 1711, code: "dmu",  name: "Dominaria United" },
    { id: 1689, code: "one",  name: "Phyrexia: All Will Be One" },
    { id: 1577, code: "neo",  name: "Kamigawa: Neon Dynasty" },
    { id: 1603, code: "snc",  name: "Streets of New Capenna" },
    { id: 1834, code: "woe",  name: "Wilds of Eldraine" },
    { id: 1456, code: "mh1",  name: "Modern Horizons" },
    { id: 1902, code: "mkm",  name: "Murders at Karlov Manor" },
    { id: 1455, code: "ema",  name: "Eternal Masters" },
  ];

  // ---- blueprints cache (subset, for add-card UX) ----
  const blueprints = [
    { id: 100501, expansion_id: 1623, name: "Ragavan, Nimble Pilferer" },
    { id: 100502, expansion_id: 1623, name: "Urza's Saga" },
    { id: 100503, expansion_id: 1623, name: "Murktide Regent" },
    { id: 100504, expansion_id: 1623, name: "Grief" },
    { id: 100601, expansion_id: 1711, name: "Sheoldred, the Apocalypse" },
    { id: 100602, expansion_id: 1711, name: "Liliana of the Veil" },
    { id: 100701, expansion_id: 1801, name: "The One Ring" },
    { id: 100702, expansion_id: 1801, name: "Orcish Bowmasters" },
    { id: 100703, expansion_id: 1801, name: "Delighted Halfling" },
    { id: 100801, expansion_id: 1577, name: "Fable of the Mirror-Breaker" },
    { id: 100802, expansion_id: 1577, name: "Boseiju, Who Endures" },
    { id: 100901, expansion_id: 1603, name: "Ledger Shredder" },
    { id: 101001, expansion_id: 1689, name: "Atraxa, Grand Unifier" },
    { id: 101101, expansion_id: 1834, name: "Up the Beanstalk" },
  ];

  // ---- watchlist ----
  // override fields use null = inherit from config
  const config = {
    default_threshold_pct: 50,
    default_min_condition: "Near Mint",
    cohort_size: 10,
    min_cohort: 5,
    new_ticket_foil_pref: "any",
    new_ticket_allow_graded: 0,
    new_ticket_importance: "normal",
    new_ticket_telegram_enabled: 0,
    telegram_min_discount_pct: 60,
    quiet_hours_start: 23,
    quiet_hours_end: 7,
    digest_on_quiet_end: 1,
    theme: "dark",
    accent_color: "#22d3ee",
    density: "comfortable",
    deal_retention_days: 30,
    timezone: "Asia/Jerusalem",
    currency: "USD",
  };

  const watchlist = [
    { id: 1, type: "blueprint", cardtrader_id: 100501, label: "Ragavan, Nimble Pilferer", expansion: "Modern Horizons 2",
      min_condition: null, foil_pref: "nonfoil", allow_graded: 0, threshold_pct: 55, importance: "high",
      telegram_enabled: 1, telegram_min_discount_pct: null, telegram_max_price_cents: null, telegram_min_savings_cents: null, active: 1, hits: 3 },
    { id: 2, type: "blueprint", cardtrader_id: 100701, label: "The One Ring", expansion: "LotR: Tales of Middle-earth",
      min_condition: "Near Mint", foil_pref: "any", allow_graded: 0, threshold_pct: null, importance: "high",
      telegram_enabled: 1, telegram_min_discount_pct: null, telegram_max_price_cents: null, telegram_min_savings_cents: null, active: 1, hits: 1 },
    { id: 3, type: "expansion", cardtrader_id: 1623, label: "Modern Horizons 2", expansion: "— full set —",
      min_condition: null, foil_pref: "any", allow_graded: 0, threshold_pct: null, importance: "normal",
      telegram_enabled: 0, telegram_min_discount_pct: 65, telegram_max_price_cents: null, telegram_min_savings_cents: 500, active: 1, hits: 7 },
    { id: 4, type: "blueprint", cardtrader_id: 100601, label: "Sheoldred, the Apocalypse", expansion: "Dominaria United",
      min_condition: "Near Mint", foil_pref: "nonfoil", allow_graded: 0, threshold_pct: null, importance: "high",
      telegram_enabled: 1, telegram_min_discount_pct: null, telegram_max_price_cents: 6000, telegram_min_savings_cents: null, active: 1, hits: 2 },
    { id: 5, type: "blueprint", cardtrader_id: 100702, label: "Orcish Bowmasters", expansion: "LotR: Tales of Middle-earth",
      min_condition: null, foil_pref: "nonfoil", allow_graded: 0, threshold_pct: null, importance: "normal",
      telegram_enabled: 0, telegram_min_discount_pct: null, telegram_max_price_cents: null, telegram_min_savings_cents: null, active: 1, hits: 4 },
    { id: 6, type: "expansion", cardtrader_id: 1801, label: "LotR: Tales of Middle-earth", expansion: "— full set —",
      min_condition: "Slightly Played", foil_pref: "any", allow_graded: 0, threshold_pct: 45, importance: "normal",
      telegram_enabled: 0, telegram_min_discount_pct: null, telegram_max_price_cents: null, telegram_min_savings_cents: null, active: 1, hits: 11 },
    { id: 7, type: "blueprint", cardtrader_id: 100801, label: "Fable of the Mirror-Breaker", expansion: "Kamigawa: Neon Dynasty",
      min_condition: null, foil_pref: "nonfoil", allow_graded: 0, threshold_pct: null, importance: "normal",
      telegram_enabled: 0, telegram_min_discount_pct: null, telegram_max_price_cents: null, telegram_min_savings_cents: null, active: 0, hits: 0 },
    { id: 8, type: "blueprint", cardtrader_id: 101001, label: "Atraxa, Grand Unifier", expansion: "Phyrexia: All Will Be One",
      min_condition: "Near Mint", foil_pref: "any", allow_graded: 0, threshold_pct: null, importance: "high",
      telegram_enabled: 1, telegram_min_discount_pct: null, telegram_max_price_cents: null, telegram_min_savings_cents: null, active: 1, hits: 1 },
  ];

  // ---- expand watchlist to a realistic size (40+ items) ----
  const POOL = [
    ["Lightning Bolt", "Modern Horizons", "mh1"], ["Counterspell", "Modern Horizons 2", "mh2"],
    ["Force of Will", "Eternal Masters", "ema"], ["Mox Opal", "Modern Horizons 2", "mh2"],
    ["Wrenn and Six", "Modern Horizons", "mh1"], ["Bloodtithe Harvester", "Crimson Vow", "vow"],
    ["Solitude", "Modern Horizons 2", "mh2"], ["Grief", "Modern Horizons 2", "mh2"],
    ["Fury", "Modern Horizons 2", "mh2"], ["Subtlety", "Modern Horizons 2", "mh2"],
    ["Esper Sentinel", "Modern Horizons 2", "mh2"], ["Dauthi Voidwalker", "Modern Horizons 2", "mh2"],
    ["Delighted Halfling", "LotR: Tales of Middle-earth", "ltr"], ["Boseiju, Who Endures", "Kamigawa: Neon Dynasty", "neo"],
    ["The Goose Mother", "Wilds of Eldraine", "woe"], ["Up the Beanstalk", "Wilds of Eldraine", "woe"],
    ["Ledger Shredder", "Streets of New Capenna", "snc"], ["Ojer Taq", "Lost Caverns of Ixalan", "lci"],
    ["Phlage, Titan of Fire's Fury", "Modern Horizons 3", "mh3"], ["Necrodominance", "Modern Horizons 3", "mh3"],
    ["Nadu, Winged Wisdom", "Modern Horizons 3", "mh3"], ["Flare of Denial", "Modern Horizons 3", "mh3"],
    ["Psychic Frog", "Modern Horizons 3", "mh3"], ["Ugin's Labyrinth", "Modern Horizons 3", "mh3"],
    ["Loran's Escape", "Brothers' War", "bro"], ["Mishra's Bauble", "Modern Horizons 2", "mh2"],
    ["Sheoldred's Edict", "Dominaria United", "dmu"], ["Archive Trap", "Zendikar", "zen"],
    ["Thoughtseize", "Theros", "ths"], ["Fatal Push", "Aether Revolt", "aer"],
    ["Expressive Iteration", "Strixhaven", "stx"], ["Prismatic Ending", "Modern Horizons 2", "mh2"],
    ["Leyline Binding", "Dominaria United", "dmu"], ["Scion of Draco", "Modern Horizons 2", "mh2"],
    ["Tarmogoyf", "Modern Horizons 2", "mh2"], ["Snapcaster Mage", "Innistrad", "isd"],
    ["Teferi, Time Raveler", "War of the Spark", "war"], ["Karn, the Great Creator", "War of the Spark", "war"],
    ["Walking Ballista", "Aether Revolt", "aer"], ["Chalice of the Void", "Modern Masters", "mma"],
  ];
  const COND = ["Near Mint", "Near Mint", "Near Mint", "Slightly Played", "Mint"];
  const FOIL = ["any", "nonfoil", "nonfoil", "foil"];
  let wid = 9;
  POOL.forEach((p, i) => {
    const high = i % 5 === 0;
    const tg = high || i % 4 === 0;
    watchlist.push({
      id: wid++, type: i % 7 === 0 ? "expansion" : "blueprint",
      cardtrader_id: 110000 + i, label: p[0], expansion: i % 7 === 0 ? "— full set —" : p[1],
      min_condition: i % 3 === 0 ? null : COND[i % COND.length],
      foil_pref: FOIL[i % FOIL.length], allow_graded: 0,
      threshold_pct: i % 4 === 0 ? null : 40 + (i % 6) * 5,
      importance: high ? "high" : "normal",
      telegram_enabled: tg ? 1 : 0,
      telegram_min_discount_pct: i % 5 === 0 ? null : 55 + (i % 4) * 5,
      telegram_max_price_cents: i % 6 === 0 ? (3000 + i * 100) : null,
      telegram_min_savings_cents: null,
      active: i % 9 === 0 ? 0 : 1,
      hits: (i * 7 + 3) % 13,
    });
  });

  // ---- deals feed ----
  // helper to build a deal
  let did = 1000;
  function deal(o) {
    const baseline = o.baseline_cents, price = o.price_cents;
    const discount = Math.round((1 - price / baseline) * 100);
    return Object.assign({
      id: did++, seen: 0, dismissed: 0, telegram_sent: 0, language: "en",
      currency: "USD", cohort_size: 10, quantity: 1, allow_graded: 0,
      discount_pct: discount, savings_cents: baseline - price,
      buy_url: "https://www.cardtrader.com/cards/" + o.blueprint_id,
    }, o);
  }

  const now = Date.now();
  const mins = (m) => new Date(now - m * 60000).toISOString();

  const deals = [
    deal({ watchlist_id: 1, blueprint_id: 100501, card_name: "Ragavan, Nimble Pilferer", expansion_name: "Modern Horizons 2",
      seller_username: "tabletop_sofia", seller_country: "BG", condition: "Near Mint", foil: 0, can_sell_via_hub: 1,
      price_cents: 3200, baseline_cents: 7400, priority: "high", telegram_sent: 1, found_at: mins(6) }),
    deal({ watchlist_id: 2, blueprint_id: 100701, card_name: "The One Ring", expansion_name: "LotR: Tales of Middle-earth",
      seller_username: "mithril_market", seller_country: "DE", condition: "Near Mint", foil: 0, can_sell_via_hub: 1,
      price_cents: 2150, baseline_cents: 4600, priority: "high", telegram_sent: 1, found_at: mins(6) }),
    deal({ watchlist_id: 4, blueprint_id: 100601, card_name: "Sheoldred, the Apocalypse", expansion_name: "Dominaria United",
      seller_username: "apex_cards_it", seller_country: "IT", condition: "Near Mint", foil: 0, can_sell_via_hub: 0,
      price_cents: 4990, baseline_cents: 8800, priority: "high", telegram_sent: 1, found_at: mins(7) }),
    deal({ watchlist_id: 3, blueprint_id: 100502, card_name: "Urza's Saga", expansion_name: "Modern Horizons 2",
      seller_username: "lotus_lab", seller_country: "FR", condition: "Slightly Played", foil: 0, can_sell_via_hub: 1,
      price_cents: 1850, baseline_cents: 3300, priority: "normal", found_at: mins(7) }),
    deal({ watchlist_id: 5, blueprint_id: 100702, card_name: "Orcish Bowmasters", expansion_name: "LotR: Tales of Middle-earth",
      seller_username: "bag_end_goods", seller_country: "GB", condition: "Near Mint", foil: 0, can_sell_via_hub: 1,
      price_cents: 980, baseline_cents: 1650, priority: "normal", found_at: mins(7), seen: 1 }),
    deal({ watchlist_id: 6, blueprint_id: 100703, card_name: "Delighted Halfling", expansion_name: "LotR: Tales of Middle-earth",
      seller_username: "shire_singles", seller_country: "NL", condition: "Near Mint", foil: 0, can_sell_via_hub: 0,
      price_cents: 540, baseline_cents: 1120, priority: "normal", found_at: mins(66), seen: 1 }),
    deal({ watchlist_id: 8, blueprint_id: 101001, card_name: "Atraxa, Grand Unifier", expansion_name: "Phyrexia: All Will Be One",
      seller_username: "compleated", seller_country: "PL", condition: "Near Mint", foil: 1, can_sell_via_hub: 1,
      price_cents: 2400, baseline_cents: 4100, priority: "high", telegram_sent: 1, found_at: mins(66) }),
    deal({ watchlist_id: 6, blueprint_id: 100802, card_name: "Boseiju, Who Endures", expansion_name: "Kamigawa: Neon Dynasty",
      seller_username: "kamigawa_ko", seller_country: "JP", condition: "Slightly Played", foil: 0, can_sell_via_hub: 1,
      price_cents: 1290, baseline_cents: 2200, priority: "normal", found_at: mins(67), seen: 1 }),
    deal({ watchlist_id: 3, blueprint_id: 100503, card_name: "Murktide Regent", expansion_name: "Modern Horizons 2",
      seller_username: "delver_depot", seller_country: "ES", condition: "Near Mint", foil: 0, can_sell_via_hub: 0,
      price_cents: 1100, baseline_cents: 2050, priority: "normal", found_at: mins(126), seen: 1 }),
    deal({ watchlist_id: 5, blueprint_id: 100702, card_name: "Orcish Bowmasters", expansion_name: "LotR: Tales of Middle-earth",
      seller_username: "rivendell_rares", seller_country: "FI", condition: "Near Mint", foil: 0, can_sell_via_hub: 1,
      price_cents: 1050, baseline_cents: 1700, priority: "normal", found_at: mins(127), seen: 1 }),
    deal({ watchlist_id: 6, blueprint_id: 100901, card_name: "Ledger Shredder", expansion_name: "Streets of New Capenna",
      seller_username: "obscura_trade", seller_country: "US", condition: "Near Mint", foil: 0, can_sell_via_hub: 1,
      price_cents: 420, baseline_cents: 760, priority: "normal", found_at: mins(186), seen: 1, dismissed: 1 }),
    deal({ watchlist_id: 4, blueprint_id: 100602, card_name: "Liliana of the Veil", expansion_name: "Dominaria United",
      seller_username: "veil_vault", seller_country: "DE", condition: "Near Mint", foil: 0, can_sell_via_hub: 0,
      price_cents: 1380, baseline_cents: 2300, priority: "normal", found_at: mins(188), seen: 1 }),
  ];

  // ---- generate additional deals to populate the feed ----
  const DPOOL = [
    ["Solitude", "Modern Horizons 2", 100504, "lotus_lab", "FR", "Near Mint", 0, 1, 2890, 5200],
    ["Esper Sentinel", "Modern Horizons 2", 100505, "kibler_kards", "DE", "Near Mint", 0, 0, 980, 1900],
    ["Phlage, Titan of Fire's Fury", "Modern Horizons 3", 100506, "titan_trade", "US", "Near Mint", 0, 1, 1650, 3100],
    ["Nadu, Winged Wisdom", "Modern Horizons 3", 100507, "wisdom_wares", "IT", "Slightly Played", 0, 0, 740, 1450],
    ["Thoughtseize", "Theros", 100508, "mono_b_market", "ES", "Near Mint", 0, 0, 1120, 1980],
    ["Bloodtithe Harvester", "Crimson Vow", 100509, "vamp_vault", "PL", "Near Mint", 0, 0, 310, 580],
    ["Walking Ballista", "Aether Revolt", 100510, "artifact_ace", "NL", "Near Mint", 0, 1, 1740, 2950],
    ["Leyline Binding", "Dominaria United", 100511, "domri_deals", "GB", "Near Mint", 0, 0, 420, 820],
    ["Tarmogoyf", "Modern Horizons 2", 100512, "goyf_grotto", "JP", "Slightly Played", 0, 0, 560, 1100],
    ["Boseiju, Who Endures", "Kamigawa: Neon Dynasty", 100513, "channel_lands", "FI", "Near Mint", 0, 1, 1190, 2080],
    ["Sheoldred's Edict", "Dominaria United", 100514, "edict_emporium", "DE", "Near Mint", 0, 0, 180, 360],
    ["Mishra's Bauble", "Modern Horizons 2", 100515, "bauble_bay", "US", "Near Mint", 0, 1, 240, 470],
  ];
  DPOOL.forEach((d, i) => {
    const disc = Math.round((1 - d[8] / d[9]) * 100);
    const high = disc >= 55 && i % 3 === 0;
    deals.push(deal({
      watchlist_id: (i % 8) + 1, blueprint_id: d[2], card_name: d[0], expansion_name: d[1],
      seller_username: d[3], seller_country: d[4], condition: d[5], foil: d[6], can_sell_via_hub: d[7],
      price_cents: d[8], baseline_cents: d[9], priority: high ? "high" : "normal",
      telegram_sent: high ? 1 : 0, found_at: mins(8 + i * 11), seen: i % 3 === 0 ? 1 : 0,
    }));
  });

  // ---- scan run history ----
  const scanRuns = [
    { id: 412, started_at: mins(6), finished_at: mins(5), watch_items_scanned: 7, blueprints_scanned: 1190, api_calls: 9, deals_found: 4, telegram_sent: 3, error: null },
    { id: 411, started_at: mins(66), finished_at: mins(65), watch_items_scanned: 7, blueprints_scanned: 1190, api_calls: 9, deals_found: 2, telegram_sent: 1, error: null },
    { id: 410, started_at: mins(126), finished_at: mins(125), watch_items_scanned: 7, blueprints_scanned: 1190, api_calls: 9, deals_found: 1, telegram_sent: 0, error: null },
    { id: 409, started_at: mins(186), finished_at: mins(185), watch_items_scanned: 7, blueprints_scanned: 1188, api_calls: 9, deals_found: 1, telegram_sent: 0, error: null },
    { id: 408, started_at: mins(246), finished_at: mins(245), watch_items_scanned: 7, blueprints_scanned: 1188, api_calls: 10, deals_found: 0, telegram_sent: 0, error: "blueprint 100503: HTTP 429 (backed off, skipped)" },
    { id: 407, started_at: mins(306), finished_at: mins(305), watch_items_scanned: 7, blueprints_scanned: 1188, api_calls: 9, deals_found: 3, telegram_sent: 2, error: null },
  ];

  const CONDITIONS = ["Mint", "Near Mint", "Slightly Played", "Moderately Played", "Played", "Heavily Played", "Poor"];
  const CONDITION_SHORT = { "Mint": "M", "Near Mint": "NM", "Slightly Played": "SP", "Moderately Played": "MP", "Played": "PL", "Heavily Played": "HP", "Poor": "PR" };

  window.CB = {
    usd, expansions, blueprints, watchlist, deals, config, scanRuns,
    CONDITIONS, CONDITION_SHORT,
  };
})();
