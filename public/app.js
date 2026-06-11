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

  try {
    const data = await fetchJSON('/api/leaderboard');
    renderLeaderboard(data.board);
    startCountdown(data.fetchedAt, data.nextRefresh);
    scheduleAutoRefresh(data.nextRefresh);
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
function startCountdown(fetchedAt, nextRefresh) {
  const el = document.getElementById('refresh-info');
  const render = () => {
    const remaining = Math.max(0, nextRefresh - Date.now());
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    const updated = fetchedAt ? `Updated ${new Date(fetchedAt).toLocaleTimeString()}` : '';
    const next = remaining > 0
      ? `next refresh in ${mins > 0 ? `${mins}m ` : ''}${secs}s`
      : 'refreshing…';
    el.textContent = updated ? `${updated} · ${next}` : next;
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
    const groupInfo = t.groupWins > 0
      ? `<span class="team-group-wins">${t.groupWins} group win${t.groupWins !== 1 ? 's' : ''}</span>`
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
          ? `${p.pts} pt${p.pts !== 1 ? 's' : ''} <span class="player-goals">(${p.goals}⚽)</span>`
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
