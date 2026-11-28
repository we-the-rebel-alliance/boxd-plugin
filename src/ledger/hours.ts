/**
 * The machine-hours a work's record carries (design §C.4). The ledger counts the interval between two phase changes
 * into `MeteredHours`: the time a machine existed (every phase but `gone` and `closed`), the time it ran (the running
 * phases of `cost/rates.ts`), the time it was asleep, and the money the interval costs at the rates current when it is
 * counted, together with the part of it in the current local day. No boxd call and no owner's sign-in is needed.
 *
 * A read that shows the figure adds the interval from the record's last change to now, without writing: the next phase
 * change counts from that same last change, so no second is counted twice. When that read crosses local midnight, the
 * day that ended is kept as `lastDay`, so the watcher can append that day's cost event after the fact.
 */
import { isRunning, money, perHour } from "../cost/rates.js"
import type { Reading, Rates, Size } from "../ports.js"
import type { CostSeconds, MeteredDay, MeteredHours, Phase, WorkRecord } from "./types.js"

/** Phases in which the work's machine exists: every phase but gone and closed. */
const exists = (phase: Phase) => phase !== "gone" && phase !== "closed"

/** The rates and reading one interval is priced with. */
export interface Pricing {
  readonly rates: Rates
  readonly size?: Size
  readonly reading?: Reading
  /** A slot work's share of its shared machine, from 0 to 1; absent is a whole machine. */
  readonly share?: number
}

/** `YYYY-MM-DD` in this machine's local day. */
export function localDay(at: Date): string {
  const year = at.getFullYear()
  const month = String(at.getMonth() + 1).padStart(2, "0")
  const day = String(at.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/** The first instant of `at`'s local day. */
function startOfDay(at: Date): number {
  const local = new Date(at)
  local.setHours(0, 0, 0, 0)
  return local.getTime()
}

/** Hours for a number of seconds, to two decimals. */
export const asHours = (seconds: number) => Math.round((Math.max(seconds, 0) / 3600) * 100) / 100

/** The counters of a record with no phase change yet: zeros, with the day's rates when they are known. */
function zeroHours(phase: Phase, at: Date, pricing: Pricing | undefined): MeteredHours {
  return {
    existedSeconds: 0,
    runningSeconds: 0,
    asleepSeconds: 0,
    todayExistedSeconds: 0,
    todayRunningSeconds: 0,
    todayAsleepSeconds: 0,
    cost: 0,
    todayCost: 0,
    ...(pricing ? { currency: pricing.rates.currency, ratesSource: pricing.rates.source } : {}),
    day: localDay(at),
    phase,
    at: at.toISOString(),
  }
}

/** The seconds of `previous`'s current day, before an interval is added. */
function daySeconds(hours: MeteredHours): CostSeconds {
  return { existed: hours.todayExistedSeconds, running: hours.todayRunningSeconds, asleep: hours.todayAsleepSeconds ?? 0 }
}

/** The first instant of a `YYYY-MM-DD` local day. */
function startOf(day: string): number {
  const [year, month, date] = day.split("-").map(Number)
  return startOfDay(new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1))
}

/** The local day after a `YYYY-MM-DD` day. */
function nextDay(day: string): string {
  const next = new Date(startOf(day))
  next.setDate(next.getDate() + 1)
  return localDay(next)
}

/** Adds a number of seconds to one day's counters. */
function addSeconds(seconds: CostSeconds, phase: Phase, elapsed: number): CostSeconds {
  return {
    existed: seconds.existed + (exists(phase) ? elapsed : 0),
    running: seconds.running + (isRunning(phase) ? elapsed : 0),
    asleep: seconds.asleep + (phase === "asleep" ? elapsed : 0),
  }
}

/**
 * One record's counters, counted to `phase` at `at`: the elapsed interval goes to the phase that was current before.
 * With `pricing`, the interval is also priced at those rates into `cost` and `todayCost`; a currency change starts the
 * money counters again in the new currency. When the interval crosses local midnight, the day that ended becomes
 * `lastDay`, with the part of the interval before midnight added to it.
 */
export function countHours(previous: MeteredHours | undefined, phase: Phase, at: Date, pricing?: Pricing): MeteredHours {
  const now = at.getTime()
  const day = localDay(at)
  if (!previous) return zeroHours(phase, at, pricing)
  const last = Date.parse(previous.at)
  const start = Number.isNaN(last) ? now : Math.min(last, now)
  const elapsed = Math.max(0, now - start) / 1000
  // A gap that crosses local midnight counts only its part after midnight into today's counters; the cumulative
  // counters keep the whole interval.
  const midnight = startOfDay(at)
  const today = Math.max(0, now - Math.max(start, midnight)) / 1000
  const before = Math.max(0, Math.min(midnight, now) - start) / 1000
  const sameDay = previous.day === day
  const previousAsleep = previous.asleepSeconds ?? 0
  const previousTodayAsleep = previous.todayAsleepSeconds ?? 0
  const rates = pricing?.rates
  const hourRate = pricing && rates ? perHour(previous.phase, pricing.size ?? "2x8", pricing.reading, rates) * (pricing.share ?? 1) : undefined
  const sameCurrency = rates === undefined || previous.currency === undefined || previous.currency === rates.currency
  let lastDay = previous.lastDay
  if (!sameDay) {
    lastDay = {
      day: previous.day,
      seconds: addSeconds(daySeconds(previous), previous.phase, before),
      amount: money((sameCurrency ? (previous.todayCost ?? 0) : 0) + (hourRate ?? 0) * (before / 3600)),
      currency: rates?.currency ?? previous.currency ?? "EUR",
      ratesSource: rates?.source ?? previous.ratesSource ?? "public",
    }
  }
  const cost = hourRate === undefined ? (previous.cost ?? 0) : (sameCurrency ? (previous.cost ?? 0) : 0) + hourRate * (elapsed / 3600)
  const todayBase = sameDay && sameCurrency ? (previous.todayCost ?? 0) : 0
  const todayCost = hourRate === undefined ? (sameDay ? (previous.todayCost ?? 0) : 0) : todayBase + hourRate * ((sameDay ? elapsed : today) / 3600)
  return {
    existedSeconds: previous.existedSeconds + (exists(previous.phase) ? elapsed : 0),
    runningSeconds: previous.runningSeconds + (isRunning(previous.phase) ? elapsed : 0),
    asleepSeconds: previousAsleep + (previous.phase === "asleep" ? elapsed : 0),
    todayExistedSeconds: (sameDay ? previous.todayExistedSeconds : 0) + (exists(previous.phase) ? today : 0),
    todayRunningSeconds: (sameDay ? previous.todayRunningSeconds : 0) + (isRunning(previous.phase) ? today : 0),
    todayAsleepSeconds: (sameDay ? previousTodayAsleep : 0) + (previous.phase === "asleep" ? today : 0),
    cost: money(cost),
    todayCost: money(todayCost),
    ...(rates ? { currency: rates.currency, ratesSource: rates.source } : previous.currency ? { currency: previous.currency, ...(previous.ratesSource ? { ratesSource: previous.ratesSource } : {}) } : {}),
    ...(lastDay ? { lastDay } : {}),
    day,
    phase,
    at: at.toISOString(),
  }
}

/**
 * The local days before `at` that the record's last change covers, from its own day to yesterday, split at every local
 * midnight and priced. A work that stayed in one phase for days therefore still has one figure for each day. The
 * caller's once-only marker drops any day already reported.
 */
export function endedDays(hours: MeteredHours, at: Date, pricing: Pricing): MeteredDay[] {
  const today = localDay(at)
  const rate = pricing.rates
  const hourRate = perHour(hours.phase, pricing.size ?? "2x8", pricing.reading, rate) * (pricing.share ?? 1)
  const last = Date.parse(hours.at)
  const start = Number.isNaN(last) ? at.getTime() : Math.min(last, at.getTime())
  const days: MeteredDay[] = []
  for (let day = hours.day; day < today; day = nextDay(day)) {
    const from = Math.max(start, startOf(day))
    const end = new Date(startOf(day))
    end.setDate(end.getDate() + 1)
    const elapsed = Math.max(0, end.getTime() - from) / 1000
    const own = day === hours.day
    const seconds = addSeconds(own ? daySeconds(hours) : { existed: 0, running: 0, asleep: 0 }, hours.phase, elapsed)
    const base = own ? (hours.todayCost ?? 0) : 0
    days.push({
      day,
      seconds,
      amount: money(base + hourRate * (elapsed / 3600)),
      currency: own ? (hours.currency ?? rate.currency) : rate.currency,
      ratesSource: own ? (hours.ratesSource ?? rate.source) : rate.source,
    })
  }
  return days
}

/**
 * The counters as they read now: the record's last change plus the interval since, with no write. A closed work stops
 * at its close even when no closed event was recorded; a record with no counters reads zero. With `pricing`, the
 * interval since the last change is priced too, and a crossing of local midnight keeps the day that ended in `lastDay`.
 */
export function hoursAt(record: Pick<WorkRecord, "hours" | "state" | "closed">, now: Date, pricing?: Pricing): MeteredHours {
  if (!record.hours) return zeroHours(record.state === "closed" ? "closed" : "creating", now, pricing)
  const until = record.state === "closed" && record.closed && record.hours.phase !== "closed" ? new Date(record.closed.at) : now
  return countHours(record.hours, record.hours.phase, until, pricing)
}

/** The displayed hours: `existed` and `running`, in hours to two decimals. */
export const shownHours = (hours: MeteredHours) => ({ existed: asHours(hours.existedSeconds), running: asHours(hours.runningSeconds) })
