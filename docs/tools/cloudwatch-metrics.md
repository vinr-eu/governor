# CloudWatch Metrics

## `aws_cloudwatch_list_metrics`

Discovers which CloudWatch metrics actually exist — namespace, metric name, and dimensions — so you know exactly what to
pass to `aws_cloudwatch_get_metric_data`. Also doubles as free resource inventory: e.g. namespace `"AWS/ECS"`

+ metricName `"CPUUtilization"` returns every `{ClusterName, ServiceName}` pair currently publishing it;
  `"AWS/RDS"` + `"FreeStorageSpace"` returns every `DBInstanceIdentifier`. Narrow with `namespace`/`metricName`/
  `dimensions` (all server-side, cheap) — omitting all of them lists every metric in the account, which can be large.

| Param        | Type   | Required | Description                                                                                       |
|--------------|--------|----------|---------------------------------------------------------------------------------------------------|
| `namespace`  | string | no       | e.g. `"AWS/RDS"`, `"AWS/ECS"`, `"AWS/Lambda"`.                                                    |
| `metricName` | string | no       | Exact metric name, e.g. `"CPUUtilization"`.                                                       |
| `dimensions` | object | no       | Exact dimension values to match, e.g. `{"ClusterName": "prod"}`. All given dimensions must match. |
| `maxResults` | number | no       | Max metrics. Default 200, max 1000.                                                               |
| `profile`    | string | no       | Profile name.                                                                                     |
| `region`     | string | no       | Region.                                                                                           |

**Example call:**

```json
{
  "namespace": "AWS/RDS",
  "metricName": "FreeStorageSpace"
}
```

**Example response:**

```json
{
  "metrics": [
    {
      "namespace": "AWS/RDS",
      "metricName": "FreeStorageSpace",
      "dimensions": {
        "DBInstanceIdentifier": "governor-db"
      }
    }
  ]
}
```

---

## `aws_cloudwatch_get_metric_data`

Fetches datapoints for one or more metrics in a single call — batch every metric/resource you need to check here (e.g.
`CPUUtilization` and `MemoryUtilization` for every ECS service in a cluster, or `FreeStorageSpace` for every RDS
instance) rather than calling this once per metric. Each result carries its `namespace`/`metricName`/
`dimensions` back so you can match it to the query that produced it. `startTime`/`endTime` default to the last hour
ending now. Use `aws_cloudwatch_list_metrics` first to find the exact dimensions a resource publishes under.

| Param           | Type   | Required | Description                                                                                                                                                                                        |
|-----------------|--------|----------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `queries`       | array  | yes      | 1–100 queries, each `{namespace, metricName, dimensions?, stat?}`. `stat` defaults to `"Average"` — also accepts `"Sum"`, `"Maximum"`, `"Minimum"`, `"SampleCount"`, or a percentile like `"p99"`. |
| `period`        | number | no       | Datapoint granularity in seconds. Default 300 — must be a period CloudWatch supports for the metric's resolution.                                                                                  |
| `startTime`     | string | no       | ISO 8601. Defaults to 1 hour before `endTime`.                                                                                                                                                     |
| `endTime`       | string | no       | ISO 8601. Defaults to now.                                                                                                                                                                         |
| `maxDatapoints` | number | no       | Max datapoints per metric. Default 200, max 1000.                                                                                                                                                  |
| `profile`       | string | no       | Profile name.                                                                                                                                                                                      |
| `region`        | string | no       | Region.                                                                                                                                                                                            |

**Example call:**

```json
{
  "queries": [
    {
      "namespace": "AWS/RDS",
      "metricName": "CPUUtilization",
      "dimensions": {
        "DBInstanceIdentifier": "governor-db"
      }
    },
    {
      "namespace": "AWS/RDS",
      "metricName": "FreeStorageSpace",
      "dimensions": {
        "DBInstanceIdentifier": "governor-db"
      },
      "stat": "Minimum"
    }
  ]
}
```

**Example response:**

```json
{
  "results": [
    {
      "namespace": "AWS/RDS",
      "metricName": "CPUUtilization",
      "dimensions": {
        "DBInstanceIdentifier": "governor-db"
      },
      "stat": "Average",
      "datapoints": [
        {
          "timestamp": "2026-08-17T09:00:00.000Z",
          "value": 4.2
        }
      ],
      "truncated": false
    }
  ]
}
```
