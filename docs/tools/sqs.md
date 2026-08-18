# SQS

## `aws_sqs_list_queues_by_backlog`

Ranks every SQS queue visible to a profile by how clogged it is — worst first — using the sum of messages waiting, in
flight, and delayed. Marks `isDlq` on any queue that another scanned queue's `RedrivePolicy` names as its dead-letter
target, so a DLQ quietly filling up (nothing consumes those) stands out from a busy but healthy working queue.

Ranking requires fetching every queue's attributes up front, so this scans up to `maxScan` queues (default and max 1000,
the per-region SQS quota) before sorting. Narrow with `prefix` to scan a smaller, known-relevant set instead.
`offset`/`limit` then paginate the already-ranked list.

| Param     | Type   | Required | Description                                                      |
| --------- | ------ | -------- | ---------------------------------------------------------------- |
| `prefix`  | string | no       | Only include queues whose name starts with this prefix.          |
| `offset`  | number | no       | Ranked queues to skip. Default 0.                                |
| `limit`   | number | no       | Max ranked queues to return. Default 50, max 200.                |
| `maxScan` | number | no       | Max queues to scan/rank before paginating. Default and max 1000. |
| `profile` | string | no       | Profile name.                                                    |
| `region`  | string | no       | Region.                                                          |

**Example response:**

```json
{
  "queues": [
    {
      "queueUrl": "https://sqs.eu-central-1.amazonaws.com/248315219317/orders-dlq",
      "queueName": "orders-dlq",
      "approximateNumberOfMessages": 412,
      "approximateNumberOfMessagesNotVisible": 0,
      "approximateNumberOfMessagesDelayed": 0,
      "backlog": 412,
      "isDlq": true,
      "createdTimestamp": "2024-01-10T00:00:00.000Z",
      "lastModifiedTimestamp": "2026-08-01T00:00:00.000Z"
    }
  ],
  "offset": 0,
  "totalMatching": 1,
  "truncated": false,
  "scanIncomplete": false
}
```

`scanIncomplete: true` means the account has more queues than `maxScan` covered — the ranking may be missing some;
narrow with `prefix` or raise `maxScan`. `truncated: true` just means more _already-ranked_ queues exist past this
page — paginate with `offset`.

---

## `aws_sqs_peek_messages`

Peeks at messages sitting in a queue — including their bodies — without deleting them. SQS has no read-only "list
messages" API, so this briefly makes each returned message invisible to real consumers for
`visibilityTimeoutSeconds` (default 5s, capped at 60s, kept short so it doesn't meaningfully interfere with production
processing); governor never deletes what it peeks, so messages simply become visible again once that timeout elapses.

SQS has no stable "page 2" cursor — this returns an approximately-random sample of what's currently visible, and
standard (non-FIFO) queues don't guarantee delivery order. Calling this again after the visibility timeout elapses tends
to surface a different set of messages, which is the closest approximation of pagination SQS supports.

| Param                      | Type   | Required | Description                                                                    |
| -------------------------- | ------ | -------- | ------------------------------------------------------------------------------ |
| `queueUrl`                 | string | yes      | Full queue URL, as returned by `aws_sqs_list_queues_by_backlog`.               |
| `maxMessages`              | number | no       | Max messages. Default 10, max 100.                                             |
| `visibilityTimeoutSeconds` | number | no       | How long each peeked message is hidden from real consumers. Default 5, max 60. |
| `profile`                  | string | no       | Profile name.                                                                  |
| `region`                   | string | no       | Region.                                                                        |

**Example call:**

```json
{
  "queueUrl": "https://sqs.eu-central-1.amazonaws.com/248315219317/orders-dlq",
  "maxMessages": 5
}
```

**Example response:**

```json
{
  "messages": [
    {
      "messageId": "b1e6...",
      "body": "{\"orderId\":\"ord_9f21\",\"error\":\"payment_declined\"}",
      "approximateReceiveCount": 3,
      "sentTimestamp": "2026-08-17T08:00:00.000Z",
      "attributes": {},
      "messageAttributes": {}
    }
  ],
  "truncated": false
}
```
