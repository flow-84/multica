import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { NetError, withNetRetry } from '../src/net-retry.ts'
import { Outage } from '../src/trello/outage.ts'

const failed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } })
const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')

function flaky(errors: unknown[]) {
  let calls = 0
  const run = async () => {
    calls++
    const e = errors.shift()
    if (e) throw e
    return 'ok'
  }
  return { run, calls: () => calls }
}

test('GET is repeated after a reset and a timeout (MS-3886)', async () => {
  const f = flaky([failed('ECONNRESET'), timeout()])
  assert.equal(await withNetRetry('GET', f.run, [0, 0]), 'ok')
  assert.equal(f.calls(), 3)
})

test('POST is not repeated after a timeout: the card may already exist', async () => {
  const f = flaky([timeout()])
  await assert.rejects(withNetRetry('POST', f.run, [0, 0]), /TimeoutError, 1 Versuch\]/)
  assert.equal(f.calls(), 1)
})

test('POST is repeated when the connection was refused', async () => {
  const f = flaky([failed('ECONNREFUSED')])
  assert.equal(await withNetRetry('POST', f.run, [0, 0]), 'ok')
  assert.equal(f.calls(), 2)
})

test('the final error names cause and attempts', async () => {
  const f = flaky([failed('ECONNRESET'), failed('ECONNRESET'), failed('ECONNRESET')])
  await assert.rejects(withNetRetry('PUT', f.run, [0, 0]), /fetch failed \[ECONNRESET, 3 Versuche\]/)
  assert.equal(f.calls(), 3)
})

test('HTTP-level errors are not retried', async () => {
  const f = flaky([new Error('GET /x: 500')])
  await assert.rejects(withNetRetry('GET', f.run, [0, 0]), /500/)
  assert.equal(f.calls(), 1)
})

test('the final error is a NetError naming the target host (MS-3997)', async () => {
  const f = flaky([failed('UND_ERR_SOCKET'), failed('UND_ERR_SOCKET'), failed('UND_ERR_SOCKET')])
  await assert.rejects(withNetRetry('GET', f.run, [0, 0], 'api.trello.com'), (err: unknown) => {
    assert.ok(err instanceof NetError)
    assert.equal(err.reason, 'UND_ERR_SOCKET')
    assert.equal(err.message, 'fetch failed [UND_ERR_SOCKET, 3 Versuche, api.trello.com]')
    return true
  })
})

test('a stretch without response is postponed first and an error after the limit', () => {
  const o = new Outage(30 * 60_000)
  const t0 = Date.parse('2026-11-18T17:01:00Z')
  assert.equal(o.recovered(t0), null)
  assert.deepEqual(o.failed(t0), { error: false, minutes: 0 })
  assert.deepEqual(o.failed(t0 + 5 * 60_000), { error: false, minutes: 5 })
  assert.deepEqual(o.failed(t0 + 30 * 60_000), { error: true, minutes: 30 })
  assert.equal(o.recovered(t0 + 31 * 60_000), 31)
  assert.equal(o.recovered(t0 + 32 * 60_000), null)
  assert.deepEqual(o.failed(t0 + 40 * 60_000), { error: false, minutes: 0 })
})
