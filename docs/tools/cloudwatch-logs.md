# CloudWatch Logs

## `aws_logs_list_groups`

Lists CloudWatch Logs log groups visible to a profile in a region, with retention period and stored size. Narrow with
`prefix` (server-side, cheap). Use this to find a log group's exact name before searching it with
`aws_logs_search`.

| Param        | Type   | Required | Description                                                 |
| ------------ | ------ | -------- | ----------------------------------------------------------- |
| `prefix`     | string | no       | Only include log groups whose name starts with this prefix. |
| `maxResults` | number | no       | Max log groups. Default 200, max 1000.                      |
| `profile`    | string | no       | Profile name.                                               |
| `region`     | string | no       | Region.                                                     |

**Example response:**

```json
{
  "groups": [
    {
      "name": "/aws/lambda/my-function",
      "storedBytes": 1048576,
      "retentionInDays": 14,
      "creationTime": "2024-06-01T00:00:00.000Z"
    }
  ]
}
```

---

## `aws_logs_search`

Searches one log group for events across every log stream in the group, ordered by time — the read path for debugging
and incident response. Two modes via `order`:

- **`"asc"` (default)** — forward `FilterLogEvents` scan matching `filterPattern` within `startTime`/`endTime`.
  `startTime` defaults to 1 hour before `endTime` (`endTime` defaults to now), so an omitted range never scans a group's
  full retention window.
- **`"desc"`** — tail mode: the most recent events regardless of how old they turn out to be, resolved directly from the
  group's most-recently-active streams rather than scanning forward to find them, so it stays cheap even when the last
  write was long ago. Doesn't support `filterPattern` (CloudWatch has no server-side filter on that read path) and only
  considers a bounded number of the most recently active streams.

| Param                 | Type   | Required | Description                                                                                                                    |
| --------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `logGroupName`        | string | yes      | Exact log group name, e.g. `"/aws/lambda/my-function"`. Use `aws_logs_list_groups` to find it.                                 |
| `order`               | enum   | no       | `"asc"` (default) or `"desc"` — see above.                                                                                     |
| `filterPattern`       | string | no       | CloudWatch Logs filter pattern, e.g. `"ERROR"` or `"?ERROR ?WARN"`. Omit to match every event. Only valid with `order: "asc"`. |
| `logStreamNamePrefix` | string | no       | Only search streams whose name starts with this prefix.                                                                        |
| `startTime`           | string | no       | ISO 8601. In `"asc"`, defaults to 1 hour before `endTime`; in `"desc"`, an optional lower bound (no default).                  |
| `endTime`             | string | no       | ISO 8601. In `"asc"`, defaults to now; in `"desc"`, an optional upper bound (omit to tail to the latest event).                |
| `maxResults`          | number | no       | Max events. Default 200, max 1000.                                                                                             |
| `profile`             | string | no       | Profile name.                                                                                                                  |
| `region`              | string | no       | Region.                                                                                                                        |

**Example call (forward search):**

```json
{
  "logGroupName": "/aws/lambda/my-function",
  "filterPattern": "ERROR",
  "startTime": "2026-08-17T09:00:00Z",
  "endTime": "2026-08-17T10:00:00Z"
}
```

**Example call (tail mode):**

```json
{
  "logGroupName": "/aws/lambda/my-function",
  "order": "desc",
  "maxResults": 50
}
```

**Example response:**

```json
{
  "events": [
    {
      "timestamp": "2026-08-17T09:41:02.113Z",
      "message": "ERROR: connection refused to db-primary",
      "logStreamName": "2026/08/17/[$LATEST]abcd1234"
    }
  ],
  "truncated": false
}
```
