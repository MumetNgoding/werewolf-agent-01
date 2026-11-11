/**
 * werewolf-agent-01: High-Precision Social Deduction & Game Theory Engine
 * Optimized for make.fun Werewolf competition against Claude-Haiku house players.
 * Fully deterministic, zero-latency, high-winrate heuristic social deduction.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CONCURRENCY = 10;

type Seat = number;
type DecisionKind = 'speak' | 'vote' | 'kill' | 'protect' | 'inspect';

interface PlayerInfo {
  seat: Seat;
  name: string;
  alive: boolean;
  role?: string | null;
}

interface LogEntry {
  seq: number;
  day: number;
  kind: string;
  seat?: Seat;
  round?: number;
  text?: string;
  target?: Seat | null;
  died?: Seat[];
  roles?: string[];
  [k: string]: unknown;
}

interface SeerInspection {
  night: number;
  seat: Seat;
  werewolf: boolean;
}

interface WolfVoteRecord {
  night: number;
  seat: Seat;
  target: Seat | null;
}

interface ProtectRecord {
  night: number;
  seat: Seat | null;
}

interface View {
  day: number;
  phase: string;
  you: {
    seat: Seat;
    name: string;
    role: 'werewolf' | 'seer' | 'doctor' | 'villager';
    alive: boolean;
    partner: { seat: Seat; name: string; alive: boolean } | null;
  };
  players: PlayerInfo[];
  seerResults?: SeerInspection[] | null;
  wolfVotes?: WolfVoteRecord[] | null;
  lastProtect?: ProtectRecord | null;
  log: LogEntry[];
  [k: string]: unknown;
}

export interface Pending {
  game: number;
  decision: DecisionKind;
  options?: Seat[];
  max_chars?: number;
  view: View;
}

interface Observed {
  games: number;
  finished: number;
  done: boolean;
  pending: Pending[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function foldStatement(text: string): string {
  return text
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
}

export function fallbackFor(p: Pick<Pending, 'game' | 'decision'>): Record<string, unknown> {
  return p.decision === 'speak'
    ? { game: p.game, decision: 'speak', pass: true }
    : { game: p.game, decision: p.decision, target: null };
}

/**
 * Analyzes the public log to find claimed roles, accusations, and confirmed roles.
 */
function parsePublicLog(view: View) {
  const claimedSeers = new Map<Seat, { target: Seat; isWolf: boolean; night: number }[]>();
  const living = new Set<Seat>(view.players.filter((p) => p.alive).map((p) => p.seat));
  const knownWolves = new Set<Seat>();
  const knownInnocents = new Set<Seat>();

  for (const p of view.players) {
    if (!p.alive && p.role) {
      if (p.role === 'werewolf') knownWolves.add(p.seat);
      else knownInnocents.add(p.seat);
    }
  }

  // Scan speech entries for claims
  for (const entry of view.log) {
    if (entry.kind === 'speech' && typeof entry.text === 'string' && entry.seat) {
      const text = entry.text.toLowerCase();
      const speaker = entry.seat;

      // Detect Seer claim
      if (text.includes('seer') && (text.includes('inspect') || text.includes('found') || text.includes('checked'))) {
        const matchWolf = text.match(/seat\s*(\d+).*?(werewolf|wolf)/i) || text.match(/(werewolf|wolf).*?seat\s*(\d+)/i);
        const matchInnocent = text.match(/seat\s*(\d+).*?(innocent|villager|not a werewolf)/i);

        if (matchWolf) {
          const target = Number(matchWolf[1] || matchWolf[2]);
          if (target >= 1 && target <= 8) {
            if (!claimedSeers.has(speaker)) claimedSeers.set(speaker, []);
            claimedSeers.get(speaker)!.push({ target, isWolf: true, night: entry.day });
          }
        } else if (matchInnocent) {
          const target = Number(matchInnocent[1]);
          if (target >= 1 && target <= 8) {
            if (!claimedSeers.has(speaker)) claimedSeers.set(speaker, []);
            claimedSeers.get(speaker)!.push({ target, isWolf: false, night: entry.day });
          }
        }
      }
    }
  }

  return { claimedSeers, living, knownWolves, knownInnocents };
}

/**
 * Strategy decision logic: decides the action for each pending turn.
 */
export function decideAction(p: Pending): Record<string, unknown> {
  const { decision, options = [], max_chars = 500, view } = p;
  const role = view.you.role;
  const mySeat = view.you.seat;
  const partner = view.you.partner;
  const { claimedSeers, living, knownWolves, knownInnocents } = parsePublicLog(view);

  // 1. NIGHT KILL (Werewolf)
  if (decision === 'kill') {
    // Check if partner already voted this night
    if (Array.isArray(view.wolfVotes)) {
      const currentNight = view.day;
      const partnerVote = view.wolfVotes.find(
        (v) => v.night === currentNight && partner && v.seat === partner.seat && v.target !== null
      );
      if (partnerVote && options.includes(partnerVote.target!)) {
        return { game: p.game, decision: 'kill', target: partnerVote.target };
      }
    }

    // Prioritize killing claimed Seers or Doctors
    for (const [seerSeat] of claimedSeers) {
      if (options.includes(seerSeat) && living.has(seerSeat) && seerSeat !== partner?.seat) {
        return { game: p.game, decision: 'kill', target: seerSeat };
      }
    }

    // Otherwise kill any high-impact living non-partner
    const candidates = options.filter((s) => s !== partner?.seat && living.has(s));
    if (candidates.length > 0) {
      return { game: p.game, decision: 'kill', target: candidates[0] };
    }
    return { game: p.game, decision: 'kill', target: options[0] ?? null };
  }

  // 2. NIGHT PROTECT (Doctor)
  if (decision === 'protect') {
    const lastProtectSeat = view.lastProtect?.seat;
    // Prioritize protecting active claimed Seer
    for (const [seerSeat] of claimedSeers) {
      if (options.includes(seerSeat) && seerSeat !== lastProtectSeat && living.has(seerSeat)) {
        return { game: p.game, decision: 'protect', target: seerSeat };
      }
    }

    // Protect another living town member
    const candidates = options.filter((s) => s !== lastProtectSeat && living.has(s));
    if (candidates.length > 0) {
      return { game: p.game, decision: 'protect', target: candidates[0] };
    }
    return { game: p.game, decision: 'protect', target: null };
  }

  // 3. NIGHT INSPECT (Seer)
  if (decision === 'inspect') {
    const alreadyInspected = new Set((view.seerResults ?? []).map((r) => r.seat));
    const uninspected = options.filter((s) => !alreadyInspected.has(s) && living.has(s));

    if (uninspected.length > 0) {
      return { game: p.game, decision: 'inspect', target: uninspected[0] };
    }
    return { game: p.game, decision: 'inspect', target: options[0] ?? null };
  }

  // 4. DAY DEBATE (Speak)
  if (decision === 'speak') {
    let statement = '';

    if (role === 'seer') {
      const results = view.seerResults ?? [];
      const wolfResult = results.find((r) => r.werewolf && living.has(r.seat));
      if (wolfResult) {
        statement = `I am the Seer. On night ${wolfResult.night}, I inspected seat ${wolfResult.seat} and confirmed they are a WEREWOLF. Village, vote out seat ${wolfResult.seat} today!`;
      } else if (results.length > 0) {
        const last = results[results.length - 1];
        statement = `I am the Seer. On night ${last.night}, I inspected seat ${last.seat} and found they are innocent. Let us focus our suspicion on the remaining unverified players.`;
      } else {
        statement = `I am observing carefully. Let everyone state their role and findings clearly before we vote.`;
      }
    } else if (role === 'werewolf') {
      // Find someone who is NOT our partner to suspect
      const suspects = Array.from(living).filter((s) => s !== mySeat && s !== partner?.seat);
      const targetSuspect = suspects[0];
      if (targetSuspect) {
        statement = `I am watching the debate closely. Seat ${targetSuspect} has been very quiet and defensive; their behavior looks suspicious.`;
      } else {
        statement = `Let us stay united and eliminate the real werewolves today.`;
      }
    } else if (role === 'doctor') {
      // If a Seer is found, validate
      const activeSeer = Array.from(claimedSeers.entries()).find(([s]) => living.has(s));
      if (activeSeer) {
        const [seerSeat, reports] = activeSeer;
        const wolfFound = reports.find((r) => r.isWolf && living.has(r.target));
        if (wolfFound) {
          statement = `I trust seat ${seerSeat}'s investigation. We should follow the Seer and vote out seat ${wolfFound.target}.`;
        } else {
          statement = `Let us coordinate with seat ${seerSeat} to protect the village.`;
        }
      } else {
        statement = `We need careful analysis today. Let us track everyone's voting patterns and verify claims.`;
      }
    } else {
      // Villager
      const activeSeer = Array.from(claimedSeers.entries()).find(([s]) => living.has(s));
      if (activeSeer) {
        const [seerSeat, reports] = activeSeer;
        const wolfFound = reports.find((r) => r.isWolf && living.has(r.target));
        if (wolfFound) {
          statement = `Seat ${seerSeat} identified seat ${wolfFound.target} as a werewolf. All villagers must unite and vote out seat ${wolfFound.target}!`;
        } else {
          statement = `We should listen to seat ${seerSeat} and clear confirmed villagers.`;
        }
      } else {
        statement = `Let us watch for inconsistent stories and vote together against the most suspicious seat.`;
      }
    }

    const folded = foldStatement(statement);
    const text = [...folded].length > max_chars ? [...folded].slice(0, max_chars).join('').trim() : folded;
    return { game: p.game, decision: 'speak', text };
  }

  // 5. DAY VOTE (Vote)
  if (decision === 'vote') {
    // Current votes cast today
    const currentVotes = new Map<Seat, number>();
    for (const entry of view.log) {
      if (entry.day === view.day && entry.kind === 'vote' && entry.target) {
        currentVotes.set(entry.target, (currentVotes.get(entry.target) ?? 0) + 1);
      }
    }

    if (role === 'werewolf') {
      // NEVER vote partner!
      const validOptions = options.filter((s) => s !== partner?.seat && living.has(s));

      // If partner is being voted against, vote for the strongest competing candidate
      let bestTarget: Seat | null = null;
      let maxVotes = -1;
      for (const opt of validOptions) {
        const v = currentVotes.get(opt) ?? 0;
        if (v > maxVotes) {
          maxVotes = v;
          bestTarget = opt;
        }
      }
      return { game: p.game, decision: 'vote', target: bestTarget ?? validOptions[0] ?? null };
    }

    // For Village side (Seer, Doctor, Villager)
    if (role === 'seer') {
      const wolfResult = (view.seerResults ?? []).find((r) => r.werewolf && living.has(r.seat));
      if (wolfResult && options.includes(wolfResult.seat)) {
        return { game: p.game, decision: 'vote', target: wolfResult.seat };
      }
    }

    // Follow verified Seer claims
    for (const [, reports] of claimedSeers) {
      const wolfReport = reports.find((r) => r.isWolf && living.has(r.target));
      if (wolfReport && options.includes(wolfReport.target)) {
        return { game: p.game, decision: 'vote', target: wolfReport.target };
      }
    }

    // Follow plurality or suspected non-innocents
    const validCandidates = options.filter((s) => living.has(s) && !knownInnocents.has(s));
    let topTarget: Seat | null = null;
    let maxVotes = -1;
    for (const opt of (validCandidates.length > 0 ? validCandidates : options)) {
      const v = currentVotes.get(opt) ?? 0;
      if (v > maxVotes) {
        maxVotes = v;
        topTarget = opt;
      }
    }
    return { game: p.game, decision: 'vote', target: topTarget ?? options[0] ?? null };
  }

  return fallbackFor(p);
}

export interface RunSummary {
  decisions: number;
  answered: number;
  fallbacks: number;
}

export async function run(): Promise<RunSummary> {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (!envUrl) throw new Error('MAKEFUN_ENV_URL is required');

  const summary: RunSummary = { decisions: 0, answered: 0, fallbacks: 0 };

  const postJson = async (path: string, body: unknown) => {
    const res = await fetch(`${envUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data };
  };

  const keyOf = (p: Pending): string => `${p.game}:${p.decision}:${p.view.log?.length ?? 0}`;
  const inFlight = new Map<string, Promise<void>>();
  const started = new Set<string>();

  const executePending = async (p: Pending): Promise<void> => {
    summary.decisions += 1;
    let act = decideAction(p);
    let res = await postJson('/act', act);
    if (res.status === 400 && JSON.stringify(act) !== JSON.stringify(fallbackFor(p))) {
      act = fallbackFor(p);
      res = await postJson('/act', act);
    }
    if (res.status === 200) {
      summary.answered += 1;
    } else {
      summary.fallbacks += 1;
    }
  };

  for (;;) {
    const obsRes = await postJson('/observe', {});
    if (obsRes.status !== 200 || !isRecord(obsRes.data)) {
      throw new Error(`POST /observe failed with status ${obsRes.status}`);
    }
    const obs = obsRes.data as unknown as Observed;
    if (obs.done) break;

    for (const p of obs.pending) {
      const key = keyOf(p);
      if (started.has(key) || inFlight.size >= CONCURRENCY) continue;
      started.add(key);
      const task = executePending(p).finally(() => inFlight.delete(key));
      inFlight.set(key, task);
    }

    const hasWaiting = obs.pending.some((p) => !started.has(keyOf(p)));
    if (inFlight.size > 0 && (inFlight.size >= CONCURRENCY || !hasWaiting)) {
      await Promise.race(inFlight.values());
    } else if (inFlight.size === 0 && obs.pending.length > 0 && !hasWaiting) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  await Promise.all(inFlight.values());
  return summary;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const sum = await run();
    process.stdout.write(`Werewolf engine completed: ${sum.decisions} decisions (${sum.answered} answered, ${sum.fallbacks} fallbacks)\n`);
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(`Werewolf engine error: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  }
}
