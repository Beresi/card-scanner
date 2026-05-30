/**
 * Mock blueprints — for the add-flow card search. Mirrors BlueprintRow /
 * what GET /api/resolve/blueprints returns: id, expansion_id, name, image_url.
 * ~28 cards across several expansion_ids.
 */

export interface MockBlueprint {
  id: number;
  expansion_id: number;
  name: string;
  image_url: string | null;
}

// image_url is null in mock data (we don't host card images)
export const MOCK_BLUEPRINTS: MockBlueprint[] = [
  // Modern Horizons 2 (expansion_id: 1623)
  { id: 100501, expansion_id: 1623, name: 'Ragavan, Nimble Pilferer', image_url: null },
  { id: 100502, expansion_id: 1623, name: "Urza's Saga", image_url: null },
  { id: 100503, expansion_id: 1623, name: 'Murktide Regent', image_url: null },
  { id: 100504, expansion_id: 1623, name: 'Solitude', image_url: null },
  { id: 100505, expansion_id: 1623, name: 'Esper Sentinel', image_url: null },
  { id: 100516, expansion_id: 1623, name: 'Grief', image_url: null },
  { id: 100517, expansion_id: 1623, name: 'Subtlety', image_url: null },
  { id: 100518, expansion_id: 1623, name: 'Dauthi Voidwalker', image_url: null },
  { id: 100519, expansion_id: 1623, name: "Mishra's Bauble", image_url: null },
  { id: 100520, expansion_id: 1623, name: 'Tarmogoyf', image_url: null },

  // LotR: Tales of Middle-earth (expansion_id: 1801)
  { id: 100701, expansion_id: 1801, name: 'The One Ring', image_url: null },
  { id: 100702, expansion_id: 1801, name: 'Orcish Bowmasters', image_url: null },
  { id: 100703, expansion_id: 1801, name: 'Delighted Halfling', image_url: null },

  // Dominaria United (expansion_id: 1711)
  { id: 100601, expansion_id: 1711, name: 'Sheoldred, the Apocalypse', image_url: null },
  { id: 100602, expansion_id: 1711, name: 'Liliana of the Veil', image_url: null },
  { id: 100603, expansion_id: 1711, name: 'Leyline Binding', image_url: null },

  // Kamigawa: Neon Dynasty (expansion_id: 1577)
  { id: 100801, expansion_id: 1577, name: 'Fable of the Mirror-Breaker', image_url: null },
  { id: 100802, expansion_id: 1577, name: 'Boseiju, Who Endures', image_url: null },

  // Streets of New Capenna (expansion_id: 1603)
  { id: 100901, expansion_id: 1603, name: 'Ledger Shredder', image_url: null },

  // Phyrexia: All Will Be One (expansion_id: 1689)
  { id: 101001, expansion_id: 1689, name: 'Atraxa, Grand Unifier', image_url: null },

  // Modern Horizons 3 (expansion_id: 1350)
  { id: 100506, expansion_id: 1350, name: "Phlage, Titan of Fire's Fury", image_url: null },
  { id: 100507, expansion_id: 1350, name: 'Nadu, Winged Wisdom', image_url: null },
  { id: 100508, expansion_id: 1350, name: 'Flare of Denial', image_url: null },
  { id: 100509, expansion_id: 1350, name: 'Psychic Frog', image_url: null },

  // War of the Spark (expansion_id: 990)
  { id: 101101, expansion_id: 990, name: 'Teferi, Time Raveler', image_url: null },
  { id: 101102, expansion_id: 990, name: 'Karn, the Great Creator', image_url: null },

  // Eternal Masters (expansion_id: 1455)
  { id: 101201, expansion_id: 1455, name: 'Force of Will', image_url: null },
  { id: 101202, expansion_id: 1455, name: 'Mana Crypt', image_url: null },
];
