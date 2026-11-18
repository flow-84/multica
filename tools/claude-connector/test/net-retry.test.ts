import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NetError, withNetRetry } from '../src/net-retry.ts'
import { Outage } from '../src/trello/outage.ts'

const reset = () => new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } })

test('a GET without response is repeated and ends as NetError naming cause, attempts and host', async () => {
  let calls = 0
  await assert.rejects(
    withNetRetry('GET', async () => {
      calls++
      throw reset()
    }, [0, 0], 'api.trello.com'),
    (err: unknown) => {
      assert.ok(err instanceof NetError)
      assert.equal(err.reason, 'UND_ERR_SOCKET')
      assert.equal(err.message, 'fetch failed [UND_ERR_SOCKET, 3 Versuche, api.trello.com]')
      return true
    },
  )
  assert.equal(calls, 3)
})

test('a POST that may have reached the server is not repeated', async () => {
  let calls = 0
  await assert.rejects(
    withNetRetry('POST', async () => {
      calls++
      throw reset()
    }, [0, 0]),
    NetError,
  )
  assert.equal(calls, 1)
})

test('an HTTP-level error is passed through unchanged', async () => {
  const boom = new Error('boom')
  await assert.rejects(withNetRetry('GET', async () => { throw boom }, [0, 0]), (err) => err === boom)
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
