const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const WC_API = 'https://api.football-data.org/v4';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const { participants } = require('./config/participants.json');
const { players: draftedPlayers } = require('./config/players.json');
const { tiers } = require('./config/tiers.json');

// ── Tier lookup: team name → { multiplier, tier } ─────────────────────────
// Nicknames used in participants.json that don't match tiers.json team names
const TEAM_ALIASES = { 'shakira': 'colombia' };

function normTeam(s) {
  const n = String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  return TEAM_ALIASES[n] || n;
}

const tierByTeam = {};
for (const t of tiers) {
  for (const name of t.teams) {
    tierByTeam[normTeam(name)] = { multiplier: t.multiplier, tier: t.tier };
  }
}

// ── Player lookup: teamTla → [{name, apiNorm, participantId}] ──────────────
function normName(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const playersByTeam = {};
for (const dp of draftedPlayers) {
  const tla = dp.teamTla.toUpperCase();
  if (!playersByTeam[tla]) playersByTeam[tla] = [];
  playersByTeam[tla].push({ name: dp.name, apiNorm: normName(dp.apiName || dp.name), participantId: dp.participantId });
}

function namesMatch(normScorer, apiNorm) {
  if (normScorer === apiNorm) return true;
  const w1 = normScorer.split(' '), w2 = apiNorm.split(' ');
  const last1 = w1[w1.length - 1], last2 = w2[w2.length - 1];
  if (last1 === last2 && last1.length > 3) return true;
  if (normScorer.includes(apiNorm) || apiNorm.includes(normScorer)) return true;
  return false;
}

// ── Cache ──────────────────────────────────────────────────────────────────
let cache = { matches: [], fetchedAt: 0 };

async function getMatches() {
  if (Date.now() - cache.fetchedAt < CACHE_TTL && cache.matches.length > 0) {
    return cache.matches;
  }
  try {
    const res = await axios.get(`${WC_API}/competitions/WC/matches?season=2026`, {
      headers: { 'X-Auth-Token': API_KEY },
      timeout: 10000,
    });
    cache.matches = res.data.matches || [];
    cache.fetchedAt = Date.now();
    console.log(`Fetched ${cache.matches.length} WC 2026 matches from API`);
  } catch (err) {
    const status = err.response?.status;
    console.error(`Football API error (${status}):`, err.message);
    if (cache.matches.length === 0) throw err;
    console.warn('Serving stale cache');
  }
  return cache.matches;
}

// ── Scoring ────────────────────────────────────────────────────────────────
// Points earned for each round a team reaches (cumulative).
// 2026 WC has an extra R32 before R16; awarding 1 pt for that new round.
const ROUND_POINTS = {
  LAST_32:        1,
  LAST_16:        3,
  QUARTER_FINALS: 6,
  SEMI_FINALS:    12,
  FINAL:          15,
};
const CHAMPION_BONUS = 20;

function scoreTeam(tla, matches) {
  const t = (tla || '').toUpperCase();
  let groupWins = 0;
  const roundsSeen = new Set();
  let champion = false;

  for (const m of matches) {
    if (m.status !== 'FINISHED') continue;
    const isHome = m.homeTeam?.tla?.toUpperCase() === t;
    const isAway = m.awayTeam?.tla?.toUpperCase() === t;
    if (!isHome && !isAway) continue;

    const won =
      (isHome && m.score?.winner === 'HOME_TEAM') ||
      (isAway && m.score?.winner === 'AWAY_TEAM');

    if (m.stage === 'GROUP_STAGE') {
      if (won) groupWins++;
    } else if (ROUND_POINTS[m.stage] !== undefined) {
      roundsSeen.add(m.stage);
      if (m.stage === 'FINAL' && won) champion = true;
    }
    // THIRD_PLACE match: no extra points (team already credited for SEMI_FINALS appearance)
  }

  let pts = groupWins;
  for (const r of roundsSeen) pts += ROUND_POINTS[r];
  if (champion) pts += CHAMPION_BONUS;

  const roundsAdvanced = ['LAST_32', 'LAST_16', 'QUARTER_FINALS', 'SEMI_FINALS', 'FINAL']
    .filter(r => roundsSeen.has(r));

  return { pts, groupWins, roundsAdvanced, champion };
}

function scoreGoals(matches) {
  // Returns { [participantId]: { [playerName]: goalCount } }
  const result = {};
  for (const m of matches) {
    if (m.status !== 'FINISHED' || !Array.isArray(m.goals)) continue;
    for (const g of m.goals) {
      if (g.type === 'OWN_GOAL') continue;
      if (!g.scorer?.name || !g.team?.tla) continue;
      const tla = g.team.tla.toUpperCase();
      const normScorer = normName(g.scorer.name);
      for (const dp of (playersByTeam[tla] || [])) {
        if (namesMatch(normScorer, dp.apiNorm)) {
          if (!result[dp.participantId]) result[dp.participantId] = {};
          result[dp.participantId][dp.name] = (result[dp.participantId][dp.name] || 0) + 1;
          break;
        }
      }
    }
  }
  return result;
}

function buildParticipantData(p, matches, goalData) {
  const teams = p.teams.map(t => {
    const score = scoreTeam(t.tla, matches);
    const { multiplier = 1.0, tier = null } = tierByTeam[normTeam(t.name)] || {};
    const basePts = score.pts;
    const pts = basePts * multiplier;
    return { ...t, ...score, basePts, pts, multiplier, tier };
  });
  const teamPts = teams.reduce((s, t) => s + t.pts, 0);
  const participantGoals = goalData[p.id] || {};
  const players = (p.players || []).map(pl => {
    const goals = participantGoals[pl.name] || 0;
    return { ...pl, goals, pts: goals };
  });
  const playerPts = players.reduce((s, pl) => s + pl.pts, 0);
  return { ...p, teams, players, teamPts, playerPts, total: teamPts + playerPts };
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/leaderboard', async (req, res) => {
  try {
    const matches = await getMatches();
    const goalData = scoreGoals(matches);
    const board = participants
      .map(p => {
        const d = buildParticipantData(p, matches, goalData);
        return { id: d.id, name: d.name, avatar: d.avatar, teamPts: d.teamPts, playerPts: d.playerPts, total: d.total };
      })
      .sort((a, b) => b.total - a.total);

    res.json({ board, fetchedAt: cache.fetchedAt, nextRefresh: cache.fetchedAt + CACHE_TTL });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch World Cup data', detail: err.message });
  }
});

app.get('/api/participant/:id', async (req, res) => {
  try {
    const p = participants.find(x => x.id === Number(req.params.id));
    if (!p) return res.status(404).json({ error: 'Participant not found' });

    const matches = await getMatches();
    const goalData = scoreGoals(matches);
    res.json(buildParticipantData(p, matches, goalData));
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch World Cup data', detail: err.message });
  }
});

// Force-bust the cache (useful during live tournament days)
app.post('/api/refresh', async (req, res) => {
  cache.fetchedAt = 0;
  try {
    await getMatches();
    res.json({ ok: true, matches: cache.matches.length, fetchedAt: cache.fetchedAt });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚽ World Cup Fantasy 2026 running at http://localhost:${PORT}`);
});
