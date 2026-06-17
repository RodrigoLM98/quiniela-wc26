// sync-scores.js — Check if a specific match has finished and record result
// Called by the client at scheduled times: t+90, t+95, t+100, t+120, t+130, t+150 min
// Max 6 calls per match. Returns {finished: true/false} so client stops if done.

const { createClient } = require('@supabase/supabase-js');

const ALLOWED_ORIGIN = 'https://www.wc26pool.com';
const API_BASE = 'https://v3.football.api-sports.io';
const WC2026_LEAGUE = 1;
const WC2026_SEASON = 2026;

const TEAM_MAP = {
  "México":"Mexico","Sudáfrica":"South Africa","Corea del Sur":"South Korea",
  "Chequia":"Czech Republic","Canadá":"Canada","Bosnia":"Bosnia",
  "Estados Unidos":"USA","Paraguay":"Paraguay","Qatar":"Qatar",
  "Suiza":"Switzerland","Brasil":"Brazil","Marruecos":"Morocco",
  "Haití":"Haiti","Escocia":"Scotland","Australia":"Australia",
  "Turquía":"Turkey","Alemania":"Germany","Curazao":"Curacao",
  "Países Bajos":"Netherlands","Japón":"Japan","Costa de Marfil":"Ivory Coast",
  "Ecuador":"Ecuador","Suecia":"Sweden","Túnez":"Tunisia",
  "España":"Spain","Cabo Verde":"Cape Verde","Bélgica":"Belgium",
  "Egipto":"Egypt","Arabia Saudita":"Saudi Arabia","Uruguay":"Uruguay",
  "Irán":"Iran","Nueva Zelanda":"New Zealand","Francia":"France",
  "Senegal":"Senegal","Iraq":"Iraq","Noruega":"Norway","Argentina":"Argentina",
  "Argelia":"Algeria","Austria":"Austria","Jordania":"Jordan",
  "Portugal":"Portugal","DR Congo":"DR Congo","Inglaterra":"England",
  "Croacia":"Croatia","Ghana":"Ghana","Panamá":"Panama",
  "Uzbekistán":"Uzbekistan","Colombia":"Colombia"
};

const FINISHED = new Set(['FT','AET','PEN']);

async function apiGet(path, key) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'x-apisports-key': key }
  });
  if (res.status === 429) { const e = new Error('rate_limit'); e.code = 429; throw e; }
  if (!res.ok) throw new Error(`API-Football ${res.status}`);
  return res.json();
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  if (origin === ALLOWED_ORIGIN) res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (origin && origin !== ALLOWED_ORIGIN) return res.status(403).json({ error: 'Forbidden' });

  const API_KEY = process.env.APIFOOTBALL_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'API key no configurada' });

  const { matchId, debug } = req.body || {};
  if (!matchId) return res.status(400).json({ error: 'matchId requerido' });

  // RAW DIAGNOSTIC: inspect exactly what API-Football returns
  if (debug) {
    try {
      const r1 = await fetch(`${API_BASE}/fixtures?league=1&season=2026&date=2026-06-16`, { headers: { 'x-apisports-key': API_KEY } });
      const j1 = await r1.json();
      const r2 = await fetch(`${API_BASE}/status`, { headers: { 'x-apisports-key': API_KEY } });
      const j2 = await r2.json();
      return res.json({
        debug: true,
        fixtures_query: { httpStatus: r1.status, results: j1.results, errors: j1.errors, sample: (j1.response||[]).slice(0,3).map(f=>({home:f.teams?.home?.name,away:f.teams?.away?.name,date:f.fixture?.date})) },
        account_status: { httpStatus: r2.status, response: j2.response, errors: j2.errors },
      });
    } catch (e) {
      return res.json({ debug: true, error: e.message });
    }
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Get the match from our DB
    const { data: match, error: dbErr } = await supabase
      .from('matches').select('*').eq('id', matchId).single();
    if (dbErr || !match) return res.status(404).json({ error: 'Partido no encontrado' });

    // Already finished — no need to call API
    if (match.home_score != null) {
      return res.json({ finished: true, alreadyRecorded: true });
    }

    // Shared cooldown: avoid duplicate API calls when multiple users trigger at once.
    // Only one call per match per 60s window actually hits the API.
    const cooldownSec = 60;
    const lastChecked = match.last_api_check ? new Date(match.last_api_check).getTime() : 0;
    if (Date.now() - lastChecked < cooldownSec * 1000) {
      return res.json({ finished: false, cooldown: true });
    }
    // Claim the cooldown slot immediately (best-effort lock)
    await supabase.from('matches')
      .update({ last_api_check: new Date().toISOString() })
      .eq('id', matchId);

    let fixtureData = null;

    if (match.api_fixture_id) {
      // We already have the fixture ID — direct lookup (most efficient)
      const data = await apiGet(`/fixtures?id=${match.api_fixture_id}`, API_KEY);
      fixtureData = data.response?.[0] || null;
    } else {
      // First time — find by team names across a 3-day window (handles midnight/timezone).
      const norm = (x) => (x||'').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // strip accents
        .replace(/[^a-z0-9]/g,'').trim();

      const homeEn = TEAM_MAP[match.home_team];
      const awayEn = TEAM_MAP[match.away_team];
      const homeN = norm(homeEn);
      const awayN = norm(awayEn);

      // Build 3-day window around the match (UTC day-1, day, day+1)
      const baseDate = new Date(match.match_time);
      const dates = [-1,0,1].map(off => {
        const d = new Date(baseDate);
        d.setUTCDate(d.getUTCDate()+off);
        return d.toISOString().split('T')[0];
      });

      let allFixtures = [];
      for (const dt of dates) {
        const data = await apiGet(
          `/fixtures?league=${WC2026_LEAGUE}&season=${WC2026_SEASON}&date=${dt}`,
          API_KEY
        );
        allFixtures.push(...(data.response || []));
      }

      const matchFn = (f) => {
        const h = norm(f.teams?.home?.name);
        const a = norm(f.teams?.away?.name);
        return (h===homeN && a===awayN) ||
               (h.includes(homeN)||homeN.includes(h)) && (a.includes(awayN)||awayN.includes(a));
      };
      fixtureData = allFixtures.find(matchFn) || null;

      // DIAGNOSTIC: if not found, return what the API actually saw
      if (!fixtureData) {
        return res.json({
          finished: false,
          reason: 'Partido no encontrado en API',
          diagnostic: {
            buscando: { home: match.home_team, away: match.away_team, homeEn, awayEn },
            datesSearched: dates,
            apiReturnedCount: allFixtures.length,
            apiFixtures: allFixtures.slice(0,30).map(f => ({
              id: f.fixture?.id,
              home: f.teams?.home?.name,
              away: f.teams?.away?.name,
              status: f.fixture?.status?.short,
              date: f.fixture?.date,
            })),
          }
        });
      }

      // Save fixture ID so next calls are direct
      if (fixtureData?.fixture?.id) {
        await supabase.from('matches')
          .update({ api_fixture_id: fixtureData.fixture.id })
          .eq('id', matchId);
      }
    }

    if (!fixtureData) {
      return res.json({ finished: false, reason: 'Partido no encontrado en API' });
    }

    const status = fixtureData.fixture?.status?.short;
    const homeScore = fixtureData.goals?.home;
    const awayScore = fixtureData.goals?.away;

    if (!FINISHED.has(status)) {
      // Match still in progress or not started
      return res.json({ finished: false, status, homeScore, awayScore });
    }

    // Match finished — record result and trigger ranking snapshot
    const winner = homeScore > awayScore ? 'home' :
                   awayScore > homeScore ? 'away' : null;

    // Idempotency guard: re-read to ensure another request didn't already write it
    const { data: fresh } = await supabase
      .from('matches').select('home_score').eq('id', matchId).single();
    if (fresh && fresh.home_score != null) {
      return res.json({ finished: true, alreadyRecorded: true });
    }

    // Snapshot before writing scores
    await supabase.rpc('take_ranking_snapshot', { p_match_id: matchId })
      .then(({ error }) => { if (error) console.warn('Snapshot:', error.message); });

    // Conditional update: only write if still null (atomic-ish guard)
    const { data: updated, error: updateErr } = await supabase.from('matches')
      .update({
        home_score: homeScore,
        away_score: awayScore,
        status: 'finished',
        winner,
      })
      .eq('id', matchId)
      .is('home_score', null)
      .select();

    if (updateErr) throw updateErr;
    if (!updated || updated.length === 0) {
      return res.json({ finished: true, alreadyRecorded: true });
    }

    return res.json({
      finished: true,
      result: `${match.home_team} ${homeScore}-${awayScore} ${match.away_team} (${status})`,
    });

  } catch (err) {
    console.error('sync-scores error:', err.message);
    if (err.code === 429) return res.status(429).json({ error: 'API rate limit' });
    return res.status(500).json({ error: err.message });
  }
};
