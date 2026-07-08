// Reconciles LGA name spelling/formatting differences between the map
// boundary file (ui/public/data/geo/lgas.geojson) and the warehouse/
// burden.json source of truth. Without this, a geojson polygon whose LGA name
// is spelled differently from the warehouse's name (typo, hyphenation, or a
// real historical rename like Ogun's Egbado -> Yewa) never joins to its
// burden data, so it silently drops out of Visual Overview's LGA-level map
// and zone counts entirely -- while the Dashboard (which reads burden.json
// directly, with no geojson dependency) counts it correctly. This was the
// root cause of Visual Overview's LGA-level zone tallies reading
// systematically lower than the Dashboard's for the same month.
//
// Verified against the real diff between the two files: 774 raw polygon
// features but only 742 unique (state, lga) keys (32 LGAs are split into 2+
// map features each, e.g. riverine/multi-part LGAs -- Nembe, Yola North,
// Warri South, Offa, Uyo), of which 712 matched burden.json's 774 LGA names
// exactly, 30 didn't. This table recovers every case confidently identified
// as a rename/typo (same LGA, different spelling). A residual ~30 LGAs
// (KNOWN_MISSING_LGA_POLYGONS below) have NO polygon in this shapefile under
// ANY name -- that's a genuine gap in the boundary file itself, not a naming
// issue, and can't be fixed by renaming; they simply can't be drawn on this
// map until a more complete LGA shapefile is sourced. The Dashboard's
// national KPIs already include them correctly since it never depends on
// geojson at all.
export const LGA_ALIAS = {
  'Abia|||Isiukwuato': 'Abia|||Isuikwuato',
  'Abia|||Obi Ngwa': 'Abia|||Obi Nwga',
  'Bauchi|||Damban': 'Bauchi|||Dambam',
  'Bayelsa|||Yenegoa': 'Bayelsa|||Yenagoa',
  'Benue|||Oturkpo': 'Benue|||Otukpo',
  'Cross River|||Bekwara': 'Cross River|||Bekwarra',
  'Ekiti|||Ilejemeji': 'Ekiti|||Ilejemeje',
  'Federal Capital Territory|||Abuja Municipal': 'Federal Capital Territory|||Abuja Municipal Area Council',
  'Gombe|||Shomgom': 'Gombe|||Shongom',
  'Imo|||Ezinihitte': 'Imo|||Ezinihitte Mbaise',
  'Imo|||Unuimo': 'Imo|||Onuimo',
  'Jigawa|||Biriniwa': 'Jigawa|||Birniwa',
  'Jigawa|||Birni Kudu': 'Jigawa|||Birnin Kudu',
  'Kaduna|||Markafi': 'Kaduna|||Makarfi',
  'Kaduna|||Zango-Kataf': 'Kaduna|||Zangon Kataf',
  'Kano|||Dambatta': 'Kano|||Danbatta',
  'Kebbi|||Arewa-Dandi': 'Kebbi|||Arewa',
  'Kogi|||Olamabolo': 'Kogi|||Olamaboro',
  'Ogun|||Egbado North': 'Ogun|||Yewa North',
  'Ogun|||Egbado South': 'Ogun|||Yewa South',
  'Ogun|||Shagamu': 'Ogun|||Sagamu',
  'Osun|||Aiyedade': 'Osun|||Ayedaade',
  'Osun|||Aiyedire': 'Osun|||Ayedire',
  'Osun|||Ilesha East': 'Osun|||Ilesa East',
  'Osun|||Ilesha West': 'Osun|||Ilesa West',
  'Oyo|||Atigbo': 'Oyo|||Atisbo',
  'Plateau|||Barikin Ladi': 'Plateau|||Barkin Ladi',
  'Rivers|||Obia/Akpor': 'Rivers|||Obio Akpor',
  'Yobe|||Bursari': 'Yobe|||Busari',
  'Yobe|||Tarmua': 'Yobe|||Tarmuwa',
}

// LGAs confirmed present in burden.json/the warehouse but with NO polygon in
// lgas.geojson under any name -- documented so this gap is disclosed, not
// silently swallowed. (state -> [lga names])
export const KNOWN_MISSING_LGA_POLYGONS = {
  Adamawa: ['Fufore'],
  'Akwa Ibom': ['Uruan'],
  Anambra: ['Anambra East', 'Dunukofia', 'Idemili South'],
  Bayelsa: ['Brass', 'Sagbama'],
  Borno: ['Jere'],
  'Cross River': ['Odukpani'],
  Delta: ['Isoko North', 'Warri South West'],
  Ekiti: ['Irepodun Ifelodun'],
  Kano: ['Ungogo'],
  Kebbi: ['Danko Wasagu'],
  Kogi: ['Okene'],
  Kwara: ['Asa', 'Ifelodun', 'Oyun'],
  Lagos: ['Ibeju Lekki'],
  Nasarawa: ['Karu'],
  Niger: ['Bosso'],
  Ondo: ['Akoko North East', 'Odigbo'],
  Osun: ['Irepodun'],
  Oyo: ['Atiba', 'Ido', 'Lagelu', 'Ori Ire'],
  Sokoto: ['Wamako'],
  Taraba: ['Takum'],
  Yobe: ['Yusufari'],
  Zamfara: ['Gusau'],
}

// Given a geojson feature's raw state/lga properties, returns the burden.json
// key to look up -- aliased if this exact (state, lga) pair is a known
// rename/typo, otherwise the raw key unchanged.
export function lgaKeyFor(state, lga) {
  const raw = `${state}|||${lga}`
  return LGA_ALIAS[raw] || raw
}
