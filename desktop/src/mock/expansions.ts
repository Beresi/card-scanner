/**
 * Mock expansions — for the add-flow set search. Mirrors the worker
 * ExpansionRow / what GET /api/resolve/expansions returns: id, game_id, code, name.
 * ~20 MTG sets with realistic CardTrader IDs.
 */

export interface MockExpansion {
  id: number;
  game_id: number;
  code: string;
  name: string;
}

export const MOCK_EXPANSIONS: MockExpansion[] = [
  { id: 1623, game_id: 1, code: 'mh2', name: 'Modern Horizons 2' },
  { id: 1801, game_id: 1, code: 'ltr', name: 'LotR: Tales of Middle-earth' },
  { id: 1711, game_id: 1, code: 'dmu', name: 'Dominaria United' },
  { id: 1689, game_id: 1, code: 'one', name: 'Phyrexia: All Will Be One' },
  { id: 1577, game_id: 1, code: 'neo', name: 'Kamigawa: Neon Dynasty' },
  { id: 1603, game_id: 1, code: 'snc', name: 'Streets of New Capenna' },
  { id: 1834, game_id: 1, code: 'woe', name: 'Wilds of Eldraine' },
  { id: 1456, game_id: 1, code: 'mh1', name: 'Modern Horizons' },
  { id: 1902, game_id: 1, code: 'mkm', name: 'Murders at Karlov Manor' },
  { id: 1455, game_id: 1, code: 'ema', name: 'Eternal Masters' },
  { id: 1350, game_id: 1, code: 'mh3', name: 'Modern Horizons 3' },
  { id: 1278, game_id: 1, code: 'bro', name: "The Brothers' War" },
  { id: 1199, game_id: 1, code: 'clb', name: 'Commander Legends: Battle for Baldur\'s Gate' },
  { id: 1150, game_id: 1, code: 'mid', name: 'Innistrad: Midnight Hunt' },
  { id: 1120, game_id: 1, code: 'afr', name: 'Adventures in the Forgotten Realms' },
  { id: 1090, game_id: 1, code: 'stx', name: 'Strixhaven: School of Mages' },
  { id: 1065, game_id: 1, code: 'khm', name: 'Kaldheim' },
  { id: 1040, game_id: 1, code: 'znr', name: 'Zendikar Rising' },
  { id: 1012, game_id: 1, code: 'eld', name: 'Throne of Eldraine' },
  { id: 990,  game_id: 1, code: 'war', name: 'War of the Spark' },
];
