// The ledger's machine-hours (design §C.4): every phase change adds the elapsed interval to the phase that was current,
// so creating, busy, idle and unreachable count as running, asleep counts as existing only, and gone or closed add
// neither. A restart, or a change missed while OpenCode was closed, counts from the record's last change and never twice.
import { afterEach, describe, expect, test } from "bun:test"
import { PUBLIC_RATES, money, perHour } from "../../src/cost/rates.js"
import { ledgerPort } from "../../src/ledger/index.js"
import { asHours, countHours, hoursAt, localDay, shownHours } from "../../src/ledger/hours.js"
import { Ledger } from "../../src/ledger/store.js"
import type { Phase, WorkRecord } from "../../src/ledger/types.js"
import type { MachineId } from "../../src/ports.js"
import { removeRoot, tempRoot } from "../support/ledger-fakes.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) removeRoot(root)
})

const record = (workId: string, over: Partial<WorkRecord> = {}): WorkRecord => ({
  format: 1,
  workId,
  state: "open",
  region: "fra",
  machine: `oc-${workId}`,
  machineId: `vm_${workId}` as MachineId,
  size: "2x8",
  image: { name: "oc-golden-2.4.1-2x8", opencode: "2.4.1" },
  laptopDirectory: "/work/projects/api",
  guestDirectory: `/home/boxd/work/${workId}`,
  createdAt: "2026-11-16T09:00:00.000Z",
  ...over,
})

const minutes = (count: number) => count * 60_000

describe("the ledger's machine-hours", () => {
  test("creating, busy, idle, asleep and gone: existed and running, across a restart and a change missed while closed", async () => {
    const root = tempRoot("boxd-hours-")
    roots.push(root)
    const clock = { now: new Date(2026, 10, 16, 9, 0, 0) }
    const ledger = new Ledger(root, { now: () => clock.now })
    const port = ledgerPort(ledger)
    await ledger.mutate("metered", () => record("metered", { createdAt: clock.now.toISOString() }))
    const context = { call: { callId: "hours", source: "watcher" as const } }
    const change = async (from: Phase | null, to: Phase) => {
      await port.appendEvent({ at: clock.now.toISOString(), workId: "metered", from, to }, context)
    }

    await change(null, "creating")
    clock.now = new Date(clock.now.getTime() + minutes(10))
    await change("creating", "busy")
    clock.now = new Date(clock.now.getTime() + minutes(20))
    await change("busy", "idle")
    expect((await ledger.get("metered"))?.hours).toMatchObject({ existedSeconds: 30 * 60, runningSeconds: 30 * 60, phase: "idle" })

    // The plugin restarts between two phase changes; the new ledger counts from what the record keeps, not from zero.
    const restarted = new Ledger(root, { now: () => clock.now })
    const after = ledgerPort(restarted)
    clock.now = new Date(clock.now.getTime() + minutes(15))
    await after.appendEvent({ at: clock.now.toISOString(), workId: "metered", from: "idle", to: "asleep" }, context)
    expect((await restarted.get("metered"))?.hours).toMatchObject({ existedSeconds: 45 * 60, runningSeconds: 45 * 60, phase: "asleep" })

    // A phase change OpenCode missed while it was closed: the gap counts from the record's last change, once.
    clock.now = new Date(clock.now.getTime() + minutes(30))
    await after.appendEvent({ at: clock.now.toISOString(), workId: "metered", from: "asleep", to: "gone" }, context)
    expect((await restarted.get("metered"))?.hours).toMatchObject({ existedSeconds: 75 * 60, runningSeconds: 45 * 60, phase: "gone" })

    // Gone adds nothing until the work comes back; creating and busy do.
    clock.now = new Date(clock.now.getTime() + minutes(60))
    await after.appendEvent({ at: clock.now.toISOString(), workId: "metered", from: "gone", to: "creating" }, context)
    clock.now = new Date(clock.now.getTime() + minutes(5))
    await after.appendEvent({ at: clock.now.toISOString(), workId: "metered", from: "creating", to: "busy" }, context)
    const hours = (await restarted.get("metered"))!.hours!
    expect(hours).toMatchObject({ existedSeconds: 80 * 60, runningSeconds: 50 * 60, phase: "busy", at: clock.now.toISOString() })
    expect(shownHours(hours)).toEqual({ existed: asHours(80 * 60), running: asHours(50 * 60) })
    // Reading it now adds no second to the record.
    expect(hoursAt((await restarted.get("metered"))!, clock.now)).toMatchObject({ existedSeconds: 80 * 60, runningSeconds: 50 * 60 })
  })

  test("today's counters keep only the part after local midnight, while the cumulative counters keep the whole interval", async () => {
    const root = tempRoot("boxd-hours-day-")
    roots.push(root)
    const clock = { now: new Date(2026, 10, 16, 23, 30, 0) }
    const ledger = new Ledger(root, { now: () => clock.now })
    const port = ledgerPort(ledger)
    await ledger.mutate("day", () => record("day", { createdAt: clock.now.toISOString() }))
    const context = { call: { callId: "hours", source: "watcher" as const } }
    const change = async (from: Phase | null, to: Phase) => {
      await port.appendEvent({ at: clock.now.toISOString(), workId: "day", from, to }, context)
    }

    await change(null, "creating")
    clock.now = new Date(clock.now.getTime() + minutes(20))
    await change("creating", "idle")
    expect((await ledger.get("day"))!.hours).toMatchObject({ existedSeconds: 20 * 60, runningSeconds: 20 * 60, todayExistedSeconds: 20 * 60, todayRunningSeconds: 20 * 60 })

    // 23:50 to 00:10: the cumulative counters take 20 minutes, today's only the 10 after midnight.
    clock.now = new Date(clock.now.getTime() + minutes(20))
    await change("idle", "asleep")
    expect((await ledger.get("day"))!.hours).toMatchObject({
      existedSeconds: 40 * 60,
      runningSeconds: 40 * 60,
      todayExistedSeconds: 10 * 60,
      todayRunningSeconds: 10 * 60,
      day: localDay(clock.now),
    })

    clock.now = new Date(clock.now.getTime() + minutes(30))
    await change("asleep", "gone")
    const hours = (await ledger.get("day"))!.hours!
    expect(hours).toMatchObject({ existedSeconds: 70 * 60, runningSeconds: 40 * 60, todayExistedSeconds: 40 * 60, todayRunningSeconds: 10 * 60 })
  })

  test("prices each interval at its rates: asleep is its own counter, midnight splits the day, and a currency change starts again", () => {
    const rates = PUBLIC_RATES.EUR
    const size = "2x8" as const
    const reading = { residentGiB: 2, load1: 1 }
    const busy = perHour("busy", size, reading, rates)
    const asleep = perHour("asleep", size, reading, rates)
    const start = new Date(2026, 10, 16, 23, 30, 0)
    const pricing = { rates, size, reading }

    let hours = countHours(undefined, "creating", start, pricing)
    expect(hours).toMatchObject({ cost: 0, todayCost: 0, asleepSeconds: 0 })
    hours = countHours(hours, "busy", new Date(2026, 10, 16, 23, 50, 0), pricing)
    hours = countHours(hours, "idle", new Date(2026, 10, 17, 0, 10, 0), pricing)
    expect(hours).toMatchObject({
      existedSeconds: 40 * 60,
      runningSeconds: 40 * 60,
      asleepSeconds: 0,
      todayExistedSeconds: 10 * 60,
      todayRunningSeconds: 10 * 60,
      todayAsleepSeconds: 0,
      day: localDay(new Date(2026, 10, 17, 0, 10, 0)),
      phase: "idle",
    })
    // The day that ended keeps 23:30 to midnight: twenty minutes creating and ten busy.
    expect(hours.lastDay).toMatchObject({
      day: localDay(new Date(2026, 10, 16, 23, 30, 0)),
      seconds: { existed: 30 * 60, running: 30 * 60, asleep: 0 },
      currency: "EUR",
      ratesSource: "public",
    })
    expect(hours.lastDay?.amount).toBeCloseTo(money(busy * 0.5), 3)
    expect(hours.cost).toBeCloseTo((busy * 40) / 60, 3)
    expect(hours.todayCost).toBeCloseTo((busy * 10) / 60, 3)

    hours = countHours(hours, "asleep", new Date(2026, 10, 17, 0, 40, 0), pricing)
    hours = countHours(hours, "gone", new Date(2026, 10, 17, 1, 10, 0), pricing)
    expect(hours).toMatchObject({
      existedSeconds: 100 * 60,
      runningSeconds: 70 * 60,
      asleepSeconds: 30 * 60,
      todayExistedSeconds: 70 * 60,
      todayRunningSeconds: 40 * 60,
      todayAsleepSeconds: 30 * 60,
    })
    expect(hours.cost).toBeCloseTo((busy * 70) / 60 + (asleep * 30) / 60, 3)
    expect(hours.todayCost).toBeCloseTo((busy * 40) / 60 + (asleep * 30) / 60, 3)
    expect(hours.lastDay?.day).toBe(localDay(new Date(2026, 10, 16, 23, 30, 0)))

    // A different currency starts the money counters again, today's included, rather than adding two currencies.
    hours = countHours(hours, "idle", new Date(2026, 10, 17, 1, 20, 0), pricing)
    const usd = { ...PUBLIC_RATES.USD, source: "usage" as const }
    const after = countHours(hours, "busy", new Date(2026, 10, 17, 1, 40, 0), { rates: usd, size, reading })
    const idle = perHour("idle", size, reading, usd)
    expect(after).toMatchObject({
      cost: money((idle * 20) / 60),
      todayCost: money((idle * 20) / 60),
      currency: "USD",
      ratesSource: "usage",
    })
  })
})
