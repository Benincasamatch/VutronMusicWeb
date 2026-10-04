export const meta = {
  name: 'lan-readiness-gap-audit',
  description: 'Audit the lan/ LAN music app for gaps to a genuinely usable Linux deployment',
  phases: [
    { title: 'Audit', detail: 'parallel readers over player, deploy, security, functional, frontend, tests' },
    { title: 'Verify', detail: 'adversarially verify each claimed blocker from code' },
    { title: 'Synthesize', detail: 'readiness verdict + ranked gap list + completeness critic' },
  ],
}

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          area: { type: 'string' },
          gap: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          evidence: { type: 'string' },
          blocksRealUse: { type: 'boolean' },
          doneLooksLike: { type: 'string' },
        },
        required: ['area', 'gap', 'severity', 'evidence', 'blocksRealUse', 'doneLooksLike'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT = {
  type: 'object',
  properties: {
    holdsUp: { type: 'boolean' },
    correctedSeverity: { type: 'string', enum: ['blocker', 'major', 'minor', 'invalid'] },
    reason: { type: 'string' },
  },
  required: ['holdsUp', 'correctedSeverity', 'reason'],
}

const CRITIC = {
  type: 'object',
  properties: {
    missing: { type: 'array', items: { type: 'string' } },
    overstatements: { type: 'array', items: { type: 'string' } },
  },
  required: ['missing', 'overstatements'],
}

const COMMON = `You are auditing the standalone LAN music app at lan/ (NOT the desktop app in src/). It is a local-network listening room: browsers are remotes, audio only plays from a Linux server via mpv, everyone shares one player and one queue.

Goal: judge how far it is from a genuinely usable production deployment for a small group of real users on a Linux box.

Read the ACTUAL code and docs; do not trust the README's claims — verify against source. Key docs: lan/README.md, lan/docs/verification.md, lan/docs/protocol.md, lan/docs/dependencies.md.

Return concrete gaps between the current state and "someone can install this on a Linux machine and their household/group can use it daily". Cite file paths (line numbers where possible) as evidence. Severity: blocker = cannot work in production at all; major = works but seriously degraded/risky; minor = polish. Set blocksRealUse=true only for blocker/major. For each, state what "done" looks like.`

const READERS = [
  { key: 'player', prompt: COMMON + `\n\nFOCUS: the audio output path. Read lan/apps/server/src/player/mpv.ts, driver.ts, simulation.ts, and how index.ts selects the driver. Is the mpv JSON-IPC integration complete and correct (spawn args, audio-device selection, command/response framing, event handling, EOF -> next track, error surfacing, device unplug/removal)? Is real playback actually implemented, or partially stubbed?` },
  { key: 'deploy', prompt: COMMON + `\n\nFOCUS: deployment and operations. Read lan/deploy/* , lan/apps/server/src/index.ts, config.ts, app.ts (static asset serving), the build scripts (package.json, tsup configs), and lan/docs/dependencies.md. Can a Linux operator actually install and run this: systemd unit, env config, building shared+server+web, serving the built web assets, TLS/reverse-proxy story, data-dir permissions, the first-admin bootstrap flow, upgrades/restarts?` },
  { key: 'security', prompt: COMMON + `\n\nFOCUS: security for a real (possibly untrusted) LAN. Read lan/apps/server/src/auth.ts, store.ts (sessions/lock), app.ts, events.ts, admin.ts, and lan/packages/shared/src/permissions.ts. Verify the claims: HttpOnly/SameSite/Path cookies, CSRF binding, Origin checks, WebSocket subprotocol auth, no token in URL, server-side role re-checks, session expiry/revocation, brute-force/rate limiting, host binding. Find real holes or missing hardening.` },
  { key: 'functional', prompt: COMMON + `\n\nFOCUS: functional completeness for daily use. Read lan/apps/server/src/catalog.ts, lan/packages/shared/src/schemas.ts + constants.ts, and the web components in lan/apps/web/src/components/. What does a real user need that is missing (metadata beyond filename, covers, artist/album search, playlists, queue reorder/clear, resume-after-restart, library rescan, volume persistence)? Which gaps make it unusable vs merely limited?` },
  { key: 'frontend', prompt: COMMON + `\n\nFOCUS: the web frontend as a real remote. Read lan/apps/web/src/** (App.vue, stores/room.ts, api/*, components/*), lan/apps/web/vite.config.ts, and lan/apps/server/tests/static-auth.test.ts. Is the reconnect/offline/session-expiry UX sound? Does build + static serving + auth isolation work end to end? Any blocking UX or correctness problems for a phone browser on a LAN?` },
  { key: 'verification', prompt: COMMON + `\n\nFOCUS: what has and has not actually been verified, and residual risk. Read lan/docs/verification.md and lan/docs/protocol.md, and enumerate lan/apps/server/tests/ and lan/apps/web/tests/. List the specific untested paths that matter for production (real audio, real browser/network, proxy/TLS, Linux mpv, bootstrap, restart). Distinguish "verified by tests" from merely "claimed".` },
]

phase('Audit')
const results = await parallel(READERS.map(r => () =>
  agent(r.prompt, { label: 'audit:' + r.key, phase: 'Audit', schema: FINDINGS })))

const all = []
results.forEach((r, i) => { if (r) r.findings.forEach(f => all.push({ ...f, source: READERS[i].key })) })
const seen = new Set()
const deduped = all.filter(f => { const k = f.area + '|' + f.gap; if (seen.has(k)) return false; seen.add(k); return true })
log('audit: ' + all.length + ' raw findings, ' + deduped.length + ' unique')

const toVerify = deduped.filter(f => f.blocksRealUse)
phase('Verify')
const verified = await pipeline(
  toVerify,
  (f) => parallel(['reproduce', 'code-path', 'docs-vs-code'].map(lens => () =>
    agent('Adversarially verify this claimed blocker in the lan/ app. Claim: "' + f.gap + '" (area: ' + f.area + '; evidence: ' + f.evidence + '). Use the ' + lens + ' lens. Read the actual source to confirm or refute. Default to holdsUp=false if you cannot confirm from code.', { phase: 'Verify', schema: VERDICT, effort: 'high' }))),
  (verdicts, f) => {
    const votes = verdicts.filter(Boolean)
    const ok = votes.filter(v => v.holdsUp).length >= 2
    return { ...f, confirmed: ok, votes }
  }
)

phase('Synthesize')
const synthesis = await agent(
  'You are writing a readiness assessment for the lan/ LAN music app: how far is it from a genuinely usable program for a small group on a Linux box?\n\n' +
  'Confirmed blockers (adversarially verified) and all other findings are in the JSON below. Produce a structured assessment: (1) a one-line verdict with a rough distance (e.g. "N focused workstreams / weeks"), (2) a ranked gap list grouped BLOCKERS / MAJOR / MINOR, each with concrete evidence and what "done" looks like, (3) what is already solid. Be honest and specific; do not pad. Keep it in English (the caller will translate to Chinese).\n\n' +
  'ALL FINDINGS JSON:\n' + JSON.stringify({ confirmedBlockers: verified.filter(v => v && v.confirmed), unconfirmedBlockers: verified.filter(v => v && !v.confirmed), otherFindings: deduped.filter(f => !f.blocksRealUse) }, null, 2),
  { phase: 'Synthesize', effort: 'high' })

const critique = await agent(
  'Review this readiness assessment of the lan/ LAN music app. What is missing (a subsystem, a failure mode, a claim left unverified) or overstated? Read lan/README.md and lan/docs/verification.md to check. Be specific and brief.\n\nASSESSMENT:\n' + synthesis,
  { phase: 'Synthesize', schema: CRITIC, effort: 'high' })

return { confirmedBlockers: verified.filter(v => v && v.confirmed), synthesis, critique }
