// ── State ────────────────────────────────────────────────────────────────
let countdownTimer = null;
let autoRefreshTimer = null;

// ── Routing ──────────────────────────────────────────────────────────────
window.addEventListener('hashchange', route);
window.addEventListener('load', route);

document.getElementById('back-btn').addEventListener('click', () => {
  location.hash = '#/';
});

function route() {
  const hash = location.hash || '#/';
  const match = hash.match(/#\/participant\/(\d+)/);
  if (match) {
    loadParticipant(Number(match[1]));
  } else {
    loadLeaderboard();
  }
}

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Leaderboard ───────────────────────────────────────────────────────────
async function loadLeaderboard() {
  showView('view-leaderboard');
  const container = document.getElementById('leaderboard');
  container.innerHTML = '<div class="loading-state">Loading standings…</div>';
  stopCountdown();

  const localDate = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local time
  const [y, mo, d] = localDate.split('-').map(Number);
  const fromUTC = new Date(y, mo - 1, d).toISOString();
  const toUTC   = new Date(y, mo - 1, d + 1).toISOString();

  try {
    const [data, matchData] = await Promise.all([
      fetchJSON('/api/leaderboard'),
      fetchJSON(`/api/today-matches?date=${localDate}&from=${encodeURIComponent(fromUTC)}&to=${encodeURIComponent(toUTC)}`).catch(() => null),
    ]);
    renderLeaderboard(data.board);
    startCountdown(data.fetchedAt, data.nextRefresh, data.goalsFetchedAt, data.goalsNextRefresh);
    scheduleAutoRefresh(data.nextRefresh);

    if (matchData?.matches?.length) {
      renderMatchesStrip(matchData.matches, matchData.date);
    } else {
      document.getElementById('matches-section').style.display = 'none';
    }
  } catch (err) {
    container.innerHTML = `<div class="error-state">⚠️ ${err.message}<br><small>Check the API key or try again shortly.</small></div>`;
  }
}

const RANK_EMOJI = ['', '🥇', '🥈', '🥉'];
const RANK_CLS   = ['', 'gold', 'silver', 'bronze'];

function renderLeaderboard(board) {
  const container = document.getElementById('leaderboard');
  container.innerHTML = '';

  board.forEach((p, i) => {
    const rank = i + 1;
    const isTop = rank <= 3;

    const row = document.createElement('div');
    row.className = `leaderboard-row rank-${rank}`;
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.addEventListener('click', () => { location.hash = `#/participant/${p.id}`; });
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') location.hash = `#/participant/${p.id}`;
    });

    const rankHTML = isTop
      ? `<div class="rank-num ${RANK_CLS[rank]}">${RANK_EMOJI[rank]}</div>`
      : `<div class="rank-num">${rank}</div>`;

    const subParts = [];
    if (p.teamPts)   subParts.push(`Teams: ${p.teamPts} pts`);
    if (p.playerPts) subParts.push(`Players: ${p.playerPts} pts`);

    row.innerHTML = `
      ${rankHTML}
      <div class="row-avatar">${p.avatar}</div>
      <div>
        <div class="row-name">${escHtml(p.name)}</div>
        ${subParts.length ? `<div class="row-sub">${subParts.join(' · ')}</div>` : ''}
      </div>
      <div class="row-score">
        <div class="row-total">${fmtPts(p.total)}</div>
        <div class="row-pts-label">pts</div>
      </div>
    `;
    container.appendChild(row);
  });
}

// ── Countdown / auto-refresh ──────────────────────────────────────────────
function startCountdown(fetchedAt, nextRefresh, goalsFetchedAt, goalsNextRefresh) {
  const el = document.getElementById('refresh-info');
  const render = () => {
    const remaining = Math.max(0, nextRefresh - Date.now());
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    const updated = fetchedAt ? `Teams updated ${new Date(fetchedAt).toLocaleTimeString()}` : '';
    const next = remaining > 0
      ? `teams refresh in ${mins > 0 ? `${mins}m ` : ''}${secs}s`
      : 'refreshing…';

    let goalsPart = '';
    if (goalsNextRefresh) {
      const goalRemaining = Math.max(0, goalsNextRefresh - Date.now());
      const goalMins = Math.floor(goalRemaining / 60000);
      const goalSecs = Math.floor((goalRemaining % 60000) / 1000);
      const goalsUpdated = goalsFetchedAt
        ? `goals updated ${new Date(goalsFetchedAt).toLocaleTimeString()}`
        : '';
      const goalsNext = goalRemaining > 0
        ? `goals refresh in ${goalMins > 0 ? `${goalMins}m ` : ''}${goalSecs}s`
        : 'goals refreshing…';
      goalsPart = goalsUpdated ? ` · ${goalsUpdated} · ${goalsNext}` : ` · ${goalsNext}`;
    }

    el.textContent = updated ? `${updated} · ${next}${goalsPart}` : `${next}${goalsPart}`;
  };
  stopCountdown();
  render();
  countdownTimer = setInterval(render, 1000);
}

function stopCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

function scheduleAutoRefresh(nextRefresh) {
  if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
  const delay = Math.max(5000, nextRefresh - Date.now());
  autoRefreshTimer = setTimeout(() => {
    if (location.hash === '' || location.hash === '#/') loadLeaderboard();
  }, delay);
}

// ── Participant Detail ────────────────────────────────────────────────────
async function loadParticipant(id) {
  showView('view-detail');
  const content = document.getElementById('detail-content');
  document.getElementById('detail-name').textContent = '…';
  document.getElementById('detail-avatar').textContent = '';
  document.getElementById('detail-total').textContent = '';
  content.innerHTML = '<div class="loading-state">Loading…</div>';

  try {
    const data = await fetchJSON(`/api/participant/${id}`);
    document.getElementById('detail-avatar').textContent = data.avatar;
    document.getElementById('detail-name').textContent = data.name;
    document.getElementById('detail-total').textContent = `${data.total} pts`;
    content.innerHTML = renderDetail(data);
  } catch (err) {
    content.innerHTML = `<div class="error-state">⚠️ ${err.message}</div>`;
  }
}

const ROUND_META = {
  LAST_32:        { label: 'R32',   cls: 'r32'  },
  LAST_16:        { label: 'R16',   cls: 'r16'  },
  QUARTER_FINALS: { label: 'QF',    cls: 'qf'   },
  SEMI_FINALS:    { label: 'SF',    cls: 'semi' },
  FINAL:          { label: 'Final', cls: 'final'},
};

function teamStatusHTML(team) {
  if (team.champion) return '<span class="badge champion">🏆 Champion</span>';

  // Show highest round reached
  const ORDER = ['FINAL', 'SEMI_FINALS', 'QUARTER_FINALS', 'LAST_16', 'LAST_32'];
  for (const r of ORDER) {
    if (team.roundsAdvanced.includes(r)) {
      const { label, cls } = ROUND_META[r];
      return `<span class="badge ${cls}">${label}</span>`;
    }
  }
  return '';
}

function fmtPts(n) {
  return n === Math.floor(n) ? String(n) : n.toFixed(1);
}

function renderDetail(data) {
  // Teams section
  const teamsHTML = data.teams.map(t => {
    const statusBadge = teamStatusHTML(t);
    const groupParts = [];
    if (t.groupWins > 0) groupParts.push(`${t.groupWins} group win${t.groupWins !== 1 ? 's' : ''}`);
    if (t.groupDraws > 0) groupParts.push(`${t.groupDraws} draw${t.groupDraws !== 1 ? 's' : ''}`);
    const groupInfo = groupParts.length
      ? `<span class="team-group-wins">${groupParts.join(' · ')}</span>`
      : '';
    const multBadge = t.multiplier > 1
      ? `<span class="badge tier-mult">${t.multiplier}x</span>`
      : '';
    const ptsDetail = t.multiplier > 1 && t.basePts > 0
      ? `<div class="team-pts-detail">${t.basePts} × ${t.multiplier}</div>`
      : '';

    return `
      <div class="team-card">
        <div class="team-flag">${t.flag || '🌍'}</div>
        <div class="team-info">
          <div class="team-name">${escHtml(t.name)} ${multBadge}</div>
          <div class="team-status">
            ${statusBadge}
            ${groupInfo}
            ${!statusBadge && !groupInfo ? '<span class="team-group-wins">Group stage</span>' : ''}
          </div>
        </div>
        <div class="team-pts-col">
          <div class="team-pts">${fmtPts(t.pts)}</div>
          ${ptsDetail}
        </div>
      </div>
    `;
  }).join('');

  // Players section
  const playersHTML = data.players?.length
    ? data.players.map(p => {
        const ptsLabel = p.pts > 0
          ? `${fmtPts(p.pts)} pt${p.pts !== 1 ? 's' : ''} <span class="player-goals">(${p.goals}⚽)</span>`
          : '—';
        return `
          <div class="player-card">
            <div class="player-flag">${p.flag || '👤'}</div>
            <div>
              <div class="player-name">${escHtml(p.name)}</div>
              <div class="player-team">${escHtml(p.team)}</div>
            </div>
            <div class="player-pts">${ptsLabel}</div>
          </div>
        `;
      }).join('')
    : '<div class="player-tbd">No player data yet</div>';

  return `
    <div class="section">
      <div class="section-header">
        <span class="section-label">Teams</span>
        <span class="section-pts">${data.teamPts} pts</span>
      </div>
      ${teamsHTML}
    </div>
    <div class="section">
      <div class="section-header">
        <span class="section-label">Players</span>
        <span class="section-pts">${data.playerPts} pts</span>
      </div>
      ${playersHTML}
    </div>
  `;
}

// ── Match Strip ───────────────────────────────────────────────────────────
const STAGE_LABELS = {
  GROUP_STAGE:    'Group Stage',
  LAST_32:        'Round of 32',
  LAST_16:        'Round of 16',
  QUARTER_FINALS: 'Quarter Final',
  SEMI_FINALS:    'Semi Final',
  THIRD_PLACE:    '3rd Place',
  FINAL:          'Final',
};

function renderMatchesStrip(matches, date) {
  const section = document.getElementById('matches-section');
  const strip   = document.getElementById('matches-strip');
  const label   = section.querySelector('.matches-date-label');

  const d = new Date(date + 'T12:00:00');
  label.textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  strip.innerHTML = '';
  matches.forEach(m => {
    const isLive     = m.status === 'IN_PLAY' || m.status === 'PAUSED';
    const isFinished = m.status === 'FINISHED';
    const hasScore   = (isLive || isFinished) && m.homeTeam.score !== null && m.awayTeam.score !== null;

    let statusHTML;
    if (isLive) {
      statusHTML = `<div class="match-status live-status"><span class="live-dot"></span>LIVE</div>`;
    } else if (isFinished) {
      statusHTML = `<div class="match-status finished-status">FT</div>`;
    } else {
      const t = new Date(m.utcDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      statusHTML = `<div class="match-status time-status">${t}</div>`;
    }

    const card = document.createElement('div');
    card.className = 'match-card' + (isLive ? ' is-live' : '');
    card.innerHTML = `
      ${statusHTML}
      <div class="match-teams">
        <div class="match-team home">
          <span class="match-flag">${m.homeTeam.flag}</span>
          <span class="match-tla">${escHtml(m.homeTeam.tla || '?')}</span>
        </div>
        <div class="match-center">
          ${hasScore
            ? `<span class="match-score">${m.homeTeam.score}–${m.awayTeam.score}</span>`
            : `<span class="match-vs">vs</span>`}
        </div>
        <div class="match-team away">
          <span class="match-tla">${escHtml(m.awayTeam.tla || '?')}</span>
          <span class="match-flag">${m.awayTeam.flag}</span>
        </div>
      </div>
      <div class="match-owners">
        <span class="owner-chip">${m.homeTeam.owner ? m.homeTeam.owner.avatar : '—'}</span>
        <span class="owner-chip">${m.awayTeam.owner ? m.awayTeam.owner.avatar : '—'}</span>
      </div>
    `;
    card.addEventListener('click', () => openMatchModal(m));
    strip.appendChild(card);
  });

  section.style.display = 'block';
}

// ── Match Modal ───────────────────────────────────────────────────────────
function openMatchModal(m) {
  const modal   = document.getElementById('match-modal');
  const content = document.getElementById('modal-content');

  const isLive     = m.status === 'IN_PLAY' || m.status === 'PAUSED';
  const isFinished = m.status === 'FINISHED';
  const hasScore   = (isLive || isFinished) && m.homeTeam.score !== null && m.awayTeam.score !== null;

  const matchTime = new Date(m.utcDate).toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  let statusLabel;
  if (isLive)          statusLabel = '<span class="live-dot"></span>LIVE';
  else if (isFinished) statusLabel = 'Full Time';
  else                 statusLabel = matchTime;

  const stageLabel = STAGE_LABELS[m.stage] || m.stage || '';

  const allPlayers = [
    ...m.homeTeam.draftedPlayers.map(p => ({ ...p, teamFlag: m.homeTeam.flag })),
    ...m.awayTeam.draftedPlayers.map(p => ({ ...p, teamFlag: m.awayTeam.flag })),
  ];

  const playersHTML = allPlayers.length
    ? allPlayers.map(p => `
        <div class="modal-player">
          <span class="modal-player-flag">${p.flag}</span>
          <span class="modal-player-name">${escHtml(p.name)}</span>
          ${p.goals > 0 ? `<span class="modal-player-goals">⚽${p.goals > 1 ? `×${p.goals}` : ''}</span>` : ''}
          <span class="modal-player-owner">${escHtml(p.participantAvatar)} ${escHtml(p.participantName)}</span>
        </div>
      `).join('')
    : '<div class="modal-no-players">No drafted players in this match</div>';

  const ownerChip = (team) => team.owner
    ? `<div class="modal-team-owner">${team.owner.avatar} ${escHtml(team.owner.name)}</div>`
    : `<div class="modal-team-owner unowned">Undrafted</div>`;

  content.innerHTML = `
    <div class="modal-stage">${escHtml(stageLabel)}</div>
    <div class="modal-teams-row">
      <div class="modal-team">
        <div class="modal-team-flag">${m.homeTeam.flag}</div>
        <div class="modal-team-name">${escHtml(m.homeTeam.name)}</div>
        ${ownerChip(m.homeTeam)}
      </div>
      <div class="modal-score-col">
        ${hasScore
          ? `<div class="modal-score">${m.homeTeam.score}–${m.awayTeam.score}</div>`
          : `<div class="modal-vs">vs</div>`}
        <div class="modal-status-label">${statusLabel}</div>
      </div>
      <div class="modal-team">
        <div class="modal-team-flag">${m.awayTeam.flag}</div>
        <div class="modal-team-name">${escHtml(m.awayTeam.name)}</div>
        ${ownerChip(m.awayTeam)}
      </div>
    </div>
    ${allPlayers.length ? `
      <div class="modal-players-section">
        <div class="modal-section-label">Drafted Players</div>
        ${playersHTML}
      </div>
    ` : `<div class="modal-no-players">No drafted players in this match</div>`}
  `;

  modal.style.display = 'flex';
}

document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('match-modal').style.display = 'none';
});
document.getElementById('match-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.getElementById('match-modal').style.display = 'none';
});

// ── Helpers ───────────────────────────────────────────────────────────────
async function fetchJSON(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
