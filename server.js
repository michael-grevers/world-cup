const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const WC_API = 'https://api.football-data.org/v4';
const OPENFOOTBALL_WC_URL = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const GOAL_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

const { participants } = require('./config/participants.json');
const { players: draftedPlayers } = require('./config/players.json');
const { tiers } = require('./config/tiers.json');

// ── TLA normalization: map API variants to the canonical TLA used in participants.json ──
// Some APIs use different 3-letter codes for the same team (e.g. URU vs URY for Uruguay)
const TLA_NORMALIZE = { 'URU': 'URY' };
function normTla(tla) {
  const u = (tla || '').toUpperCase();
  return TLA_NORMALIZE[u] || u;
}

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

// ── Match display lookups: team owner + players per team ──────────────────
const teamOwner = {};
const flagByTla = {};
for (const p of participants) {
  for (const t of p.teams) {
    const tla = t.tla?.toUpperCase();
    if (tla) {
      teamOwner[tla] = { name: p.name, avatar: p.avatar, id: p.id };
      if (t.flag) flagByTla[tla] = t.flag;
    }
  }
}

// ── Player lookup for OpenFootball goal matching ───────────────────────────
function normName(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const playersByTeam = {};
for (const dp of draftedPlayers) {
  const tla = dp.teamTla?.toUpperCase();
  if (!tla) continue;
  if (!playersByTeam[tla]) playersByTeam[tla] = [];
  const owner = participants.find(x => x.id === dp.participantId);
  const plInfo = owner?.players?.find(x => x.name === dp.name);
  playersByTeam[tla].push({
    name: dp.name,
    flag: plInfo?.flag || '👤',
    participantName: owner?.name || '',
    participantAvatar: owner?.avatar || '',
    participantId: dp.participantId,
  });
}

const draftedForMatch = draftedPlayers.map(dp => ({
  name: dp.name,
  apiNorm: normName(dp.apiName || dp.name),
  participantId: dp.participantId,
}));

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
let goalCache = { data: {}, fetchedAt: 0 };

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

// ── OpenFootball (player goals, synced every 30 minutes) ───────────────────────────
function scoreGoalsFromOpenFootball(matches) {
  const result = {};
  let totalGoals = 0, matchedGoals = 0;
  for (const m of matches) {
    if (!m.score) continue;
    for (const g of [...(m.goals1 || []), ...(m.goals2 || [])]) {
      if (g.owngoal || !g.name) continue;
      totalGoals++;
      const normScorer = normName(g.name);
      for (const dp of draftedForMatch) {
        if (namesMatch(normScorer, dp.apiNorm)) {
          if (!result[dp.participantId]) result[dp.participantId] = {};
          result[dp.participantId][dp.name] = (result[dp.participantId][dp.name] || 0) + 1;
          matchedGoals++;
          console.log(`⚽ Goal matched: ${g.name} → ${dp.name} (participant ${dp.participantId})`);
          break;
        }
      }
    }
  }
  console.log(`OpenFootball: ${totalGoals} goals processed, ${matchedGoals} matched to drafted players`);
  return result;
}

async function getGoalData(force = false) {
  if (!force && Date.now() - goalCache.fetchedAt < GOAL_CACHE_TTL) {
    return goalCache.data;
  }

  try {
    const res = await axios.get(OPENFOOTBALL_WC_URL, { timeout: 15000 });
    const matches = res.data?.matches || [];
    goalCache.data = scoreGoalsFromOpenFootball(matches);
    goalCache.fetchedAt = Date.now();
    const finished = matches.filter(m => m.score).length;
    console.log(`Synced player goals from OpenFootball (${finished} finished matches)`);
  } catch (err) {
    console.error('OpenFootball error:', err.message);
    if (Object.keys(goalCache.data).length === 0) throw err;
    console.warn('Serving stale goal cache');
  }

  return goalCache.data;
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
const GROUP_WIN_PTS = 1;
const GROUP_DRAW_PTS = 0.5;
const GOAL_PTS = 3;

function scoreTeam(tla, matches) {
  const t = (tla || '').toUpperCase();
  let groupWins = 0;
  let groupDraws = 0;
  const roundsSeen = new Set();
  let champion = false;

  for (const m of matches) {
    if (m.status !== 'FINISHED') continue;
    const isHome = normTla(m.homeTeam?.tla) === t;
    const isAway = normTla(m.awayTeam?.tla) === t;
    if (!isHome && !isAway) continue;

    const won =
      (isHome && m.score?.winner === 'HOME_TEAM') ||
      (isAway && m.score?.winner === 'AWAY_TEAM');
    const drew = m.score?.winner === 'DRAW';

    if (m.stage === 'GROUP_STAGE') {
      if (won) groupWins++;
      else if (drew) groupDraws++;
    } else if (ROUND_POINTS[m.stage] !== undefined) {
      roundsSeen.add(m.stage);
      if (m.stage === 'FINAL' && won) champion = true;
    }
    // THIRD_PLACE match: no extra points (team already credited for SEMI_FINALS appearance)
  }

  let pts = groupWins * GROUP_WIN_PTS + groupDraws * GROUP_DRAW_PTS;
  for (const r of roundsSeen) pts += ROUND_POINTS[r];
  if (champion) pts += CHAMPION_BONUS;

  const roundsAdvanced = ['LAST_32', 'LAST_16', 'QUARTER_FINALS', 'SEMI_FINALS', 'FINAL']
    .filter(r => roundsSeen.has(r));

  return { pts, groupWins, groupDraws, roundsAdvanced, champion };
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
    return { ...pl, goals, pts: goals * GOAL_PTS };
  });
  const playerPts = players.reduce((s, pl) => s + pl.pts, 0);
  return { ...p, teams, players, teamPts, playerPts, total: teamPts + playerPts };
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/leaderboard', async (req, res) => {
  try {
    const [matches, goalData] = await Promise.all([getMatches(), getGoalData()]);
    const board = participants
      .map(p => {
        const d = buildParticipantData(p, matches, goalData);
        return { id: d.id, name: d.name, avatar: d.avatar, teamPts: d.teamPts, playerPts: d.playerPts, total: d.total };
      })
      .sort((a, b) => b.total - a.total);

    res.json({
      board,
      fetchedAt: cache.fetchedAt,
      nextRefresh: cache.fetchedAt + CACHE_TTL,
      goalsFetchedAt: goalCache.fetchedAt,
      goalsNextRefresh: goalCache.fetchedAt + GOAL_CACHE_TTL,
    });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch World Cup data', detail: err.message });
  }
});

app.get('/api/participant/:id', async (req, res) => {
  try {
    const p = participants.find(x => x.id === Number(req.params.id));
    if (!p) return res.status(404).json({ error: 'Participant not found' });

    const [matches, goalData] = await Promise.all([getMatches(), getGoalData()]);
    res.json(buildParticipantData(p, matches, goalData));
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch World Cup data', detail: err.message });
  }
});

// Today's enriched match schedule (used by the match strip UI)
app.get('/api/today-matches', async (req, res) => {
  try {
    const [matches, goalData] = await Promise.all([getMatches(), getGoalData()]);
    const date = req.query.date || new Date().toLocaleDateString('en-CA');
    const from = req.query.from;
    const to   = req.query.to;

    const dayMatches = matches
      .filter(m => {
        if (from && to) return m.utcDate >= from && m.utcDate < to;
        return m.utcDate?.startsWith(date);
      })
      .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

    const enrichedPlayers = (tla) =>
      (playersByTeam[tla] || []).map(p => ({
        ...p,
        goals: goalData[p.participantId]?.[p.name] || 0,
      }));

    const enriched = dayMatches.map(m => {
      const homeTla = normTla(m.homeTeam?.tla) || '';
      const awayTla = normTla(m.awayTeam?.tla) || '';
      return {
        id: m.id,
        utcDate: m.utcDate,
        status: m.status,
        stage: m.stage,
        homeTeam: {
          tla: homeTla,
          name: m.homeTeam?.shortName || m.homeTeam?.name || homeTla || '?',
          flag: flagByTla[homeTla] || '🏳',
          owner: teamOwner[homeTla] || null,
          draftedPlayers: enrichedPlayers(homeTla),
          score: m.score?.fullTime?.home ?? null,
        },
        awayTeam: {
          tla: awayTla,
          name: m.awayTeam?.shortName || m.awayTeam?.name || awayTla || '?',
          flag: flagByTla[awayTla] || '🏳',
          owner: teamOwner[awayTla] || null,
          draftedPlayers: enrichedPlayers(awayTla),
          score: m.score?.fullTime?.away ?? null,
        },
      };
    });

    res.json({ matches: enriched, date, fetchedAt: cache.fetchedAt });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch match data', detail: err.message });
  }
});

// Debug: show raw goal cache contents
app.get('/api/debug/goals', (req, res) => {
  res.json({
    fetchedAt: goalCache.fetchedAt ? new Date(goalCache.fetchedAt).toISOString() : null,
    ageSeconds: goalCache.fetchedAt ? Math.floor((Date.now() - goalCache.fetchedAt) / 1000) : null,
    data: goalCache.data,
  });
});

// Force-bust the cache (useful during live tournament days)
app.post('/api/refresh', async (req, res) => {
  cache.fetchedAt = 0;
  goalCache.fetchedAt = 0;
  try {
    const [matches] = await Promise.all([getMatches(), getGoalData(true)]);
    res.json({
      ok: true,
      matches: matches.length,
      fetchedAt: cache.fetchedAt,
      goalsFetchedAt: goalCache.fetchedAt,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚽ World Cup Fantasy 2026 running at http://localhost:${PORT}`);
});
